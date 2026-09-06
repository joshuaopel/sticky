import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _binormal = new THREE.Vector3();
const _blobPoint = new THREE.Vector3();

const SIDES = 7;
const GOO_COLOR = 0x9ef01a;

/** Preallocated tube mesh: fixed topology, positions rewritten every frame. */
function makeTube(rings, material) {
  const geometry = new THREE.BufferGeometry();
  const vertexCount = rings * SIDES;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));

  const indices = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < SIDES; s++) {
      const s2 = (s + 1) % SIDES;
      const a = r * SIDES + s;
      const b = r * SIDES + s2;
      const c = (r + 1) * SIDES + s;
      const d = (r + 1) * SIDES + s2;
      indices.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  return mesh;
}

/**
 * One strand of goo: a Verlet rope pinned to the world at one end and welded
 * to a blob particle at the other. Tension travels back into the soft body,
 * so swinging and reeling deform the blob as they move it.
 */
class Strand {
  constructor(scene, world, blob, anchor, normal, particleIndex, material) {
    this.world = world;
    this.blob = blob;
    this.anchor = anchor.clone();
    this.anchorNormal = normal.clone();
    this.particleIndex = particleIndex;

    blob.particle(particleIndex, _blobPoint);
    const span = _blobPoint.distanceTo(anchor);
    const count = THREE.MathUtils.clamp(Math.round(span / 1.1), 6, 28);

    this.points = [];
    this.prev = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const p = _blobPoint.clone().lerp(anchor, t);
      this.points.push(p);
      this.prev.push(p.clone());
    }

    this.length = span * 1.02;
    this.minLength = 1.6;
    this.age = 0;
    this.dying = false;
    this.opacity = 1;

