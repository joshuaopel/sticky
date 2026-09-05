/**
 * Headless physics checks. No WebGL: the simulation is plain math over typed
 * arrays, so it runs in node and we can assert that the blob stays stable,
 * lands on surfaces, and that strands actually haul it around.
 */
import * as THREE from 'three';
import { World } from '../src/world.js';
import { GooBlob } from '../src/blob.js';
import { GooGun } from '../src/strands.js';

let failures = 0;
function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

const scene = new THREE.Scene();
const world = new World(scene);
const blob = new GooBlob(world, { position: new THREE.Vector3(0, 8, 16) });
const gun = new GooGun(scene, world, blob);

const DT = 1 / 60;
const idle = { move: new THREE.Vector3(), jump: false, cling: false };

function run(frames, input = idle) {
  for (let i = 0; i < frames; i++) {
    blob.update(DT, input);
    gun.update(DT);
  }
}

function finite() {
  for (let i = 0; i < blob.pos.length; i++) if (!Number.isFinite(blob.pos[i])) return false;
  return true;
}

// --- 1. free fall then rest ------------------------------------------------
run(240);
check('positions stay finite after a drop', finite());
check('blob settles on the floor', Math.abs(blob.center.y - blob.radius) < 0.6, `y=${blob.center.y.toFixed(3)}`);
check('blob comes to rest', blob.velocity.length() < 0.7, `|v|=${blob.velocity.length().toFixed(3)}`);
check('blob reports ground contact', blob.grounded);

// --- 2. volume preservation ------------------------------------------------
const volume = Math.abs(blob._volumeOf(blob.pos));
const ratio = volume / blob.restVolume;
check('volume is preserved within 25%', ratio > 0.75 && ratio < 1.25, `ratio=${ratio.toFixed(3)}`);
check('resting blob is squashed, not spherical', blob.squash < 1.0 && blob.squash > 0.5, `squash=${blob.squash.toFixed(3)}`);

// --- 3. locomotion ---------------------------------------------------------
const startZ = blob.center.z;
run(90, { move: new THREE.Vector3(0, 0, -1), jump: false, cling: false });
check('moves in the commanded direction', blob.center.z < startZ - 2, `dz=${(blob.center.z - startZ).toFixed(2)}`);
check('stays finite while driving', finite());

// --- 4. jumping ------------------------------------------------------------
run(60);
const restY = blob.center.y;
blob.update(DT, { move: new THREE.Vector3(), jump: true, cling: false });
run(14);
check('jump lifts the blob', blob.center.y > restY + 0.4, `dy=${(blob.center.y - restY).toFixed(2)}`);
run(150);

// --- 5. strands ------------------------------------------------------------
blob.reset(new THREE.Vector3(0, 3, 24));
run(60);
const target = new THREE.Vector3(0, 13, -2.2); // the central tower's upper face
const dir = target.clone().sub(blob.center).normalize();
gun.shoot(blob.center.clone().addScaledVector(dir, blob.radius), dir);
run(45);
check('projectile becomes a strand on impact', gun.strandCount === 1, `strands=${gun.strandCount}`);

if (gun.strandCount === 1) {
  const strand = gun.strands[0];
  check('strand is anchored to level geometry', strand.anchor.length() > 1);
  const before = blob.center.distanceTo(strand.anchor);
  gun.reeling = true;
  run(120);
  const after = blob.center.distanceTo(strand.anchor);
  check('reeling hauls the blob toward the anchor', after < before - 1.5, `${before.toFixed(2)} -> ${after.toFixed(2)}`);
  check('reeling keeps the sim finite', finite());
  check('strand rope length shrinks', strand.length < strand.initialLength);

  // A winch shot at a high anchor should get you off the ground.
  blob.reset(new THREE.Vector3(0, 2, 26));
  run(40);
  gun.cutAll();
  run(10);
  const high = new THREE.Vector3(0, 14.3, -2);
  const upDir = high.clone().sub(blob.center).normalize();
  gun.cooldown = 0;
  gun.shoot(blob.center.clone().addScaledVector(upDir, 1.3), upDir);
  run(40);
  gun.reeling = true;
  let peak = blob.center.y;
  for (let i = 0; i < 150; i++) { run(1); peak = Math.max(peak, blob.center.y); }
  check('reeling on a high anchor lifts the blob off the floor', peak > 5, `peak y=${peak.toFixed(2)}`);
  check('winch keeps the sim finite', finite());

  gun.reeling = false;
  gun.cutAll();
  run(30);
  check('cutting removes the strand', gun.strandCount === 0);
}

// --- 5b. swinging ----------------------------------------------------------
gun.cutAll();
blob.reset(new THREE.Vector3(9, 12, 8));
run(5);
{
  const anchor = new THREE.Vector3(0, 21.4, 8); // underside of the high platform
  const dir = anchor.clone().sub(blob.center).normalize();
  gun.cooldown = 0;
  gun.shoot(blob.center.clone().addScaledVector(dir, 1.3), dir);
  run(20);
  check('strand attaches to the high platform', gun.strandCount === 1);
  if (gun.strandCount === 1) {
    const strand = gun.strands[0];
    blob.applyImpulse(new THREE.Vector3(-1, 0, 0), 14); // kick sideways
    let maxOverstretch = 0;
    let lowest = Infinity;
    for (let i = 0; i < 120; i++) {
      run(1);
      maxOverstretch = Math.max(maxOverstretch, blob.center.distanceTo(strand.anchor) - strand.length);
      lowest = Math.min(lowest, blob.center.y);
    }
    check('the rope does not stretch', maxOverstretch < 1.2, `overstretch=${maxOverstretch.toFixed(2)}`);
    check('swinging keeps the blob off the floor', lowest > 4, `lowest y=${lowest.toFixed(2)}`);
    check('the blob swings across', blob.center.x < 4, `x=${blob.center.x.toFixed(2)}`);
  }
  gun.cutAll();
  run(30);
}

// --- 6. clinging -----------------------------------------------------------
blob.reset(new THREE.Vector3(-31, 6, 0)); // next to the west wall
run(30, { move: new THREE.Vector3(-1, 0, 0), jump: false, cling: true });
const clingY = blob.center.y;
run(120, { move: new THREE.Vector3(-1, 0, 0), jump: false, cling: true });
check('clinging resists sliding down a wall', blob.center.y > clingY - 1.2, `dy=${(blob.center.y - clingY).toFixed(2)}`);

const freeBlob = new GooBlob(world, { position: new THREE.Vector3(-31, 6, 0) });
for (let i = 0; i < 150; i++) freeBlob.update(DT, { move: new THREE.Vector3(-1, 0, 0), jump: false, cling: false });
check('without cling it falls instead', freeBlob.center.y < blob.center.y - 0.5,
  `cling=${blob.center.y.toFixed(2)} free=${freeBlob.center.y.toFixed(2)}`);

// --- 7. no tunnelling at speed --------------------------------------------
blob.reset(new THREE.Vector3(0, 26, 20));
blob.addVelocity(0, -0.45, 0); // slammed downward
run(200);
check('a fast drop does not tunnel through the floor', blob.center.y > 0.4, `y=${blob.center.y.toFixed(2)}`);

// --- 8. raycast sanity -----------------------------------------------------
const hit = world.raycast(new THREE.Vector3(0, 3, 20), new THREE.Vector3(0, -1, 0), 20);
check('raycast finds the floor', hit && Math.abs(hit.point.y) < 0.05 && hit.normal.y > 0.9,
  hit ? `y=${hit.point.y.toFixed(3)}` : 'no hit');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
