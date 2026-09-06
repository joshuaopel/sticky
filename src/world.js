import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _local = new THREE.Vector3();
const _clamped = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _rayO = new THREE.Vector3();
const _rayD = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/**
 * An oriented box. Everything in the ruin collides as one of these: flagstones,
 * curtain walls, stairs, fallen columns, hanging cages. Point queries run in
 * box-local space, so a tilted block costs the same as an axis-aligned one.
 */
export class BoxCollider {
  constructor(center, halfExtents, quaternion = new THREE.Quaternion(), material = {}) {
    this.center = center.clone();
    this.half = halfExtents.clone();
    this.quat = quaternion.clone();
    this.invQuat = quaternion.clone().invert();
    this.friction = material.friction ?? 0.42;
    this.sticky = material.sticky ?? 1;

    // World-space bounds, used by the broadphase grid.
    const e = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.quat)).elements;
    const ex = Math.abs(e[0]) * this.half.x + Math.abs(e[3]) * this.half.y + Math.abs(e[6]) * this.half.z;
    const ey = Math.abs(e[1]) * this.half.x + Math.abs(e[4]) * this.half.y + Math.abs(e[7]) * this.half.z;
    const ez = Math.abs(e[2]) * this.half.x + Math.abs(e[5]) * this.half.y + Math.abs(e[8]) * this.half.z;
    this.min = new THREE.Vector3(center.x - ex, center.y - ey, center.z - ez);
    this.max = new THREE.Vector3(center.x + ex, center.y + ey, center.z + ez);
  }

  /**
   * Closest-surface query for a sphere of `radius` at `point`.
   * Returns null when there is no contact, otherwise { normal, depth }.
   */
  contact(point, radius, out) {
    // Cheap reject first — most colliders in a level this size are nowhere near.
    if (
      point.x + radius < this.min.x || point.x - radius > this.max.x ||
      point.y + radius < this.min.y || point.y - radius > this.max.y ||
      point.z + radius < this.min.z || point.z - radius > this.max.z
    ) return null;

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

/* ------------------------------------------------------------------ textures */

function canvasTexture(size, draw, { repeat = true, srgb = true } = {}) {
  if (typeof document === 'undefined') return null; // physics runs headless in tests
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Deterministic noise so the ruin looks the same every run. */
function makeRandom(seed = 9871) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function speckle(ctx, size, random, count, alpha) {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(random() * 60);
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
  }
}

/** Coursed stone blocks with deep mortar joints — the castle's default skin. */
function stoneBlockTexture() {
  return canvasTexture(256, (ctx, size) => {
    const random = makeRandom(4711);
    ctx.fillStyle = '#3b3a36';
    ctx.fillRect(0, 0, size, size);

    const rows = 6;
    const height = size / rows;
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) * height * 1.1;
      let x = -offset;
      while (x < size) {
        const width = height * (1.3 + random() * 1.2);
        const shade = 148 + Math.floor(random() * 46);
        ctx.fillStyle = `rgb(${shade},${shade - 4},${shade - 14})`;
        ctx.fillRect(x + 2, r * height + 2, width - 4, height - 4);
        // Lit top edge, shadowed bottom: fakes relief without a normal map.
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(x + 2, r * height + 2, width - 4, 2);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(x + 2, r * height + height - 5, width - 4, 3);
        x += width;
      }
    }
    speckle(ctx, size, random, 900, 0.16);

    // A few cracks running down the courses.
    ctx.strokeStyle = 'rgba(20,20,18,0.55)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = random() * size;
      let y = random() * size;
      ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) {
        x += (random() - 0.5) * 22;
        y += random() * 18;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
}

/** Big worn flagstones for floors and stair treads. */
function flagstoneTexture() {
  return canvasTexture(256, (ctx, size) => {
    const random = makeRandom(2024);
    ctx.fillStyle = '#31302c';
    ctx.fillRect(0, 0, size, size);
    const cells = 4;
    const step = size / cells;
    for (let gx = 0; gx < cells; gx++) {
      for (let gy = 0; gy < cells; gy++) {
        const inset = 3 + random() * 2;
        const shade = 122 + Math.floor(random() * 44);
        ctx.fillStyle = `rgb(${shade},${shade - 2},${shade - 10})`;
        ctx.fillRect(gx * step + inset, gy * step + inset, step - inset * 2, step - inset * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(gx * step + inset, gy * step + step - inset - 3, step - inset * 2, 3);
      }
    }
    speckle(ctx, size, random, 1400, 0.2);
  });
}

/** Rough timber for beams, doors and scaffolding. */
function timberTexture() {
  return canvasTexture(128, (ctx, size) => {
    const random = makeRandom(777);
    ctx.fillStyle = '#5a3f27';
    ctx.fillRect(0, 0, size, size);
    const planks = 4;
    const width = size / planks;
    for (let p = 0; p < planks; p++) {
      const shade = 92 + Math.floor(random() * 40);
      ctx.fillStyle = `rgb(${shade},${Math.floor(shade * 0.68)},${Math.floor(shade * 0.42)})`;
      ctx.fillRect(p * width + 1, 0, width - 2, size);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      for (let g = 0; g < 5; g++) {
        const x = p * width + 3 + random() * (width - 6);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + 4, size * 0.3, x - 4, size * 0.7, x, size);
        ctx.stroke();
      }
    }
  });
}

/** Pitted dark iron for grates, cages and the portcullis. */
function ironTexture() {
  return canvasTexture(128, (ctx, size) => {
    const random = makeRandom(3313);
    ctx.fillStyle = '#4a4b50';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, random, 2200, 0.35);
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = 'rgba(120,74,40,0.25)'; // rust blooms
      ctx.beginPath();
      ctx.arc(random() * size, random() * size, 2 + random() * 7, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

const _contact = { normal: new THREE.Vector3(), depth: 0, collider: null };
const _rayHit = { normal: new THREE.Vector3() };
const CELL = 8;

export class World {
  constructor(scene, options = {}) {
    this.scene = scene;
    // Point lights are the first thing a phone runs out of, so the number of
    // torches that actually cast light is a budget.
    this.maxLights = options.maxLights ?? 12;
    this.colliders = [];
    this.spawn = new THREE.Vector3(0, 4, 24);
    this.bounds = 34;
    this.torches = [];
    this.random = makeRandom(20260906);

    this._buckets = new Map();
    this.materials = this._createMaterials();
    this._build();
    this._commit();
    this._buildGrid();
  }

  _createMaterials() {
    const stoneMap = stoneBlockTexture();
    const floorMap = flagstoneTexture();
    const woodMap = timberTexture();
    const ironMap = ironTexture();

    const stone = (color, map, extra = {}) => new THREE.MeshStandardMaterial({
      color,
      map,
      bumpMap: map,
      bumpScale: 0.35,
      roughness: 0.94,
      metalness: 0.02,
      ...extra,
    });

    return {
      stone: stone(0xa8a49a, stoneMap),
      stoneDark: stone(0x6f6e69, stoneMap),
      stoneWarm: stone(0xb9a98c, stoneMap),
      moss: stone(0x7d8f5c, stoneMap, { roughness: 1 }),
      floor: stone(0x9c9890, floorMap),
      timber: stone(0x9a7448, woodMap, { roughness: 0.85 }),
      iron: stone(0x8d9099, ironMap, { roughness: 0.55, metalness: 0.55, bumpScale: 0.2 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.32, metalness: 0.85 }),
      banner: new THREE.MeshStandardMaterial({ color: 0x8e2436, roughness: 0.85 }),
      bannerBlue: new THREE.MeshStandardMaterial({ color: 0x2c4a86, roughness: 0.85 }),
      flame: new THREE.MeshBasicMaterial({ color: 0xffc35c }),
    };
  }

  /**
   * Add one block. Everything in the level is one of these — the ruin is built
   * the way the blob sees it, so what you look at is exactly what you collide
   * with. Geometry is bucketed per material and merged at the end, which keeps
   * a few hundred blocks down to a handful of draw calls.
   */
  addBox(x, y, z, sx, sy, sz, options = {}) {
    const {
      surface = 'stone',
      rot = null,
      friction,
      sticky,
      solid = true,
      tile = 3.2,
      shadow = true,
    } = options;

    const quat = new THREE.Quaternion();
    if (rot) quat.setFromEuler(new THREE.Euler(rot.x || 0, rot.y || 0, rot.z || 0));

    if (solid) {
      this.colliders.push(new BoxCollider(
        new THREE.Vector3(x, y, z),
        new THREE.Vector3(sx / 2, sy / 2, sz / 2),
        quat,
        { friction, sticky }
      ));
    }

    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    if (tile && geometry.attributes.uv) scaleBoxUVs(geometry, sx, sy, sz, tile);
    _mat.compose(new THREE.Vector3(x, y, z), quat, new THREE.Vector3(1, 1, 1));
    geometry.applyMatrix4(_mat);

    const key = shadow ? surface : `${surface}:noshadow`;
    if (!this._buckets.has(key)) this._buckets.set(key, []);
    this._buckets.get(key).push(geometry);
  }


  /**
   * A stack of additive blocks standing in for a flame: wide and orange at the
   * base, small and pale at the tip. Blocky, like everything else here, but it
   * glows and it flickers, which is all a torch has to do.
   */
  _flame(x, y, z, size = 1) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const layers = [
      [1.0, 0.0, 0xff7a1e],
      [0.72, 0.45, 0xffb347],
      [0.46, 0.85, 0xffe9a8],
    ];
    for (const [scale, offset, color] of layers) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size * scale, size * scale * 1.5, size * scale),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      mesh.position.y = offset * size;
      mesh.rotation.y = this.random() * Math.PI;
      group.add(mesh);
    }
    this.scene.add(group);
    return group;
  }

  /* --------------------------------------------------------- set pieces --- */

  /** Merlons along the top of a wall, with a few knocked out. */
  _crenellations(x, y, z, length, axis, options = {}) {
    const { size = 1.6, gap = 1.5, depth = 2.2, height = 1.8, ruin = 0.25, surface = 'stone' } = options;
    const step = size + gap;
    const count = Math.floor(length / step);
    const start = -((count - 1) * step) / 2;
    for (let i = 0; i < count; i++) {
      if (this.random() < ruin) continue; // knocked off centuries ago
      const offset = start + i * step;
      const h = height * (0.6 + this.random() * 0.5);
      if (axis === 'x') this.addBox(x + offset, y + h / 2, z, size, h, depth, { surface });
      else this.addBox(x, y + h / 2, z + offset, depth, h, size, { surface });
    }
  }

  /** A run of curtain wall, crenellated, with an optional collapsed notch. */
  _curtainWall(x, y, z, length, thickness, height, axis, options = {}) {
    const { collapse = null, surface = 'stone' } = options;

    if (!collapse) {
      if (axis === 'x') this.addBox(x, y + height / 2, z, length, height, thickness, { surface });
      else this.addBox(x, y + height / 2, z, thickness, height, length, { surface });
      this._crenellations(x, y + height, z, length, axis, { depth: thickness * 0.75, surface });
      return;
    }

    // Two standing runs with a broken-down stretch between them.
    const half = length / 2;
    const gapStart = collapse.from;
    const gapEnd = collapse.to;
    const runs = [
      [-half, gapStart],
      [gapEnd, half],
    ];
    for (const [a, b] of runs) {
      const span = b - a;
      if (span <= 0.1) continue;
      const centre = (a + b) / 2;
      if (axis === 'x') {
        this.addBox(x + centre, y + height / 2, z, span, height, thickness, { surface });
        this._crenellations(x + centre, y + height, z, span, axis, { depth: thickness * 0.75, surface });
      } else {
        this.addBox(x, y + height / 2, z + centre, thickness, height, span, { surface });
        this._crenellations(x, y + height, z + centre, span, axis, { depth: thickness * 0.75, surface });
      }
    }

    // The collapsed stretch: a low stub you can climb, plus spill either side.
    const stubSpan = gapEnd - gapStart;
    const stubCentre = (gapStart + gapEnd) / 2;
    const stubHeight = height * 0.3;
    if (axis === 'x') {
      this.addBox(x + stubCentre, y + stubHeight / 2, z, stubSpan, stubHeight, thickness, { surface });
      this._rubble(x + stubCentre, z + thickness, { count: 7, spread: stubSpan * 0.45, scale: 1.6 });
    } else {
      this.addBox(x, y + stubHeight / 2, z + stubCentre, thickness, stubHeight, stubSpan, { surface });
      this._rubble(x + thickness, z + stubCentre, { count: 7, spread: stubSpan * 0.45, scale: 1.6 });
    }
  }

  /** A flight of steps. `dir` is a unit direction in the XZ plane. */
  _stairs(x, y, z, dir, options = {}) {
    const { steps = 8, rise = 1, run = 1.4, width = 5, surface = 'floor' } = options;
    for (let i = 0; i < steps; i++) {
      const cx = x + dir.x * (run * (i + 0.5));
      const cz = z + dir.z * (run * (i + 0.5));
      const height = rise * (i + 1);
      const sx = Math.abs(dir.x) > 0.5 ? run : width;
      const sz = Math.abs(dir.x) > 0.5 ? width : run;
      this.addBox(cx, y + height / 2, cz, sx, height, sz, { surface });
    }
  }

  /** Square column: base, shaft, capital — snapped off part way up if broken. */
  _column(x, z, height, options = {}) {
    const { size = 2.2, broken = false, surface = 'stone' } = options;
    this.addBox(x, 0.4, z, size * 1.45, 0.8, size * 1.45, { surface });
    this.addBox(x, 0.9 + height / 2, z, size, height, size, { surface });
    if (broken) {
      // A jagged snapped top rather than a clean cut.
      this.addBox(x + size * 0.2, 0.9 + height + 0.25, z - size * 0.15, size * 0.7, 0.5, size * 0.6,
        { surface, rot: { y: 0.4, z: 0.12 } });
      return;
    }
    this.addBox(x, 0.9 + height + 0.35, z, size * 1.5, 0.7, size * 1.5, { surface });
  }

  /** Blocky corbelled arch — two piers stepping inward to a keystone. */
  _arch(x, y, z, options = {}) {
    const { width = 7, height = 8, depth = 3, rotY = 0, pier = 2, surface = 'stone' } = options;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    const place = (ox, oy, sx, sy) => {
      this.addBox(x + ox * cos, y + oy, z - ox * sin, sx, sy, depth, { surface, rot: { y: rotY } });
    };
    const halfOpening = width / 2;
    place(-(halfOpening + pier / 2), height / 2, pier, height);
    place(halfOpening + pier / 2, height / 2, pier, height);
    // Corbels: each course leans a little further over the opening.
    const courses = 3;
    for (let i = 0; i < courses; i++) {
      const inset = (halfOpening / (courses + 1)) * (i + 1);
      const sy = 0.8;
      const oy = height + sy * (i + 0.5);
      place(-(halfOpening - inset / 2) - pier / 2 + inset / 2, oy, pier + inset, sy);
      place((halfOpening - inset / 2) + pier / 2 - inset / 2, oy, pier + inset, sy);
    }
    place(0, height + 0.8 * courses + 0.5, width * 0.55, 1);
  }

  /** Tumbled blocks, for wherever the castle has fallen down. */
  _rubble(x, z, options = {}) {
    const { count = 6, spread = 3, scale = 1, y = 0, surface = 'stoneDark' } = options;
    for (let i = 0; i < count; i++) {
      const size = (0.7 + this.random() * 1.3) * scale;
      this.addBox(
        x + (this.random() - 0.5) * spread * 2,
        y + size * 0.4,
        z + (this.random() - 0.5) * spread * 2,
        size, size * (0.5 + this.random() * 0.5), size * (0.7 + this.random() * 0.6),
        { surface, rot: { x: (this.random() - 0.5) * 0.5, y: this.random() * 3.1, z: (this.random() - 0.5) * 0.5 } }
      );
    }
  }

  /** Wall torch: iron bracket, a flame, and (optionally) a real light. */
  _torch(x, y, z, options = {}) {
    const { dir = { x: 0, z: 1 }, lit = true, intensity = 9 } = options;
    this.addBox(x, y, z, 0.35, 1.5, 0.35, { surface: 'iron', solid: false, tile: 1 });
    this.addBox(x - dir.x * 0.35, y - 0.4, z - dir.z * 0.35, 0.8, 0.3, 0.8, { surface: 'iron', solid: false, tile: 1 });

    const flame = this._flame(x, y + 1.1, z, 0.55);

    if (!lit || this.torches.length >= this.maxLights) return;
    const light = new THREE.PointLight(0xffa03c, intensity, 24, 2);
    light.position.set(x, y + 1.2, z);
    this.scene.add(light);
    this.torches.push({ light, flame, intensity, phase: this.random() * 10, speed: 4 + this.random() * 3 });
  }

  /** Fire basket on legs — the courtyard's light source. */
  _brazier(x, z, options = {}) {
    const { lit = true } = options;
    for (const [ox, oz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) {
      this.addBox(x + ox, 0.75, z + oz, 0.28, 1.5, 0.28, { surface: 'iron', tile: 1, solid: false, rot: { x: (oz > 0 ? 1 : -1) * 0.12, z: (ox > 0 ? -1 : 1) * 0.12 } });
    }
    // A deep basket rather than a plate, so the fire sits down inside it.
    this.addBox(x, 1.6, z, 1.5, 0.5, 1.5, { surface: 'iron', tile: 1.2 });
    for (const [ox, oz, sx, sz] of [[0, -0.75, 1.7, 0.2], [0, 0.75, 1.7, 0.2], [-0.75, 0, 0.2, 1.7], [0.75, 0, 0.2, 1.7]]) {
      this.addBox(x + ox, 2.1, z + oz, sx, 1.1, sz, { surface: 'iron', tile: 1 });
    }

    const fire = this._flame(x, 2.2, z, 1.05);
    if (!lit || this.torches.length >= this.maxLights) return;
    const light = new THREE.PointLight(0xff8a2c, 14, 30, 2);
    light.position.set(x, 2.6, z);
    this.scene.add(light);
    this.torches.push({ light, flame: fire, intensity: 14, phase: this.random() * 10, speed: 3 + this.random() * 2 });
  }

  /** Hanging banner, tattered at the bottom. */
  _banner(x, y, z, options = {}) {
    const { width = 2.6, height = 7, rotY = 0, surface = 'banner' } = options;
    this.addBox(x, y, z, width + 0.6, 0.3, 0.3, { surface: 'timber', rot: { y: rotY }, solid: false, tile: 1 });
    this.addBox(x, y - height / 2, z, width, height, 0.18, { surface, rot: { y: rotY }, solid: false, tile: 0 });
    // Torn tails.
    const tails = 3;
    for (let i = 0; i < tails; i++) {
      const w = width / tails;
      const drop = 0.4 + this.random() * 1.4;
      const ox = -width / 2 + w * (i + 0.5);
      this.addBox(
        x + ox * Math.cos(rotY), y - height - drop / 2, z - ox * Math.sin(rotY),
        w * 0.8, drop, 0.18, { surface, rot: { y: rotY }, solid: false, tile: 0 }
      );
    }
  }

  /** Chandelier on a chain: a ring of candles, and a light if it is still lit. */
  _chandelier(x, y, z, options = {}) {
    const { radius = 2.2, drop = 3, lit = true } = options;
    this.addBox(x, y + drop / 2, z, 0.18, drop, 0.18, { surface: 'iron', solid: false, tile: 1 });
    const arms = 8;
    for (let i = 0; i < arms; i++) {
      const angle = (i / arms) * Math.PI * 2;
      const ox = Math.cos(angle) * radius;
      const oz = Math.sin(angle) * radius;
      this.addBox(x + ox, y, z + oz, 0.8, 0.25, 0.8, { surface: 'iron', rot: { y: angle }, tile: 1 });
      this.addBox(x + ox, y + 0.5, z + oz, 0.3, 0.7, 0.3, { surface: 'gold', solid: false, tile: 0 });
      if (lit) this._flame(x + ox, y + 0.95, z + oz, 0.24);
    }
    // The ring itself is solid, so you can land on a chandelier.
    this.addBox(x, y - 0.15, z, radius * 2, 0.3, 0.6, { surface: 'iron', tile: 1.5 });
    this.addBox(x, y - 0.15, z, 0.6, 0.3, radius * 2, { surface: 'iron', tile: 1.5 });
    if (!lit || this.torches.length >= this.maxLights) return;
    const light = new THREE.PointLight(0xffb35a, 11, 26, 2);
    light.position.set(x, y + 0.8, z);
    this.scene.add(light);
    this.torches.push({ light, flame: null, intensity: 11, phase: this.random() * 10, speed: 2.5 });
  }

  /** Iron cage swinging over the pit — solid, so it doubles as a landing pad. */
  _cage(x, y, z, options = {}) {
    const { size = 2.4, height = 3, chain = 4 } = options;
    this.addBox(x, y + height + chain / 2, z, 0.16, chain, 0.16, { surface: 'iron', solid: false, tile: 1 });
    const h = size / 2;
    for (const [ox, oz] of [[-h, -h], [h, -h], [-h, h], [h, h]]) {
      this.addBox(x + ox, y + height / 2, z + oz, 0.22, height, 0.22, { surface: 'iron', tile: 1 });
    }
    this.addBox(x, y, z, size, 0.3, size, { surface: 'iron', tile: 1.4 });
    this.addBox(x, y + height, z, size, 0.3, size, { surface: 'iron', tile: 1.4 });
  }

  /** Stack of barrels — blocky, but nobody will mistake them for anything else. */
  _barrels(x, z, options = {}) {
    const { count = 4 } = options;
    for (let i = 0; i < count; i++) {
      const bx = x + (this.random() - 0.5) * 3;
      const bz = z + (this.random() - 0.5) * 3;
      const fallen = this.random() < 0.3;
      if (fallen) {
        this.addBox(bx, 0.75, bz, 2.2, 1.5, 1.5, { surface: 'timber', rot: { z: Math.PI / 2, y: this.random() * 3 }, tile: 1.2 });
      } else {
        this.addBox(bx, 0.9, bz, 1.5, 1.8, 1.5, { surface: 'timber', rot: { y: this.random() * 3 }, tile: 1.2 });
        this.addBox(bx, 0.9, bz, 1.62, 0.25, 1.62, { surface: 'iron', rot: { y: this.random() * 3 }, tile: 1 });
      }
    }
  }

  /** A toppled king, face down in the courtyard. */
  _statue(x, z, rotY = 0) {
    const s = 'stoneWarm';
    // Plinth still standing, statue on its face beside it.
    this.addBox(x, 0.6, z, 4, 1.2, 4, { surface: 'stone' });
    this.addBox(x + 1.4, 1.4, z, 4.5, 1.4, 2, { surface: s, rot: { y: rotY, z: 0.06 } });          // torso
    this.addBox(x + 4.2, 1.5, z, 1.8, 1.8, 1.8, { surface: s, rot: { y: rotY + 0.3 } });            // head
    this.addBox(x + 5.2, 1.9, z, 1.4, 0.6, 1.9, { surface: 'gold', rot: { y: rotY + 0.3 }, tile: 0 }); // crown
    this.addBox(x - 1.2, 1.2, z + 0.4, 3, 1, 1.1, { surface: s, rot: { y: rotY - 0.2 } });          // legs
    this.addBox(x - 1.2, 1.2, z - 0.9, 3, 1, 1.1, { surface: s, rot: { y: rotY + 0.15 } });
    this._rubble(x + 2, z + 2.5, { count: 4, spread: 2, scale: 0.8 });
  }

  /* -------------------------------------------------------------- level --- */

  _build() {
    this._floorsAndPit();
    this._curtainWalls();
    this._gatehouse();
    this._keep();
    this._greatHall();
    this._dungeon();
    this._courtyard();
  }

  /** Flagstone floor, cut around the dungeon pit in the east corner. */
  _floorsAndPit() {
    const R = this.bounds;
    const pit = { x0: 13, x1: 27, z0: 7, z1: 21 };
    const slab = (x0, x1, z0, z1) =>
      this.addBox((x0 + x1) / 2, -1, (z0 + z1) / 2, x1 - x0, 2, z1 - z0, { surface: 'floor', tile: 4, friction: 0.5 });

    slab(-R, pit.x0, -R, R);
    slab(pit.x0, R, -R, pit.z0);
    slab(pit.x0, R, pit.z1, R);
    slab(pit.x1, R, pit.z0, pit.z1);

    // The pit: a floor seven metres down and rough walls around it.
    this.addBox(20, -8, 14, 14, 2, 14, { surface: 'floor', tile: 4 });
    this.addBox(20, -3.5, 7.5, 14, 7, 1, { surface: 'stoneDark' });
    this.addBox(20, -3.5, 20.5, 14, 7, 1, { surface: 'stoneDark' });
    this.addBox(13.5, -3.5, 14, 1, 7, 14, { surface: 'stoneDark' });
    this.addBox(26.5, -3.5, 14, 1, 7, 14, { surface: 'stoneDark' });
  }

  /** Ruined curtain wall around the bailey, collapsed in two places. */
  _curtainWalls() {
    const R = this.bounds;
    const thickness = 3;
    const height = 17;

    this._curtainWall(0, 0, -R, R * 2, thickness, height, 'x', { collapse: { from: -20, to: -9 } });
    this._curtainWall(-R, 0, 0, R * 2, thickness, height, 'z', { collapse: { from: 6, to: 17 } });
    this._curtainWall(R, 0, 0, R * 2, thickness, height, 'z');
    // South wall is split by the gatehouse.
    this.addBox(-21, height / 2, R, 26, height, thickness, { surface: 'stone' });
    this._crenellations(-21, height, R, 26, 'x', { depth: thickness * 0.75 });
    this.addBox(21, height / 2, R, 26, height, thickness, { surface: 'stone' });
    this._crenellations(21, height, R, 26, 'x', { depth: thickness * 0.75 });

    // Corner towers, one of them sheared off.
    const tower = (x, z, h, ruined) => {
      this.addBox(x, h / 2, z, 8, h, 8, { surface: 'stone' });
      if (ruined) {
        this.addBox(x - 1.5, h + 1, z + 1, 5, 2, 5, { surface: 'stone', rot: { z: 0.12, y: 0.3 } });
        this._rubble(x + 5, z - 4, { count: 6, spread: 3, scale: 1.5 });
      } else {
        this.addBox(x, h + 0.6, z, 10, 1.2, 10, { surface: 'stone' });   // machicolation
        this._crenellations(x, h + 1.2, z - 4.6, 10, 'x', { ruin: 0.15 });
        this._crenellations(x, h + 1.2, z + 4.6, 10, 'x', { ruin: 0.15 });
        this._crenellations(x - 4.6, h + 1.2, z, 10, 'z', { ruin: 0.15 });
        this._crenellations(x + 4.6, h + 1.2, z, 10, 'z', { ruin: 0.15 });
      }
    };
    tower(-R + 2, -R + 2, 21, false);
    tower(R - 2, -R + 2, 13, true);
    tower(-R + 2, R - 2, 19, false);
    tower(R - 2, R - 2, 21, false);

    // Rampart walkway you can run along, reached from the gatehouse stair.
    this.addBox(-21, height - 1.4, R - 3, 26, 1, 3.4, { surface: 'floor', tile: 3 });
    this.addBox(21, height - 1.4, R - 3, 26, 1, 3.4, { surface: 'floor', tile: 3 });
  }

  /** The way in: twin towers, an arch, and a half-raised portcullis. */
  _gatehouse() {
    const R = this.bounds;
    const z = R;
    this.addBox(-7, 11, z, 6, 22, 7, { surface: 'stone' });
    this.addBox(7, 11, z, 6, 22, 7, { surface: 'stone' });
    this.addBox(0, 19, z, 20, 6, 7, { surface: 'stone' });                 // span over the gate
    this._crenellations(0, 22, z, 20, 'x', { ruin: 0.2, depth: 5 });
    this._arch(0, 0, z - 3.6, { width: 8, height: 11, depth: 2, pier: 2 });

    // Portcullis, stuck half way up.
    for (let i = -3; i <= 3; i++) {
      this.addBox(i * 1.2, 13.5, z - 3.4, 0.3, 7, 0.3, { surface: 'iron', tile: 1 });
    }
    this.addBox(0, 10.2, z - 3.4, 8.4, 0.5, 0.5, { surface: 'iron', tile: 1 });

    this._torch(-4.6, 6, z - 4.6, { dir: { x: 0, z: 1 } });
    this._torch(4.6, 6, z - 4.6, { dir: { x: 0, z: 1 } });
    this._stairs(-11.5, 0, R - 5, { x: 0, z: -1 }, { steps: 10, rise: 1.55, run: 1.5, width: 4 });

    // Beyond the gate: a causeway ending at a broken drawbridge. Without it the
    // arch is a hole you can drive straight out of the world through.
    this.addBox(0, -1, z + 7, 14, 2, 12, { surface: 'floor', tile: 4 });
    this.addBox(-7.5, 0.9, z + 7, 1, 1.8, 12, { surface: 'stone' });   // parapets
    this.addBox(7.5, 0.9, z + 7, 1, 1.8, 12, { surface: 'stone' });
    this.addBox(0, 0.2, z + 14.5, 11, 0.7, 5, { surface: 'timber', rot: { x: -0.5 }, tile: 2 });
    this.addBox(-5.6, 3.4, z + 12.4, 0.7, 7, 0.7, { surface: 'timber', tile: 1.5 });
    this.addBox(5.6, 3.4, z + 12.4, 0.7, 7, 0.7, { surface: 'timber', tile: 1.5 });
    this.addBox(0, 6.6, z + 12.4, 12, 0.7, 0.7, { surface: 'timber', tile: 1.5 });
    this._rubble(0, z + 12, { count: 6, spread: 4, scale: 1.4 });
    this._barrels(-5, z + 4, { count: 2 });
  }

  /** The keep: hollow, roofless, with a stair up the outside. */
  _keep() {
    const cz = -18;
    const height = 24;
    const t = 2.5;

    // Shell. The west wall came down long ago and is left as a jagged stub.
    this.addBox(8.75, height / 2, cz, t, height, 20, { surface: 'stone' });          // east
    this.addBox(0, height / 2, cz - 8.75, 20, height, t, { surface: 'stone' });      // north
    this.addBox(-8.75, 8, cz, t, 16, 20, { surface: 'stone' });                      // west (fallen)
    this.addBox(-8.75, 17, cz - 6, t, 3, 8, { surface: 'stone', rot: { x: 0.06 } }); // jagged remnant
    this.addBox(-8.75, 19.5, cz - 8, t, 4, 4, { surface: 'stone' });

    // South face with a doorway.
    this.addBox(-6.5, height / 2, cz + 8.75, 7, height, t, { surface: 'stone' });
    this.addBox(6.5, height / 2, cz + 8.75, 7, height, t, { surface: 'stone' });
    this.addBox(0, 17.5, cz + 8.75, 6, 13, t, { surface: 'stone' });                 // above the door
    this._arch(0, 0, cz + 8.75 - 1.6, { width: 5, height: 9, depth: 1.6, pier: 1.4 });

    // Crenellated top where the walls still stand.
    this._crenellations(0, height, cz - 8.75, 20, 'x', { ruin: 0.3, depth: 2 });
    this._crenellations(8.75, height, cz, 20, 'z', { ruin: 0.3, depth: 2 });

    // Half a first floor, collapsed in the middle — you can drop through.
    const floorY = 10;
    this.addBox(0, floorY, cz - 6.5, 16, 0.8, 4, { surface: 'floor', tile: 3 });
    this.addBox(-6, floorY, cz + 1, 4, 0.8, 11, { surface: 'floor', tile: 3 });
    this.addBox(5.5, floorY, cz + 5.5, 6, 0.8, 6, { surface: 'floor', tile: 3, rot: { z: -0.05 } });
    this._rubble(2, cz - 1, { count: 8, spread: 4, scale: 1.4 });

    // Fallen roof beams, propped across the interior.
    this.addBox(-2, 15.5, cz - 3, 18, 0.9, 0.9, { surface: 'timber', rot: { z: 0.22, y: 0.1 }, tile: 2 });
    this.addBox(3, 13.5, cz + 3, 16, 0.8, 0.8, { surface: 'timber', rot: { z: -0.3, y: -0.25 }, tile: 2 });

    // Outside stair hugging the east wall, up to the wall head.
    this._stairs(11.5, 0, cz + 9, { x: 0, z: -1 }, { steps: 12, rise: 1.4, run: 1.5, width: 4.5 });
    this.addBox(11.5, 17, cz - 12, 4.5, 1, 8, { surface: 'floor', tile: 3 });

    this._banner(-3.4, 21, cz + 10.2, { width: 2.6, height: 8 });
    this._banner(3.4, 21, cz + 10.2, { width: 2.6, height: 8, surface: 'bannerBlue' });
    this._torch(-4, 6.5, cz + 10.4, { dir: { x: 0, z: -1 } });
    this._torch(4, 6.5, cz + 10.4, { dir: { x: 0, z: -1 }, lit: false });
    this._rubble(-11, cz + 2, { count: 9, spread: 4, scale: 1.7 });
  }

  /** Roofless great hall: two rows of columns, fallen beams, a broken throne. */
  _greatHall() {
    const rows = [-27, -15];
    const heights = [[12, 12, 8.5, 4], [12, 6.5, 12, 3]];
    const zs = [-6, 0, 6, 12];
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < zs.length; i++) {
        const h = heights[r][i];
        this._column(rows[r], zs[i], h, { broken: h < 9 });
      }
    }

    // Beams that survived, spanning the two rows.
    this.addBox(-21, 13.6, -6, 14, 0.9, 0.9, { surface: 'timber', tile: 2 });
    this.addBox(-21, 13.6, 0, 14, 0.9, 0.9, { surface: 'timber', tile: 2 });
    this.addBox(-19, 11.5, 6.5, 12, 0.9, 0.9, { surface: 'timber', rot: { z: 0.28, y: 0.12 }, tile: 2 });

    // One column has come down across the floor.
    this.addBox(-21, 1.2, 9.5, 11, 2.2, 2.2, { surface: 'stone', rot: { z: Math.PI / 2, y: 0.22 } });
    this._rubble(-25, 10, { count: 6, spread: 2.5, scale: 1.3 });

    // Dais and a broken throne at the head of the hall.
    this.addBox(-30, 0.75, 3, 8, 1.5, 12, { surface: 'stone' });
    this.addBox(-31, 2.6, 3, 3, 2.2, 3.4, { surface: 'stoneWarm' });
    this.addBox(-32.2, 4.4, 3, 0.8, 3.4, 3.4, { surface: 'stoneWarm', rot: { z: 0.1 } });
    this.addBox(-29.6, 3.9, 3, 1.6, 0.5, 1.6, { surface: 'gold', tile: 0, rot: { y: 0.4, z: 0.2 } });

    this._chandelier(-21, 13.2, -6, { radius: 2.4, drop: 0.4 });
    this._chandelier(-21, 13.2, 0, { radius: 2.4, drop: 0.4, lit: false });
    this._torch(-27, 7, -8.4, { dir: { x: 0, z: -1 }, lit: false });
    this._torch(-15, 7, 14, { dir: { x: 0, z: 1 }, lit: false });

    // Scaffolding someone abandoned against the west wall.
    for (const [x, z] of [[-32, 16], [-32, 22], [-26, 16], [-26, 22]]) {
      this.addBox(x, 5.5, z, 0.6, 11, 0.6, { surface: 'timber', tile: 1.5 });
    }
    this.addBox(-29, 5.6, 19, 7.5, 0.5, 7.5, { surface: 'timber', tile: 2 });
    this.addBox(-29, 11.2, 19, 7.5, 0.5, 7.5, { surface: 'timber', tile: 2 });
    this.addBox(-29, 8.4, 15.4, 7.5, 0.4, 0.4, { surface: 'timber', tile: 1.5, solid: false });
  }

  /** The pit: cages on chains, a grate half over it, and a stair down. */
  _dungeon() {
    // Grate over the western half of the pit — you can walk out over the drop.
    for (let i = 0; i < 8; i++) {
      this.addBox(15.5 + i * 0.9, 0.1, 14, 0.35, 0.35, 13, { surface: 'iron', tile: 1 });
    }
    this.addBox(19, 0.1, 8.2, 8, 0.4, 0.4, { surface: 'iron', tile: 1 });
    this.addBox(19, 0.1, 19.8, 8, 0.4, 0.4, { surface: 'iron', tile: 1 });

    // Gibbet beam over the pit with two cages hanging from it.
    this.addBox(20, 13, 14, 1, 1, 16, { surface: 'timber', tile: 2 });
    this.addBox(20, 9, 10, 0.8, 8, 0.8, { surface: 'timber', tile: 2, solid: false });
    this._cage(20, 6.5, 17.5, { chain: 5.5 });
    this._cage(23.5, 8.5, 11, { size: 2, height: 2.6, chain: 3.5 });

    // Steps down into the dark.
    this._stairs(26, -6, 10, { x: -1, z: 0 }, { steps: 6, rise: 1.15, run: 1.3, width: 4, surface: 'stoneDark' });
    this._rubble(17, 17, { count: 7, spread: 3, scale: 1.2, y: -7 });
    this._torch(26.2, -3, 17, { dir: { x: 1, z: 0 } });
    this._brazier(24, 24);

    // A leaning tower of crates against the east wall — climbable.
    this.addBox(30, 2, 4, 4, 4, 4, { surface: 'timber', rot: { y: 0.2 }, tile: 2 });
    this.addBox(30.4, 5.6, 4.4, 3.6, 3.6, 3.6, { surface: 'timber', rot: { y: -0.35, z: 0.06 }, tile: 2 });
    this.addBox(29.6, 8.6, 3.6, 3, 3, 3, { surface: 'timber', rot: { y: 0.6, z: -0.1 }, tile: 2 });
  }

  /** The bailey itself: well, braziers, the toppled king, and a wrecked cart. */
  _courtyard() {
    // Dry well.
    this.addBox(9, 0.9, 17, 5, 1.8, 1, { surface: 'stone' });
    this.addBox(9, 0.9, 21, 5, 1.8, 1, { surface: 'stone' });
    this.addBox(7, 0.9, 19, 1, 1.8, 5, { surface: 'stone' });
    this.addBox(11, 0.9, 19, 1, 1.8, 5, { surface: 'stone' });
    this.addBox(7.2, 4, 19, 0.5, 5, 0.5, { surface: 'timber', tile: 1 });
    this.addBox(10.8, 4, 19, 0.5, 5, 0.5, { surface: 'timber', tile: 1 });
    this.addBox(9, 6.4, 19, 5, 0.6, 3.4, { surface: 'timber', rot: { z: 0.05 }, tile: 2 });
    this.addBox(9, 5.4, 19, 1.6, 1.2, 1.6, { surface: 'timber', tile: 1.2 });

    this._statue(-9, 20, 0.3);
    this._brazier(-4, 12);
    this._brazier(14, -2, { lit: false });
    this._barrels(17, 27, { count: 5 });
    this._barrels(-16, 27, { count: 3 });

    // Wrecked cart by the gate.
    this.addBox(3, 1.4, 27, 5, 0.6, 2.6, { surface: 'timber', rot: { z: 0.18, y: 0.4 }, tile: 2 });
    this.addBox(1.2, 0.9, 26.2, 0.5, 2.4, 2.4, { surface: 'timber', rot: { y: 0.4, x: 0.5 }, tile: 1.5 });
    this.addBox(5.4, 1.5, 28.2, 0.5, 2.4, 2.4, { surface: 'timber', rot: { y: 0.4 }, tile: 1.5 });
    this.addBox(6.5, 2.4, 26, 3.4, 0.4, 0.4, { surface: 'timber', rot: { y: 0.4, z: -0.3 }, tile: 1.5 });

    // Moss and puddle-friendly low ledges scattered through the bailey.
    this._rubble(-2, 6, { count: 5, spread: 3.5, scale: 1.4 });
    this._rubble(20, -14, { count: 6, spread: 4, scale: 1.6 });
    this.addBox(-6, 0.5, -2, 7, 1, 5, { surface: 'moss', tile: 3 });
    this.addBox(16, 0.4, 24, 6, 0.8, 5, { surface: 'moss', tile: 3, rot: { y: 0.3 } });

    // A broken walkway spanning the bailey — the gap is the point.
    this.addBox(-13, 12, -8, 3.5, 0.7, 12, { surface: 'floor', tile: 3 });
    this.addBox(-13, 12, 6, 3.5, 0.7, 8, { surface: 'floor', tile: 3 });
    this.addBox(-13, 11.6, 12, 3.5, 0.7, 4, { surface: 'floor', tile: 3, rot: { x: 0.18 } });
    this._rubble(-13, 1, { count: 5, spread: 2.5, scale: 1.5 });
  }

  /** Merge each material's blocks into a single mesh. */
  _commit() {
    for (const [key, geometries] of this._buckets) {
      const [surface, flag] = key.split(':');
      const material = this.materials[surface];
      if (!material || geometries.length === 0) continue;
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = flag !== 'noshadow';
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    this._buckets.clear();
  }

  /**
   * Uniform grid over the arena floor. A level with several hundred blocks
   * would otherwise mean a few hundred tests per particle per substep; this
   * cuts it to the handful of blocks actually near the point.
   */
  _buildGrid() {
    this.grid = new Map();
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const x0 = Math.floor((c.min.x - 0.5) / CELL);
      const x1 = Math.floor((c.max.x + 0.5) / CELL);
      const z0 = Math.floor((c.min.z - 0.5) / CELL);
      const z1 = Math.floor((c.max.z + 0.5) / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const key = gx * 73856093 ^ gz * 19349663;
          let cell = this.grid.get(key);
          if (!cell) this.grid.set(key, (cell = []));
          cell.push(c);
        }
      }
    }
  }

  _cellAt(x, z) {
    return this.grid.get((Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663));
  }

  /** Sphere contact against the level. Returns the deepest contact, or null. */
  collide(point, radius) {
    const cell = this._cellAt(point.x, point.z);
    if (!cell) return null;
    let best = null;
    let bestDepth = -Infinity;
    for (let i = 0; i < cell.length; i++) {
      const hit = cell[i].contact(point, radius, _contact);
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

  /** Torch flicker. Cheap, and it does more for the mood than anything else. */
  update(dt, elapsed) {
    for (const torch of this.torches) {
      const t = elapsed * torch.speed + torch.phase;
      const flicker = 0.72 + 0.28 * (Math.sin(t) * 0.5 + Math.sin(t * 2.7) * 0.3 + Math.sin(t * 6.1) * 0.2);
      torch.light.intensity = torch.intensity * flicker;
      if (torch.flame) torch.flame.scale.setScalar(0.85 + flicker * 0.3);
    }
  }
}

/**
 * BoxGeometry gives every face 0..1 UVs, so a texture would stretch across a
 * 60-unit wall the same as across a crate. Rescale per face pair by the world
 * size of that face, and one stone course is one stone course everywhere.
 */
function scaleBoxUVs(geometry, sx, sy, sz, tile) {
  const uv = geometry.attributes.uv;
  const spans = [
    [sz, sy], [sz, sy], // +x, -x
    [sx, sz], [sx, sz], // +y, -y
    [sx, sy], [sx, sy], // +z, -z
  ];
  for (let face = 0; face < 6; face++) {
    const [u, v] = spans[face];
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) * (u / tile), uv.getY(index) * (v / tile));
    }
  }
  uv.needsUpdate = true;
}