    this.mesh = makeTube(count, material.clone());
    scene.add(this.mesh);
    this.scene = scene;
  }

  get segmentRest() {
    return this.length / (this.points.length - 1);
  }

  reel(dt, rate = 9) {
    this.length = Math.max(this.minLength, this.length - rate * dt);
  }

  update(dt, pullShare, viewPoint = null) {
    const pts = this.points;
    const prev = this.prev;
    const gravity = -16 * dt * dt;
    const damping = 0.985;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = prev[i];
      const vx = (p.x - q.x) * damping;
      const vy = (p.y - q.y) * damping;
      const vz = (p.z - q.z) * damping;
      q.copy(p);
      p.set(p.x + vx, p.y + vy + gravity, p.z + vz);
    }

    const rest = this.segmentRest;
    const last = pts.length - 1;

    for (let iter = 0; iter < 8; iter++) {
      // Weld the tail to the world and, until it is cut, the head to the blob.
      pts[last].copy(this.anchor);
      if (!this.dying) {
        this.blob.particle(this.particleIndex, _blobPoint);
        pts[0].copy(_blobPoint);
      }

      for (let i = 0; i < last; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        _dir.subVectors(q, p);
        const dist = _dir.length();
        if (dist < 1e-6) continue;
        const correction = (dist - rest) / dist;
        // End points are heavier: the pinned anchor never moves, and the blob
        // end only moves as much as the body lets it.
        const wa = i === 0 && !this.dying ? 0.15 : 0.5;
        const wb = i + 1 === last ? 0 : 0.5;
        const total = wa + wb || 1;
        _a.copy(_dir).multiplyScalar((correction * wa) / total);
        _b.copy(_dir).multiplyScalar((correction * wb) / total);
        p.add(_a);
        q.sub(_b);
      }

      // Whatever displacement the rope wants at the head becomes a pull on the blob.
      if (!this.dying && pullShare > 0) {
        _dir.subVectors(pts[0], _blobPoint);
        if (_dir.lengthSq() > 1e-8) {
          this.blob.pullParticle(this.particleIndex, _dir.x, _dir.y, _dir.z, pullShare);
        }
      }
    }

    this._collide();

    pts[last].copy(this.anchor);
    if (!this.dying) {
      this.blob.particle(this.particleIndex, _blobPoint);
      pts[0].copy(_blobPoint);
    }

    this.viewPoint = viewPoint;
    this.age += dt;
    if (this.dying) {
      this.opacity = Math.max(0, this.opacity - dt * 4);
      this.mesh.material.opacity = this.opacity;
    }
    this._rebuild();
  }

  /** Keep the rope on top of the level so it drapes over ledges. */
  _collide() {
    const radius = 0.1;
    for (let i = 1; i < this.points.length - 1; i++) {
      const p = this.points[i];
      const hit = this.world.collide(p, radius);
      if (!hit) continue;
      p.x += hit.nx * hit.depth;
      p.y += hit.ny * hit.depth;
      p.z += hit.nz * hit.depth;
      const q = this.prev[i];
      _dir.subVectors(p, q);
      const vn = _dir.x * hit.nx + _dir.y * hit.ny + _dir.z * hit.nz;
      _dir.x -= hit.nx * vn; _dir.y -= hit.ny * vn; _dir.z -= hit.nz * vn;
      _dir.multiplyScalar(1 - hit.friction);        // goo does not slide much
      q.copy(p).sub(_dir);
    }
  }

  /** Sweep a ring of vertices along the rope with a parallel-transported frame. */
  _rebuild() {
    const pts = this.points;
    const position = this.mesh.geometry.attributes.position;
    const normalAttr = this.mesh.geometry.attributes.normal;
    const pos = position.array;
    const nrm = normalAttr.array;

    // Thinner the more it is stretched — taut goo necks down.
    let span = 0;
    for (let i = 1; i < pts.length; i++) span += pts[i].distanceTo(pts[i - 1]);
    const stretch = THREE.MathUtils.clamp(this.length / Math.max(span, 1e-3), 0.6, 1.25);
    const base = 0.15 * stretch * (this.dying ? this.opacity : 1);

    _normal.set(0, 0, 0);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      _tangent.subVectors(b, a);
      if (_tangent.lengthSq() < 1e-10) _tangent.set(0, 1, 0);
      _tangent.normalize();

      if (i === 0) {
        _normal.set(_tangent.z, _tangent.x, _tangent.y).cross(_tangent);
        if (_normal.lengthSq() < 1e-8) _normal.set(1, 0, 0);
        _normal.normalize();
      } else {
        // Parallel transport: keep the previous normal, re-orthogonalised.
        _normal.addScaledVector(_tangent, -_normal.dot(_tangent));
        if (_normal.lengthSq() < 1e-8) _normal.set(_tangent.y, -_tangent.z, _tangent.x);
        _normal.normalize();
      }
      _binormal.crossVectors(_tangent, _normal);

      const t = i / (pts.length - 1);
      // Fat where it meets the blob and the wall, with a slow travelling ripple.
      const profile = 0.55 + 0.65 * Math.pow(Math.abs(2 * t - 1), 2.2);
      const ripple = 1 + 0.16 * Math.sin(t * 14 - this.age * 7);
      // Thin away to nothing right at the camera, so a strand running past your
      // eye does not smear across the whole screen.
      let near = 1;
      if (this.viewPoint) {
        const n = THREE.MathUtils.clamp((p.distanceTo(this.viewPoint) - 0.6) / 1.6, 0, 1);
        near = n * n * (3 - 2 * n);
      }
      const radius = base * profile * ripple * near;

      for (let s = 0; s < SIDES; s++) {
        const ang = (s / SIDES) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sy = Math.sin(ang);
        const nx = _normal.x * cx + _binormal.x * sy;
        const ny = _normal.y * cx + _binormal.y * sy;
        const nz = _normal.z * cx + _binormal.z * sy;
        const o = (i * SIDES + s) * 3;
        pos[o] = p.x + nx * radius;
        pos[o + 1] = p.y + ny * radius;
        pos[o + 2] = p.z + nz * radius;
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
      }
    }
    position.needsUpdate = true;
    normalAttr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Flying goo blob fired from the muzzle before it becomes a strand. */
class Projectile {
  constructor(scene, origin, dir, speed, material) {
    this.pos = origin.clone();
    this.vel = dir.clone().multiplyScalar(speed);
    this.travelled = 0;
    this.mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), material);
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.scene = scene;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}

/**
 * The slime gun: fires goo projectiles, turns hits into strands, winches you in.
 */
