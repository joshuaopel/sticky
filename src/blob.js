import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createGooMaterial } from './goo-material.js';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _r = new THREE.Vector3();
const _spin = new THREE.Vector3();

const GRAVITY = -26;

/**
 * A pressurised soft body: a subdivided icosahedron whose vertices are Verlet
 * particles. Edge constraints keep the skin together, an internal gas pressure
 * keeps it from crumpling, and per-particle contacts against the level give it
 * squash, friction and (when clinging) adhesion.
 *
 * The rendered mesh *is* the simulation — vertices are particles, so every
 * dent you see is a real contact.
 */
export class GooBlob {
  constructor(world, options = {}) {
    const {
      radius = 1.15,
      detail = 3,
      position = new THREE.Vector3(0, 4, 16),
      material = null,
    } = options;
    this.materialOptions = material;

    this.world = world;
    this.radius = radius;
    this.particleRadius = radius * 0.17;

    // --- geometry -> particles -------------------------------------------
    // Drop uv/normal before welding: three's icosphere splits seam vertices by
    // uv, and an unwelded seam would let the skin tear open along it.
    const source = new THREE.IcosahedronGeometry(radius, detail);
    source.deleteAttribute('uv');
    source.deleteAttribute('normal');
    const geometry = mergeVertices(source);
    geometry.computeVertexNormals();
    this.geometry = geometry;

    const src = geometry.attributes.position.array;
    this.count = geometry.attributes.position.count;
    this.rest = new Float32Array(src);
    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.acc = new Float32Array(this.count * 3);

    // --- constraints ------------------------------------------------------
    const index = geometry.index.array;
    this.faces = index;
    const adjacency = Array.from({ length: this.count }, () => new Set());
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i], b = index[i + 1], c = index[i + 2];
      adjacency[a].add(b); adjacency[b].add(a);
      adjacency[b].add(c); adjacency[c].add(b);
      adjacency[c].add(a); adjacency[a].add(c);
    }
    this.neighbors = adjacency.map((s) => Array.from(s));

    const edgeKeys = new Set();
    const edgeA = [];
    const edgeB = [];
    const edgeRest = [];
    const addEdge = (a, b) => {
      const key = a < b ? a * this.count + b : b * this.count + a;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      const dx = src[a * 3] - src[b * 3];
      const dy = src[a * 3 + 1] - src[b * 3 + 1];
      const dz = src[a * 3 + 2] - src[b * 3 + 2];
      edgeA.push(a); edgeB.push(b);
      edgeRest.push(Math.hypot(dx, dy, dz));
    };
    // Structural edges, then a second ring for bend resistance so the shell
    // does not fold flat when it lands.
    for (let a = 0; a < this.count; a++) for (const b of this.neighbors[a]) addEdge(a, b);
    for (let a = 0; a < this.count; a++) {
      for (const b of this.neighbors[a]) for (const c of adjacency[b]) if (c !== a) addEdge(a, c);
    }
    this.edgeA = new Uint16Array(edgeA);
    this.edgeB = new Uint16Array(edgeB);
    this.edgeRest = new Float32Array(edgeRest);

    this.restVolume = Math.abs(this._volumeOf(this.rest));

    // --- tuning -----------------------------------------------------------
    this.edgeStiffness = 0.28;
    this.bendStiffness = 0.05;
    this.pressure = 7000;
    this.damping = 0.994;
    this.moveAccel = 62;
    this.airControl = 0.22;
    this.jumpSpeed = 12.5;
    this.maxSpeed = 17;
    this.rollAssist = 5.5;
    this.maxPull = 0.22;
    this.substeps = 2;
    this.iterations = 5;

    // Structural edges were added first, so anything past this index is a bend edge.
    this.structuralCount = 0;
    for (let a = 0; a < this.count; a++) this.structuralCount += this.neighbors[a].length;
    this.structuralCount /= 2;

    // --- goo budget -------------------------------------------------------
    // Mass is a resource: 1.0 is a full blob, strands cost some of it, puddles
    // give it back, and the body's size is the cube root of whatever is left.
    this.baseRadius = radius;
    this.baseParticleRadius = this.particleRadius;
    this.baseEdgeRest = new Float32Array(this.edgeRest);
    this.baseRestVolume = this.restVolume;
    this.scale = 1;
    this.goo = 1;
    this.minGoo = 0.3;
    this.maxGoo = 1.6;
    this.shotCost = 0.055;
    this.impactLoss = 0.014;

    // --- state ------------------------------------------------------------
    this.center = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.contactNormal = new THREE.Vector3(0, 1, 0);
    this.contacts = 0;
    this.grounded = false;
    this.clinging = false;
    this.squash = 1;
    this.throttle = 0;
    this.wobble = 0;
    this.time = 0;
    this.onSplat = null;

    this.reset(position);
    this.mesh = this._buildMesh();
  }

  _buildMesh() {
    const material = createGooMaterial(this.materialOptions || {});
    this.uniforms = material.userData.uniforms;
    this.transmission = material.transmission;
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    // A darker nucleus, seen through the translucent skin — it gives the
    // refraction something to bend and makes the body read as deep.
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(this.baseRadius * 0.5, 2),
      new THREE.MeshStandardMaterial({
        color: 0x4d8f08,
        roughness: 0.4,
        emissive: new THREE.Color(0x1b3504),
        emissiveIntensity: 1,
      })
    );
    core.frustumCulled = false;
    this.core = core;
    mesh.add(core);
    return mesh;
  }

  /**
   * Fade out when the camera is jammed inside us — third-person games do this
   * so a wall-pinned camera shows the room instead of the inside of a face.
   */
  setViewFade(alpha) {
    const material = this.mesh.material;
    if (Math.abs(material.opacity - alpha) < 0.002) return;
    material.opacity = alpha;
    // A transmissive material renders through the transmission pass, where
    // opacity does not blend — so drop transmission while fading. Switching it
    // changes the shader, hence needsUpdate, so only do it on the crossing.
    const transmission = alpha > 0.98 ? this.transmission : 0;
    if (material.transmission !== transmission) {
      material.transmission = transmission;
      material.needsUpdate = true;
    }
    this.mesh.visible = alpha > 0.02;
    if (this.core) this.core.visible = alpha > 0.5;
  }

  reset(position = this.world.spawn) {
    this.goo = 1;
    this.scale = 1;
    this.radius = this.baseRadius ?? this.radius;
    this.particleRadius = this.baseParticleRadius ?? this.particleRadius;
    if (this.baseEdgeRest) {
      this.edgeRest.set(this.baseEdgeRest);
      this.restVolume = this.baseRestVolume;
    }
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.pos[i3] = this.rest[i3] + position.x;
      this.pos[i3 + 1] = this.rest[i3 + 1] + position.y;
      this.pos[i3 + 2] = this.rest[i3 + 2] + position.z;
      this.prev[i3] = this.pos[i3];
      this.prev[i3 + 1] = this.pos[i3 + 1];
      this.prev[i3 + 2] = this.pos[i3 + 2];
    }
    this.center.copy(position);
    this.velocity.set(0, 0, 0);
  }

  /** 0 at the point of collapse, 1 when full. */
  get fill() {
    return THREE.MathUtils.clamp((this.goo - this.minGoo) / (1 - this.minGoo), 0, 1);
  }

  canSpend(amount) {
    return this.goo - amount >= this.minGoo - 1e-6;
  }

  /** Spend goo; returns false (and spends nothing) when there is not enough. */
  spendGoo(amount) {
    if (!this.canSpend(amount)) return false;
    this.goo -= amount;
    return true;
  }

  addGoo(amount) {
    this.goo = Math.min(this.maxGoo, this.goo + amount);
  }

  /**
   * Resize the body about its centre. Rest lengths, rest volume and the
   * contact radius all scale with it, so a small blob is a small *simulation*,
   * not a shrunken render of a big one.
   */
  _applyScale(target) {
    const ratio = target / this.scale;
    if (Math.abs(ratio - 1) < 1e-6) return;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.pos[i3] = this.center.x + (this.pos[i3] - this.center.x) * ratio;
      this.pos[i3 + 1] = this.center.y + (this.pos[i3 + 1] - this.center.y) * ratio;
      this.pos[i3 + 2] = this.center.z + (this.pos[i3 + 2] - this.center.z) * ratio;
      this.prev[i3] = this.center.x + (this.prev[i3] - this.center.x) * ratio;
      this.prev[i3 + 1] = this.center.y + (this.prev[i3 + 1] - this.center.y) * ratio;
      this.prev[i3 + 2] = this.center.z + (this.prev[i3 + 2] - this.center.z) * ratio;
    }

    this.scale = target;
    this.radius = this.baseRadius * target;
    this.particleRadius = this.baseParticleRadius * target;
    this.restVolume = this.baseRestVolume * target * target * target;
    for (let e = 0; e < this.edgeRest.length; e++) this.edgeRest[e] = this.baseEdgeRest[e] * target;
  }

  particle(i, out = _p) {
    const i3 = i * 3;
    return out.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
  }

  /** Index of the surface particle furthest along `dir` (used to hang strands). */
  nearestParticle(dir) {
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const dx = this.pos[i3] - this.center.x;
      const dy = this.pos[i3 + 1] - this.center.y;
      const dz = this.pos[i3 + 2] - this.center.z;
      const d = dx * dir.x + dy * dir.y + dz * dir.z;
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  }

  /**
   * Drag a particle (and, softly, its neighbours) — how strands pull the body.
   * The displacement is clamped and spread so a hard yank stretches the goo
   * instead of tearing a spike out of the skin, and half of it is mirrored
   * into `prev` so the pull adds motion without injecting a velocity spike.
   */
  pullParticle(i, dx, dy, dz, share = 1) {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-8) return;
    const limit = Math.min(len, this.maxPull) / len;
    const s = share * limit;
    const nb = this.neighbors[i];
    const spread = s * 0.55;

    const apply = (index, amount) => {
      const j3 = index * 3;
      const ox = dx * amount, oy = dy * amount, oz = dz * amount;
      this.pos[j3] += ox;
      this.pos[j3 + 1] += oy;
      this.pos[j3 + 2] += oz;
      this.prev[j3] += ox * 0.5;
      this.prev[j3 + 1] += oy * 0.5;
      this.prev[j3 + 2] += oz * 0.5;
    };

    apply(i, s);
    for (let k = 0; k < nb.length; k++) {
      apply(nb[k], spread);
      const ring = this.neighbors[nb[k]];
      for (let m = 0; m < ring.length; m++) if (ring[m] !== i) apply(ring[m], spread * 0.3);
    }
  }

  /**
   * Hard rope limit: keep the whole body inside a sphere of `maxDist` around
   * `anchor`. The correction moves pos and prev together (so it injects no
   * energy) and then cancels only the outward radial velocity — which is
   * exactly what makes a strand swing like a rope instead of a rubber band.
   * Returns how far the body had to be pulled back.
   */
  constrainToAnchor(anchor, maxDist, stiffness = 1) {
    _v.subVectors(this.center, anchor);
    const dist = _v.length();
    if (dist <= maxDist || dist < 1e-6) return 0;
    _v.divideScalar(dist);
    const pull = (dist - maxDist) * stiffness;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const ox = _v.x * pull, oy = _v.y * pull, oz = _v.z * pull;
      this.pos[i3] -= ox; this.prev[i3] -= ox;
      this.pos[i3 + 1] -= oy; this.prev[i3 + 1] -= oy;
      this.pos[i3 + 2] -= oz; this.prev[i3 + 2] -= oz;

      const vx = this.pos[i3] - this.prev[i3];
      const vy = this.pos[i3 + 1] - this.prev[i3 + 1];
      const vz = this.pos[i3 + 2] - this.prev[i3 + 2];
      const radial = vx * _v.x + vy * _v.y + vz * _v.z;
      if (radial > 0) {
        this.prev[i3] += _v.x * radial;
        this.prev[i3 + 1] += _v.y * radial;
        this.prev[i3 + 2] += _v.z * radial;
      }
    }
    this.center.addScaledVector(_v, -pull);
    return pull;
  }

  /** Push the whole body along `dir` (metres/second). */
  applyImpulse(dir, speed) {
    const step = this._lastStep || 1 / 120;
    this.addVelocity(dir.x * speed * step, dir.y * speed * step, dir.z * speed * step);
  }

  addVelocity(vx, vy, vz) {
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.prev[i3] -= vx;
      this.prev[i3 + 1] -= vy;
      this.prev[i3 + 2] -= vz;
    }
  }

  _volumeOf(array) {
    // Signed volume via the divergence theorem, measured about the centroid
    // so the sum stays numerically well behaved.
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.count; i++) {
      cx += array[i * 3]; cy += array[i * 3 + 1]; cz += array[i * 3 + 2];
    }
    cx /= this.count; cy /= this.count; cz /= this.count;

    const idx = this.faces;
    let volume = 0;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
      const ax = array[a] - cx, ay = array[a + 1] - cy, az = array[a + 2] - cz;
      const bx = array[b] - cx, by = array[b + 1] - cy, bz = array[b + 2] - cz;
      const cx2 = array[c] - cx, cy2 = array[c + 1] - cy, cz2 = array[c + 2] - cz;
      volume += ax * (by * cz2 - bz * cy2) + ay * (bz * cx2 - bx * cz2) + az * (bx * cy2 - by * cx2);
    }
    return volume / 6;
  }

  _applyPressure() {
    const volume = Math.max(Math.abs(this._volumeOf(this.pos)), 1e-4);
    // Gas law-ish: the tighter it is squeezed, the harder it pushes back.
    const p = this.pressure * (this.restVolume / volume - 1);
    const strength = THREE.MathUtils.clamp(p, -1500, 6000);
    const idx = this.faces;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
      const abx = this.pos[b] - this.pos[a];
      const aby = this.pos[b + 1] - this.pos[a + 1];
      const abz = this.pos[b + 2] - this.pos[a + 2];
      const acx = this.pos[c] - this.pos[a];
      const acy = this.pos[c + 1] - this.pos[a + 1];
      const acz = this.pos[c + 2] - this.pos[a + 2];
      // Cross product length is twice the face area, so this scales with area.
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const s = strength / 6;
      this.acc[a] += nx * s; this.acc[a + 1] += ny * s; this.acc[a + 2] += nz * s;
      this.acc[b] += nx * s; this.acc[b + 1] += ny * s; this.acc[b + 2] += nz * s;
      this.acc[c] += nx * s; this.acc[c + 1] += ny * s; this.acc[c + 2] += nz * s;
    }
  }

  _solveEdges() {
    const { pos, edgeA, edgeB, edgeRest } = this;
    for (let e = 0; e < edgeA.length; e++) {
      const a = edgeA[e] * 3;
      const b = edgeB[e] * 3;
      const dx = pos[b] - pos[a];
      const dy = pos[b + 1] - pos[a + 1];
      const dz = pos[b + 2] - pos[a + 2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-6) continue;
      const stiffness = e < this.structuralCount ? this.edgeStiffness : this.bendStiffness;
      const diff = ((dist - edgeRest[e]) / dist) * 0.5 * stiffness;
      const ox = dx * diff, oy = dy * diff, oz = dz * diff;
      pos[a] += ox; pos[a + 1] += oy; pos[a + 2] += oz;
      pos[b] -= ox; pos[b + 1] -= oy; pos[b + 2] -= oz;
    }
  }

  _collide(dt) {
    this.contacts = 0;
    this.contactNormal.set(0, 0, 0);
    const clingBoost = this.clinging ? 1 : 0;
    const range = this.particleRadius * (this.clinging ? 2.6 : 1);

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      _p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      const hit = this.world.collide(_p, range);
      if (!hit) continue;

      _n.set(hit.nx, hit.ny, hit.nz);
      const penetration = hit.depth - (range - this.particleRadius);

      _v.set(this.pos[i3] - this.prev[i3], this.pos[i3 + 1] - this.prev[i3 + 1], this.pos[i3 + 2] - this.prev[i3 + 2]);

      if (penetration > 0) {
        this.pos[i3] += _n.x * penetration;
        this.pos[i3 + 1] += _n.y * penetration;
        this.pos[i3 + 2] += _n.z * penetration;

        const vn = _v.dot(_n);
        _t.copy(_v).addScaledVector(_n, -vn);          // tangential slide
        const friction = Math.min(0.985, hit.friction + clingBoost * 0.6);
        _t.multiplyScalar(1 - friction);
        // Static friction: goo that is barely creeping simply stops. This is
        // what lets the blob hang off a wall instead of oozing down it.
        const grip = clingBoost ? 0.05 : 0.006;
        if (_t.lengthSq() < grip * grip) _t.set(0, 0, 0);
        const bounce = vn < 0 ? -vn * 0.06 : vn;        // goo barely bounces
        _v.copy(_t).addScaledVector(_n, bounce);

        // A hard landing throws goo off: report the impact so the world can
        // take a puddle out of us.
        if (vn < -0.09) {
          const strength = Math.min(1, (-vn - 0.09) * 6);
          this.wobble = Math.max(this.wobble, strength);
          if (this.onSplat) this.onSplat(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2], _n, strength);
        }

        this.prev[i3] = this.pos[i3] - _v.x;
        this.prev[i3 + 1] = this.pos[i3 + 1] - _v.y;
        this.prev[i3 + 2] = this.pos[i3 + 2] - _v.z;
      } else if (clingBoost) {
        // Adhesion: near a surface while clinging, goo reaches for it.
        const pull = 60 * dt * dt;
        this.pos[i3] -= _n.x * pull;
        this.pos[i3 + 1] -= _n.y * pull;
        this.pos[i3 + 2] -= _n.z * pull;
      }

      this.contacts++;
      this.contactNormal.add(_n);
    }

    if (this.contacts > 0) this.contactNormal.normalize();
    else this.contactNormal.set(0, 1, 0);
    this.grounded = this.contacts > 0;
  }

  /**
   * @param {number} dt      fixed timestep
   * @param {object} input   { move: Vector3 (world, unit-ish), jump, cling }
   */
  update(dt, input) {
    this.clinging = !!input.cling;
    const sub = dt / this.substeps;
    this._lastStep = sub;

    for (let s = 0; s < this.substeps; s++) {
      this.acc.fill(0);

      // Gravity — heavily reduced while clinging so goo can hang and climb.
      const gravity = this.clinging && this.contacts > 3 ? GRAVITY * 0.08 : GRAVITY;
      for (let i = 0; i < this.count; i++) this.acc[i * 3 + 1] += gravity;

      this._applyPressure();

      // Locomotion. On a surface the move direction is projected onto the
      // contact plane, which is what lets you drive up walls while clinging.
      let climbing = false;
      this.throttle = 0;
      if (input.move && input.move.lengthSq() > 1e-6) {
        // How hard the stick is pushed. Keyboard input arrives at full length.
        const throttle = Math.min(1, input.move.length());
        this.throttle = throttle;
        _v.copy(input.move);
        if (this.contacts > 0) {
          const into = _v.dot(this.contactNormal);
          _v.addScaledVector(this.contactNormal, -into);
          if (_v.lengthSq() < 0.04) {
            // Pressed straight into a wall. While clinging that means climb
            // it; otherwise there is nowhere to go.
            _t.set(0, 1, 0).addScaledVector(this.contactNormal, -this.contactNormal.y);
            if (this.clinging && _t.lengthSq() > 1e-4) {
              _v.copy(_t).multiplyScalar(-Math.sign(into) || 1);
              climbing = true;
            } else {
              _v.set(0, 0, 0);
            }
          }
        }
        _v.normalize();
        const accel = this.moveAccel * throttle * (this.contacts > 0 ? 1 : this.airControl) * (climbing ? 0.2 : 1);
        _spin.copy(this.contactNormal).cross(_v).multiplyScalar(climbing ? 0 : this.rollAssist * throttle);

        for (let i = 0; _v.lengthSq() > 1e-8 && i < this.count; i++) {
          const i3 = i * 3;
          this.acc[i3] += _v.x * accel;
          this.acc[i3 + 1] += _v.y * accel;
          this.acc[i3 + 2] += _v.z * accel;
          if (this.contacts > 0) {
            // Torque about the contact plane: the blob tumbles instead of sliding.
            _r.set(this.pos[i3] - this.center.x, this.pos[i3 + 1] - this.center.y, this.pos[i3 + 2] - this.center.z);
            _t.copy(_spin).cross(_r);
            this.acc[i3] += _t.x; this.acc[i3 + 1] += _t.y; this.acc[i3 + 2] += _t.z;
          }
        }
      }

      // Verlet integration.
      const dt2 = sub * sub;
      for (let i = 0; i < this.count; i++) {
        const i3 = i * 3;
        for (let k = 0; k < 3; k++) {
          const j = i3 + k;
          const x = this.pos[j];
          let v = (x - this.prev[j]) * this.damping;
          if (v > 0.5) v = 0.5; else if (v < -0.5) v = -0.5; // hard clamp keeps it stable
          this.prev[j] = x;
          this.pos[j] = x + v + this.acc[j] * dt2;
        }
      }

      for (let it = 0; it < this.iterations; it++) this._solveEdges();
      this._collide(sub);
    }

    if (input.jump && this.grounded) {
      const step = dt / this.substeps;
      _n.copy(this.contactNormal).multiplyScalar(0.55).add(_v.set(0, 1, 0)).normalize();
      this.addVelocity(_n.x * this.jumpSpeed * step, _n.y * this.jumpSpeed * step, _n.z * this.jumpSpeed * step);
    }

    this._finalize(dt);
    this._updateBody(dt);
  }

  /** Size, jiggle decay and shader uniforms — everything the look reads from. */
  _updateBody(dt) {
    this.time += dt;
    this.wobble = Math.max(0, this.wobble - dt * 2.2);

    // Volume is proportional to goo, so the radius follows its cube root, eased
    // so swelling and shrinking are visible rather than instant.
    const target = Math.cbrt(this.goo);
    this._applyScale(THREE.MathUtils.lerp(this.scale, target, 1 - Math.pow(0.02, dt)));

    if (this.uniforms) {
      this.uniforms.uTime.value = this.time;
      this.uniforms.uFill.value = this.fill;
      this.uniforms.uWobble.value = this.wobble;
    }
  }

  /** Scale the whole body's velocity, keeping it moving as one piece. */
  _scaleVelocity(scale) {
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      for (let k = 0; k < 3; k++) {
        const j = i3 + k;
        this.prev[j] = this.pos[j] - (this.pos[j] - this.prev[j]) * scale;
      }
    }
    this.velocity.multiplyScalar(scale);
  }

  _finalize(dt) {
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      if (!Number.isFinite(this.pos[i3]) || !Number.isFinite(this.pos[i3 + 1]) || !Number.isFinite(this.pos[i3 + 2])) {
        this.reset(this.world.spawn); // paranoia: never let a blown-up sim persist
        return;
      }
      cx += this.pos[i3]; cy += this.pos[i3 + 1]; cz += this.pos[i3 + 2];
      vx += this.pos[i3] - this.prev[i3];
      vy += this.pos[i3 + 1] - this.prev[i3 + 1];
      vz += this.pos[i3 + 2] - this.prev[i3 + 2];
      minY = Math.min(minY, this.pos[i3 + 1]);
      maxY = Math.max(maxY, this.pos[i3 + 1]);
    }
    this.center.set(cx / this.count, cy / this.count, cz / this.count);
    const inv = 1 / (this.count * (dt / this.substeps));
    this.velocity.set(vx * inv, vy * inv, vz * inv);

    // Governor: on the ground, a part-pushed stick settles at a part of top
    // speed. It bleeds off rather than clamping, so landing a fast swing with
    // a thumb resting on the stick does not stop you dead.
    const speed = this.velocity.length();
    if (this.contacts > 0 && this.throttle > 0 && this.throttle < 1) {
      const target = this.maxSpeed * Math.max(0.25, this.throttle);
      if (speed > target) {
        const bleed = Math.min(0.35, ((speed - target) / this.maxSpeed) * dt * 9);
        this._scaleVelocity(1 - bleed);
      }
    }

    // Hard ceiling, applied to the whole body so it stays coherent.
    if (speed > this.maxSpeed) {
      this._scaleVelocity(this.maxSpeed / speed);
    }

    this.squash = THREE.MathUtils.clamp((maxY - minY) / (this.radius * 2), 0.2, 1.6);

    const attr = this.geometry.attributes.position;
    attr.array.set(this.pos);
    attr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    if (this.core) {
      this.core.position.copy(this.center);
      const coreScale = this.scale * (0.75 + this.squash * 0.3);
      this.core.scale.setScalar(THREE.MathUtils.lerp(this.core.scale.x || coreScale, coreScale, 0.2));
    }
  }
}
