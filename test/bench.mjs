/**
 * Rough cost of one fixed simulation step (soft body + strands), so it is
 * obvious when a tuning change eats the frame budget.
 */
import * as THREE from 'three';
import { World } from '../src/world.js';
import { GooBlob } from '../src/blob.js';
import { GooGun } from '../src/strands.js';
import { PuddleField } from '../src/puddles.js';

const world = new World(new THREE.Scene());
const blob = new GooBlob(world, { position: new THREE.Vector3(0, 3, 20) });
const puddles = new PuddleField(world.scene, world);
puddles.seed();
const gun = new GooGun(world.scene, world, blob, puddles);
const input = { move: new THREE.Vector3(0, 0, -1), jump: false, cling: false };

function step() {
  blob.update(1 / 60, input);
  gun.update(1 / 60);
  const gained = puddles.collect(blob.center, blob.radius);
  if (gained > 0) blob.addGoo(gained);
  puddles.update(1 / 60, blob.center);
}

// Hang four strands off the central tower — the heaviest normal case.
const targets = [
  new THREE.Vector3(-3, 14.2, -2.2),
  new THREE.Vector3(3, 14.2, -2.2),
  new THREE.Vector3(0, 14.2, -4),
  new THREE.Vector3(0, 13, -2.2),
];
for (const target of targets) {
  gun.cooldown = 0;
  const dir = target.clone().sub(blob.center).normalize();
  gun.shoot(blob.center.clone().addScaledVector(dir, 1.3), dir);
  for (let f = 0; f < 25; f++) step();
}
gun.reeling = true;

const frames = 600;
const start = performance.now();
for (let f = 0; f < frames; f++) step();
const ms = (performance.now() - start) / frames;

console.log(`particles ${blob.count}  constraints ${blob.edgeA.length}  strands ${gun.strandCount}  puddles ${puddles.count}`);
console.log(`sim step ${ms.toFixed(3)} ms  (${((ms / 16.6) * 100).toFixed(1)}% of a 60 fps frame)`);