export class GooGun {
  constructor(scene, world, blob, puddles) {
    this.scene = scene;
    this.world = world;
    this.blob = blob;
    this.puddles = puddles;
    this.strands = [];
    this.projectiles = [];
    this.dyingStrands = [];
    this.maxStrands = 4;
    this.reeling = false;
    this.reelForce = 34;
    this.cooldown = 0;
    // Fraction of a shot you get back by collecting where the strand landed.
    this.recoverable = 0.6;
    this.viewPoint = null;

    this.strandMaterial = new THREE.MeshPhysicalMaterial({
      color: GOO_COLOR,
      roughness: 0.32,
      metalness: 0,
      clearcoat: 0.8,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.35,
      emissive: new THREE.Color(0x4c8f0c),
      emissiveIntensity: 0.7,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.projectileMaterial = new THREE.MeshStandardMaterial({
      color: 0xb6ff3d,
      emissive: 0x4d8a06,
      emissiveIntensity: 1.2,
      roughness: 0.3,
    });
  }

  get strandCount() {
    return this.strands.length;
  }

  /**
   * Fire, if there is goo to spare. Every shot is mass out of the body, so the
   * blob visibly shrinks as you use the gun.
   * @returns {boolean} whether the shot went out.
   */
  shoot(origin, dir) {
    if (this.cooldown > 0) return false;
    if (!this.blob.spendGoo(this.blob.shotCost)) return false;
    this.cooldown = 0.16;
    this.projectiles.push(new Projectile(this.scene, origin, dir, 62, this.projectileMaterial));
    return true;
  }

  /** Cut a strand loose; what it was made of drips down to its anchor. */
  _release(strand) {
    strand.dying = true;
    this.dyingStrands.push(strand);
    if (this.puddles) {
      this.puddles.spawn(strand.anchor, strand.anchorNormal, this.blob.shotCost * this.recoverable);
    }
  }

  cutAll() {
    for (const strand of this.strands) this._release(strand);
    this.strands.length = 0;
  }

  _attach(point, normal) {
    if (this.strands.length >= this.maxStrands) {
      this._release(this.strands.shift());
    }
    _dir.subVectors(point, this.blob.center).normalize();
    const index = this.blob.nearestParticle(_dir);
    const strand = new Strand(this.scene, this.world, this.blob, point, normal, index, this.strandMaterial);
    strand.initialLength = strand.length;
    this.strands.push(strand);

    // A little of the shot sticks where it landed straight away.
    if (this.puddles) this.puddles.spawn(point, normal, this.blob.shotCost * 0.12);
    return strand;
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);

    // --- projectiles ------------------------------------------------------
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const steps = 3;
      const h = dt / steps;
      let consumed = false;
      for (let s = 0; s < steps && !consumed; s++) {
        p.vel.y -= 13 * h;
        _dir.copy(p.vel).multiplyScalar(h);
        const dist = _dir.length();
        if (dist > 1e-6) {
          _a.copy(_dir).divideScalar(dist);
          const hit = this.world.raycast(p.pos, _a, dist + 0.16);
          if (hit) {
            this._attach(hit.point.addScaledVector(hit.normal, 0.04), hit.normal);
            consumed = true;
            break;
          }
        }
        p.pos.add(_dir);
        p.travelled += dist;
      }
      if (consumed || p.travelled > 110 || p.pos.y < -20) {
        p.dispose();
        this.projectiles.splice(i, 1);
      } else {
        p.mesh.position.copy(p.pos);
      }
    }

    // --- strands ----------------------------------------------------------
    const share = this.reeling ? 0.16 : 0.09;
    const spread = Math.max(1, this.strands.length * 0.6);
    for (const strand of this.strands) {
      // A strand is a rope, not a spring: the body never gets further from the
      // anchor than the strand is long.
      this.blob.constrainToAnchor(strand.anchor, strand.length, 0.85);
      if (this.reeling) {
        strand.reel(dt);
        // Rope tension alone is a soft spring; the winch is what makes the
        // gun feel like a gun. Only pulls while the strand is actually taut.
        _dir.subVectors(strand.anchor, this.blob.center);
        const dist = _dir.length();
        if (dist > strand.length * 0.9 && dist > 1e-3) {
          _dir.divideScalar(dist);
          this.blob.applyImpulse(_dir, this.reelForce * dt);
        }
      }
      strand.update(dt, share / spread, this.viewPoint);
    }

    for (let i = this.dyingStrands.length - 1; i >= 0; i--) {
      const strand = this.dyingStrands[i];
      strand.update(dt, 0, this.viewPoint);
      if (strand.opacity <= 0) {
        strand.dispose();
        this.dyingStrands.splice(i, 1);
      }
    }
  }
}
