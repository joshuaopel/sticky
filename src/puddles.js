import * as THREE from 'three';

const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _point = new THREE.Vector3();
const _toBlob = new THREE.Vector3();

/**
 * Every drop of goo the blob loses lands somewhere as a puddle, and every
 * puddle can be soaked back up by rolling over it. That is the whole economy:
 * shooting strands costs mass and makes you smaller, puddles give it back.
 */
export class PuddleField {
  constructor(scene, world, options = {}) {
    this.scene = scene;
    this.world = world;
    this.max = options.max ?? 90;
    this.puddles = [];

    this.geometry = new THREE.SphereGeometry(1, 12, 8);
    this.material = new THREE.MeshPhysicalMaterial({
      color: 0x86d81a,
      roughness: 0.12,
      metalness: 0,
      transmission: 0.55,
      thickness: 0.5,
      ior: 1.33,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      attenuationColor: new THREE.Color(0x2f7a06),
      attenuationDistance: 0.6,
      emissive: new THREE.Color(0x24450a),
      emissiveIntensity: 0.8,
    });

    // Deterministic scatter, so the level is the same every run (and testable).
    this._seed = 1337;
  }

  get count() {
    return this.puddles.length;
  }

  /** Total goo lying on the ground. */
  get total() {
    let sum = 0;
    for (const p of this.puddles) if (!p.absorbing) sum += p.amount;
    return sum;
  }

  _random() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 0x100000000;
  }

  spawn(point, normal, amount) {
    if (amount <= 0) return null;
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.position.copy(point).addScaledVector(normal, 0.03);
    mesh.quaternion.setFromUnitVectors(_up, normal);
    mesh.rotateY(this._random() * Math.PI * 2);
    mesh.receiveShadow = true;

    const puddle = {
      mesh,
      amount,
      normal: normal.clone(),
      // A puddle spreads as it lands rather than popping into place.
      spread: 0,
      wobble: this._random() * Math.PI * 2,
      absorbing: false,
    };
    this._resize(puddle);
    this.scene.add(mesh);
    this.puddles.push(puddle);

    // Oldest puddles evaporate once the level is littered with them.
    while (this.puddles.length > this.max) {
      const old = this.puddles.find((p) => !p.absorbing) || this.puddles[0];
      this._remove(old);
    }
    return puddle;
  }

  _resize(puddle) {
    // Radius from amount: a puddle is a splat, so it spreads wide and stays flat.
    const radius = (0.5 + Math.sqrt(puddle.amount) * 2.4) * puddle.spread;
    puddle.mesh.scale.set(radius, radius * 0.22, radius * (0.85 + 0.3 * Math.sin(puddle.wobble)));
    puddle.mesh.visible = radius > 0.01;
  }

  /** Scatter starting goo across whatever surfaces the level has. */
  seed(count = 26, amount = 0.06) {
    const reach = this.world.bounds - 4;
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 12) {
      attempts++;
      const x = (this._random() * 2 - 1) * reach;
      const z = (this._random() * 2 - 1) * reach;
      const hit = this.world.raycast(_point.set(x, 30, z), _down, 60);
      if (!hit || hit.normal.y < 0.7) continue;
      const puddle = this.spawn(hit.point, hit.normal, amount);
      if (puddle) {
        puddle.spread = 1; // already settled when the level loads
        this._resize(puddle);
        placed++;
      }
    }
    return placed;
  }

  /**
   * Soak up anything the blob is touching.
   * @returns {number} goo absorbed this step.
   */
  collect(center, radius) {
    let gained = 0;
    for (const puddle of this.puddles) {
      if (puddle.absorbing || puddle.spread < 0.6) continue;
      _toBlob.subVectors(center, puddle.mesh.position);
      const reach = radius + 0.4 + Math.sqrt(puddle.amount) * 1.6;
      if (_toBlob.lengthSq() > reach * reach) continue;
      puddle.absorbing = true;
      gained += puddle.amount;
    }
    return gained;
  }

  update(dt, blobCenter) {
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const puddle = this.puddles[i];
      if (puddle.absorbing) {
        // Slurp: the puddle shrinks and creeps toward whatever ate it.
        puddle.spread -= dt * 3.2;
        if (blobCenter) puddle.mesh.position.lerp(blobCenter, dt * 3.5);
        if (puddle.spread <= 0) {
          this._remove(puddle);
          continue;
        }
      } else if (puddle.spread < 1) {
        puddle.spread = Math.min(1, puddle.spread + dt * 4);
      }
      this._resize(puddle);
    }
  }

  _remove(puddle) {
    const index = this.puddles.indexOf(puddle);
    if (index >= 0) this.puddles.splice(index, 1);
    this.scene.remove(puddle.mesh);
  }

  clear() {
    for (const puddle of this.puddles) this.scene.remove(puddle.mesh);
    this.puddles.length = 0;
  }
}
