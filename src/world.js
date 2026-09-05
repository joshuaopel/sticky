import * as THREE from 'three';

const _local = new THREE.Vector3();
const _clamped = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rayO = new THREE.Vector3();
const _rayD = new THREE.Vector3();

/**
 * An oriented box. Everything in the level collides as one of these: floors,
 * walls, crates, ramps and platforms. Point queries are done in box-local
 * space, which makes rotated geometry (ramps) as cheap as an AABB.
 */
export class BoxCollider {
  constructor(center, halfExtents, quaternion = new THREE.Quaternion(), material = {}) {
    this.center = center.clone();
    this.half = halfExtents.clone();
    this.quat = quaternion.clone();
    this.invQuat = quaternion.clone().invert();
    this.friction = material.friction ?? 0.35;
    this.sticky = material.sticky ?? 1;
  }

  /**
   * Closest-surface query for a sphere of `radius` at `point`.
   * Returns null when there is no contact, otherwise { normal, depth }.
   * `normal` points away from the surface (toward the free side).
   */
  contact(point, radius, out) {
    _local.copy(point).sub(this.center).applyQuaternion(this.invQuat);

    const inside =
      Math.abs(_local.x) <= this.half.x &&
      Math.abs(_local.y) <= this.half.y &&
      Math.abs(_local.z) <= this.half.z;

    if (inside) {
      // Deepest point: escape along the axis with the least penetration.
      const dx = this.half.x - Math.abs(_local.x);
      const dy = this.half.y - Math.abs(_local.y);
      const dz = this.half.z - Math.abs(_local.z);
      let nx = 0, ny = 0, nz = 0, depth;
      if (dx <= dy && dx <= dz) { nx = Math.sign(_local.x) || 1; depth = dx + radius; }
      else if (dy <= dz) { ny = Math.sign(_local.y) || 1; depth = dy + radius; }
      else { nz = Math.sign(_local.z) || 1; depth = dz + radius; }
      out.normal.set(nx, ny, nz).applyQuaternion(this.quat);
      out.depth = depth;
      out.collider = this;
      return out;
    }

    _clamped.set(
      THREE.MathUtils.clamp(_local.x, -this.half.x, this.half.x),
      THREE.MathUtils.clamp(_local.y, -this.half.y, this.half.y),
      THREE.MathUtils.clamp(_local.z, -this.half.z, this.half.z)
    );
    _delta.copy(_local).sub(_clamped);
    const distSq = _delta.lengthSq();
    if (distSq >= radius * radius) return null;

    const dist = Math.sqrt(distSq);
    if (dist < 1e-6) out.normal.set(0, 1, 0);
    else out.normal.copy(_delta).divideScalar(dist).applyQuaternion(this.quat);
    out.depth = radius - dist;
    out.collider = this;
    return out;
  }

  /** Slab test in box-local space. Returns hit distance along dir, or -1. */
  raycast(origin, dir, maxDist, out) {
    _rayO.copy(origin).sub(this.center).applyQuaternion(this.invQuat);
    _rayD.copy(dir).applyQuaternion(this.invQuat);

    let tMin = 0;
    let tMax = maxDist;
    let axis = -1;
    let sign = 1;

    const o = [_rayO.x, _rayO.y, _rayO.z];
    const d = [_rayD.x, _rayD.y, _rayD.z];
    const h = [this.half.x, this.half.y, this.half.z];

    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-8) {
        if (o[i] < -h[i] || o[i] > h[i]) return -1;
        continue;
      }
      const inv = 1 / d[i];
      let t1 = (-h[i] - o[i]) * inv;
      let t2 = (h[i] - o[i]) * inv;
      let s = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
      if (t1 > tMin) { tMin = t1; axis = i; sign = s; }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return -1;
    }

    if (axis === -1) return -1; // ray started inside
    out.normal.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    out.normal.applyQuaternion(this.quat);
    return tMin;
  }
}

/**
 * A faint procedural grid, so big flat surfaces read as surfaces — without it
 * you cannot tell how fast you are sliding down a wall. Skipped outside the
 * browser (the physics runs headless in tests).
 */
