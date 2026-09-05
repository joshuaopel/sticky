/**
 * Rough cost of one fixed simulation step (soft body + strands), so it is
 * obvious when a tuning change eats the frame budget.
 */
import * as THREE from 'three';
import { World } from '../src/world.js';
import { GooBlob } from '../src/blob.js';
import { GooGun } from '../src/strands.js';

const world = new World(new THREE.Scene());
const blob = new GooBlob(world, { position: new THREE.Vector3(0, 3, 20) });
const gun = new GooGun(world.scene, world, blob);
const input = { move: new THREE.Vector3(0, 0, -1), jump: false, cling: false };

for (let i = 0; i < 4; i++) {
  const dir = new THREE.Vector3(Math.sin(i * 1.7), 0.7, -1).normalize();
  gun.cooldown = 0;
  gun.shoot(blob.center.clone(), dir);
  for (let f = 0; f < 25; f++) { blob.update(1 / 60, input); gun.update(1 / 60); }
}
gun.reeling = true;

const frames = 600;
const start = performance.now();
for (let f = 0; f < frames; f++) { blob.update(1 / 60, input); gun.update(1 / 60); }
const ms = (performance.now() - start) / frames;

console.log(`particles ${blob.count}  constraints ${blob.edgeA.length}  strands ${gun.strandCount}`);
console.log(`sim step ${ms.toFixed(3)} ms  (${((ms / 16.6) * 100).toFixed(1)}% of a 60 fps frame)`);
