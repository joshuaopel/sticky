/**
 * Headless physics checks. No WebGL: the simulation is plain math over typed
 * arrays, so it runs in node and we can assert that the blob stays stable,
 * lands on surfaces, and that strands actually haul it around.
 */
import * as THREE from 'three';
import { World } from '../src/world.js';
import { GooBlob } from '../src/blob.js';
import { GooGun } from '../src/strands.js';
import { PuddleField } from '../src/puddles.js';

let failures = 0;
function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

const scene = new THREE.Scene();
const world = new World(scene);
const blob = new GooBlob(world, { position: new THREE.Vector3(0, 8, 16) });
const puddles = new PuddleField(scene, world);
const gun = new GooGun(scene, world, blob, puddles);

const DT = 1 / 60;
const idle = { move: new THREE.Vector3(), jump: false, cling: false };

function run(frames, input = idle, absorb = false) {
  for (let i = 0; i < frames; i++) {
    blob.update(DT, input);
    gun.update(DT);
    if (absorb) {
      const gained = puddles.collect(blob.center, blob.radius);
      if (gained > 0) blob.addGoo(gained);
    }
    puddles.update(DT, blob.center);
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

// --- 3b. analog throttle ---------------------------------------------------
// A stick pushed half way should move you at about half pace; before this the
// input was normalised and every touch meant full speed.
{
  const distanceFor = (throttle) => {
    const test = new GooBlob(world, { position: new THREE.Vector3(0, 3, 24) });
    for (let i = 0; i < 60; i++) test.update(DT, idle);
    const start = test.center.clone();
    const move = new THREE.Vector3(0, 0, -throttle);
    for (let i = 0; i < 90; i++) test.update(DT, { move, jump: false, cling: false });
    return test.center.distanceTo(start);
  };
  const full = distanceFor(1);
  const half = distanceFor(0.5);
  const nudge = distanceFor(0.2);
  check('a half-pushed stick travels less than a full one', half < full * 0.8,
    `${half.toFixed(1)}m vs ${full.toFixed(1)}m`);
  check('a light push still moves, slowly', nudge > 0.3 && nudge < half,
    `${nudge.toFixed(1)}m`);
  check('the throttle is ordered', nudge < half && half < full);
}

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
  const high = new THREE.Vector3(0, 20, -9.25); // high on the keep's south face
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
blob.reset(new THREE.Vector3(-13, 4, -8));
run(30);
{
  const anchor = new THREE.Vector3(-13, 11.6, -8); // underside of the broken walkway
  const dir = anchor.clone().sub(blob.center).normalize();
  gun.cooldown = 0;
  gun.shoot(blob.center.clone().addScaledVector(dir, 1.3), dir);
  run(20);
  check('strand attaches to the high platform', gun.strandCount === 1);
  if (gun.strandCount === 1) {
    const strand = gun.strands[0];
    // Winch up first, then let go and swing — the way you actually travel.
    gun.reeling = true;
    run(45);
    gun.reeling = false;
    check('the winch hoists you up to the anchor', blob.center.y > 5, `y=${blob.center.y.toFixed(2)}`);
    blob.applyImpulse(new THREE.Vector3(1, 0, 0), 12); // kick sideways
    let maxOverstretch = 0;
    let lowest = Infinity;
    let maxSwing = 0;
    for (let i = 0; i < 120; i++) {
      run(1);
      maxOverstretch = Math.max(maxOverstretch, blob.center.distanceTo(strand.anchor) - strand.length);
      lowest = Math.min(lowest, blob.center.y);
      // A pendulum comes back, so measure how far it got, not where it ended.
      maxSwing = Math.max(maxSwing, Math.abs(blob.center.x + 13));
    }
    check('the rope does not stretch', maxOverstretch < 1.2, `overstretch=${maxOverstretch.toFixed(2)}`);
    check('swinging keeps the blob off the floor', lowest > 3, `lowest y=${lowest.toFixed(2)}`);
    check('the blob swings across', maxSwing > 1.5, `swing=${maxSwing.toFixed(2)}m`);
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

// --- 8. the goo economy ----------------------------------------------------
gun.cutAll();
puddles.clear();
blob.reset(new THREE.Vector3(0, 3, 22));
run(60);
{
  const fullRadius = blob.radius;
  check('a fresh blob is full', Math.abs(blob.goo - 1) < 1e-9 && Math.abs(blob.scale - 1) < 1e-9);

  const before = blob.goo;
  const dir = new THREE.Vector3(0, 0.4, -1).normalize();
  gun.cooldown = 0;
  const fired = gun.shoot(blob.center.clone().addScaledVector(dir, 1.3), dir);
  check('firing a strand spends goo', fired && blob.goo < before - 0.05 + 1e-9,
    `${before.toFixed(3)} -> ${blob.goo.toFixed(3)}`);

  run(90);
  check('spending goo shrinks the body', blob.radius < fullRadius - 0.01,
    `${fullRadius.toFixed(3)} -> ${blob.radius.toFixed(3)}`);
  check('radius tracks the cube root of mass', Math.abs(blob.scale - Math.cbrt(blob.goo)) < 0.02,
    `scale=${blob.scale.toFixed(3)} cbrt=${Math.cbrt(blob.goo).toFixed(3)}`);
  check('rest lengths scale with the body', Math.abs(blob.edgeRest[0] / blob.baseEdgeRest[0] - blob.scale) < 1e-5);
  check('a shrunken blob still rests on the floor', Math.abs(blob.center.y - blob.radius) < 0.6,
    `y=${blob.center.y.toFixed(2)} r=${blob.radius.toFixed(2)}`);
  check('shrinking keeps the sim finite', finite());

  // Drain it dry.
  let shots = 0;
  while (blob.canSpend(blob.shotCost) && shots < 100) {
    gun.cooldown = 0;
    if (gun.shoot(blob.center.clone().addScaledVector(dir, 1.3), dir)) shots++;
    run(2);
  }
  check('the gun runs dry near the minimum', blob.goo < blob.minGoo + blob.shotCost,
    `goo=${blob.goo.toFixed(3)} after ${shots} shots`);
  gun.cooldown = 0;
  check('a dry gun refuses to fire', gun.shoot(blob.center.clone(), dir) === false);
  run(120);
  check('an empty blob is visibly smaller', blob.scale < 0.75, `scale=${blob.scale.toFixed(3)}`);

  // Feed it a puddle.
  const drained = blob.goo;
  const drainedRadius = blob.radius;
  const meal = puddles.spawn(blob.center.clone().setY(0.02), new THREE.Vector3(0, 1, 0), 0.25);
  meal.spread = 1;
  run(90, idle, true);
  check('rolling over a puddle takes the goo back', blob.goo > drained + 0.2,
    `${drained.toFixed(3)} -> ${blob.goo.toFixed(3)}`);
  check('absorbing goo grows the body', blob.radius > drainedRadius + 0.01,
    `${drainedRadius.toFixed(3)} -> ${blob.radius.toFixed(3)}`);
  check('the absorbed puddle is gone', !puddles.puddles.includes(meal));
  check('growing keeps the sim finite', finite());

  blob.addGoo(99);
  check('goo is capped', blob.goo === blob.maxGoo);
}

// --- 9. puddle seeding -----------------------------------------------------
{
  const field = new PuddleField(scene, world);
  const placed = field.seed(20);
  check('the level seeds puddles onto surfaces', placed === 20, `placed=${placed}`);
  const airborne = field.puddles.filter((p) => {
    const hit = world.raycast(p.mesh.position.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, -1, 0), 2);
    return !hit;
  });
  check('seeded puddles sit on something', airborne.length === 0, `floating=${airborne.length}`);
}

// --- 10. the ruin ----------------------------------------------------------
{
  gun.cutAll();
  check('the level is built from a few hundred blocks', world.colliders.length > 200,
    `colliders=${world.colliders.length}`);
  check('the broadphase grid is populated', world.grid.size > 40, `cells=${world.grid.size}`);

  // Rubble piles are overlapping boxes — the one arrangement that can fight
  // the contact solver — so check the blob actually settles on one.
  blob.reset(new THREE.Vector3(-2, 9, 6));
  run(200);
  check('the blob settles on rubble instead of sinking or exploding',
    finite() && blob.center.y > 0.6 && blob.velocity.length() < 1.2,
    `y=${blob.center.y.toFixed(2)} |v|=${blob.velocity.length().toFixed(2)}`);

  // The spawn has to be somewhere you can actually stand.
  blob.reset(world.spawn);
  run(150);
  check('the spawn point is clear', finite() && Math.abs(blob.center.y - blob.radius) < 1.2,
    `y=${blob.center.y.toFixed(2)}`);
  check('the spawn is inside the walls',
    Math.abs(blob.center.x) < world.bounds && Math.abs(blob.center.z) < world.bounds);

  // Driving out of the front gate used to put you in empty space; there is a
  // causeway out there now.
  blob.reset(new THREE.Vector3(0, 3, 30));
  run(40);
  run(90, { move: new THREE.Vector3(0, 0, 1), jump: false, cling: false });
  check('the gate leads onto a causeway, not into the void',
    blob.center.z > 34 && blob.center.y > 0, `z=${blob.center.z.toFixed(1)} y=${blob.center.y.toFixed(2)}`);

  // Drive north out of the courtyard: the bailey should be walkable.
  blob.reset(world.spawn);
  run(60);
  const fromZ = blob.center.z;
  run(150, { move: new THREE.Vector3(0, 0, -1), jump: false, cling: false });
  check('the bailey is drivable', blob.center.z < fromZ - 6, `dz=${(blob.center.z - fromZ).toFixed(1)}`);
  check('driving over the ruin stays finite', finite());
}

// --- 11. raycast sanity ----------------------------------------------------
const hit = world.raycast(new THREE.Vector3(0, 3, 20), new THREE.Vector3(0, -1, 0), 20);
check('raycast finds the floor', hit && Math.abs(hit.point.y) < 0.05 && hit.normal.y > 0.9,
  hit ? `y=${hit.point.y.toFixed(3)}` : 'no hit');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