function makeGridTexture() {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const o = (i * size) / 4;
    ctx.moveTo(o, 0); ctx.lineTo(o, size);
    ctx.moveTo(0, o); ctx.lineTo(size, o);
  }
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Contact scratch shared by queries (single-threaded, so this is safe). */
const _contact = { normal: new THREE.Vector3(), depth: 0, collider: null };
const _rayHit = { normal: new THREE.Vector3() };

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];
    this.spawn = new THREE.Vector3(0, 4, 16);
    this.bounds = 34;
    this.gridTexture = makeGridTexture();
    this._build();
  }

  addBox(cx, cy, cz, sx, sy, sz, options = {}) {
    const {
      rotation = null,
      color = 0x2b3440,
      material = {},
      visible = true,
      roughness = 0.92,
      metalness = 0.02,
      emissive = 0x000000,
      grid = 0,
    } = options;
    const quat = new THREE.Quaternion();
    if (rotation) quat.setFromEuler(new THREE.Euler(rotation.x || 0, rotation.y || 0, rotation.z || 0));

    const collider = new BoxCollider(
      new THREE.Vector3(cx, cy, cz),
      new THREE.Vector3(sx / 2, sy / 2, sz / 2),
      quat,
      material
    );
    this.colliders.push(collider);

    if (visible) {
      const standard = { color, roughness, metalness, emissive };
      if (grid && this.gridTexture) {
        standard.map = this.gridTexture.clone();
        standard.map.needsUpdate = true;
        standard.map.repeat.set(Math.max(1, Math.round(sx / grid)), Math.max(1, Math.round(sz / grid)));
      }
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshStandardMaterial(standard));
      mesh.position.set(cx, cy, cz);
      mesh.quaternion.copy(quat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      collider.mesh = mesh;
    }
    return collider;
  }

  _build() {
    const R = this.bounds;
    const wall = { color: 0x1d2530, material: { friction: 0.5 } };
    const deck = { color: 0x27313d, material: { friction: 0.45 } };
    const crate = { color: 0x39424f, material: { friction: 0.55 } };
    const accent = { color: 0x1a2f22, emissive: 0x0d2413, material: { friction: 0.6 } };

    // Ground + arena shell.
    this.addBox(0, -1, 0, R * 2, 2, R * 2, { color: 0x1c2430, material: { friction: 0.5 }, grid: 4 });
    this.addBox(0, 8, -R, R * 2, 18, 2, { ...wall, grid: 4 });
    this.addBox(0, 8, R, R * 2, 18, 2, { ...wall, grid: 4 });
    this.addBox(-R, 8, 0, 2, 18, R * 2, { ...wall, grid: 4 });
    this.addBox(R, 8, 0, 2, 18, R * 2, { ...wall, grid: 4 });

    // Central tower with stepped ledges — the thing you swing around.
    this.addBox(0, 7, -6, 8, 14, 8, { ...deck, color: 0x222c38 });
    this.addBox(0, 14.6, -6, 10, 1.2, 10, accent);
    this.addBox(0, 9, -1.2, 6, 0.8, 3, deck);

    // Ramps (rotated boxes) so the blob has something to squash up and slide down.
    this.addBox(-13, 1.4, 10, 12, 0.8, 7, { ...deck, rotation: { z: -0.28 } });
    this.addBox(14, 2.2, 8, 10, 0.8, 6, { ...deck, rotation: { z: 0.34, y: 0.4 } });

    // Scattered crates.
    const crates = [
      [-8, 1.2, 18, 2.4], [-5.4, 1.2, 15.6, 2.4], [-8, 3.6, 18, 2.4],
      [9, 1.5, 19, 3], [12.5, 1.5, 16, 3], [10.8, 4.5, 17.5, 3],
      [-20, 2, -2, 4], [-20, 6, -2, 4], [20, 2, -8, 4],
    ];
    for (const [x, y, z, s] of crates) {
      this.addBox(x, y, z, s, s, s, { ...crate, rotation: { y: (x * z) % 1.4 } });
    }

    // Floating platforms — only reachable by strand.
    const platforms = [
      [-22, 9, 14, 8, 0.9, 8],
      [22, 12, 12, 7, 0.9, 7],
      [-16, 16, -16, 9, 0.9, 9],
      [18, 18, -18, 8, 0.9, 8],
      [0, 22, 8, 10, 0.9, 6],
    ];
    for (const [x, y, z, sx, sy, sz] of platforms) {
      this.addBox(x, y, z, sx, sy, sz, deck);
      this.addBox(x, y + 0.55, z, sx * 0.94, 0.2, sz * 0.94, accent);
    }

    // Overhead beams — good strand targets when you are swinging.
    this.addBox(-6, 20, 20, 3, 1, 40, { ...deck, color: 0x202832 });
    this.addBox(14, 24, -4, 40, 1, 3, { ...deck, color: 0x202832, rotation: { y: 0.2 } });

    // A pit with a lip you have to cling out of.
    this.addBox(24, 1.5, 24, 12, 3, 12, deck);
    this.addBox(24, 4, 18.4, 12, 2, 0.8, accent);
  }

  /** Sphere contact against the whole level. Returns the shared contact or null. */
  collide(point, radius) {
    let best = null;
    let bestDepth = -Infinity;
    for (let i = 0; i < this.colliders.length; i++) {
      const hit = this.colliders[i].contact(point, radius, _contact);
      if (hit && hit.depth > bestDepth) {
        bestDepth = hit.depth;
        best = {
          nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z,
          depth: hit.depth,
          friction: hit.collider.friction,
          sticky: hit.collider.sticky,
        };
      }
    }
    return best;
  }

  /** Nearest ray hit against the level, or null. */
  raycast(origin, dir, maxDist = 200) {
    let bestT = maxDist;
    let bestNormal = null;
    let bestCollider = null;
    for (let i = 0; i < this.colliders.length; i++) {
      const t = this.colliders[i].raycast(origin, dir, bestT, _rayHit);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestNormal = _rayHit.normal.clone();
        bestCollider = this.colliders[i];
      }
    }
    if (!bestNormal) return null;
    return {
      distance: bestT,
      point: origin.clone().addScaledVector(dir, bestT),
      normal: bestNormal,
      collider: bestCollider,
    };
  }
}
