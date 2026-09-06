import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { World } from './world.js';
import { GooBlob } from './blob.js';
import { GooGun } from './strands.js';
import { PuddleField } from './puddles.js';
import { Controls } from './controls.js';
import { detectQuality } from './quality.js';
import { setupTouch } from './touch.js';

const quality = detectQuality();
document.body.classList.toggle('touch', quality.isTouch);

const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(quality.pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1119);
scene.fog = new THREE.FogExp2(0x121a26, 0.011);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, 6, 26);

// Environment map — the goo reads as wet only if it has something to reflect.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.32; // the ruin is lit by torches, not a studio

const hemi = new THREE.HemisphereLight(0x33507e, 0x140f0a, 0.42);
scene.add(hemi);

// Moonlight: cold, low and raking, so the blocks throw long shadows.
const sun = new THREE.DirectionalLight(0xbcd2ff, 1.15);
sun.position.set(26, 42, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.camera.left = -46;
sun.shadow.camera.right = 46;
sun.shadow.camera.top = 46;
sun.shadow.camera.bottom = -46;
sun.shadow.bias = -0.0009;
sun.shadow.normalBias = 0.03;
scene.add(sun);

const rim = new THREE.DirectionalLight(0x5c7ba8, 0.32);
rim.position.set(-20, 14, -26);
scene.add(rim);

// Gradient dome so the arena has a sky instead of a void above the walls.
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(220, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x0a1224) },
      bottom: { value: new THREE.Color(0x141a16) },
      horizon: { value: new THREE.Color(0x2b3d5c) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 top;
      uniform vec3 bottom;
      uniform vec3 horizon;
      // Cheap hash, used only for stars.
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        vec3 dir = normalize(vPos);
        vec3 c = mix(horizon, top, smoothstep(0.0, 0.55, dir.y));
        c = mix(c, bottom, smoothstep(0.0, -0.35, dir.y));

        // Stars, thinning out toward the horizon.
        vec2 cell = floor(dir.xz * 140.0 / max(dir.y, 0.25));
        float star = step(0.9965, hash(cell));
        c += star * smoothstep(0.05, 0.5, dir.y) * vec3(0.8, 0.85, 1.0);

        // A low moon to match where the directional light comes from.
        float moon = smoothstep(0.995, 0.9985, dot(dir, normalize(vec3(0.5, 0.72, 0.34))));
        c += moon * vec3(0.85, 0.9, 1.0);
        c += pow(max(dot(dir, normalize(vec3(0.5, 0.72, 0.34))), 0.0), 48.0) * vec3(0.12, 0.16, 0.24);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
);
sky.frustumCulled = false;
scene.add(sky);

const world = new World(scene, { maxLights: quality.maxTorchLights });
const blob = new GooBlob(world, {
  position: world.spawn.clone(),
  detail: quality.blobDetail,
  material: { transmission: quality.transmission, opacity: quality.blobOpacity },
});
scene.add(blob.mesh);

const puddles = new PuddleField(scene, world, { transmission: quality.puddleTransmission });
puddles.seed();

if (quality.isTouch) {
  blob.moveAccel *= quality.moveAccel;
  blob.maxSpeed *= quality.maxSpeed;
}

const gun = new GooGun(scene, world, blob, puddles);

// Hard landings throw goo off the body and leave it on the floor.
const splatPoint = new THREE.Vector3();
let splatBudget = 0;
blob.onSplat = (x, y, z, normal, strength) => {
  if (splatBudget > 0) return;                 // one puddle per impact, not per particle
  const lost = blob.impactLoss * strength;
  if (!blob.spendGoo(lost)) return;
  splatBudget = 0.35;
  puddles.spawn(splatPoint.set(x, y, z), normal, lost);
};

const controls = new Controls(camera, canvas, world);
controls.target.copy(blob.center);

let elapsed = 0;

// Dust hanging in the air — nothing sells a ruin like something in the light.
const MOTES = quality.motes;
const motePositions = new Float32Array(MOTES * 3);
const moteSpeeds = new Float32Array(MOTES);
for (let i = 0; i < MOTES; i++) {
  motePositions[i * 3] = (Math.random() - 0.5) * 66;
  motePositions[i * 3 + 1] = Math.random() * 24;
  motePositions[i * 3 + 2] = (Math.random() - 0.5) * 66;
  moteSpeeds[i] = 0.15 + Math.random() * 0.5;
}
const moteGeometry = new THREE.BufferGeometry();
moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
const motes = new THREE.Points(
  moteGeometry,
  new THREE.PointsMaterial({
    color: 0xffd9a0,
    size: 0.09,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  })
);
motes.frustumCulled = false;
scene.add(motes);

function driftMotes(dt) {
  const array = moteGeometry.attributes.position.array;
  for (let i = 0; i < MOTES; i++) {
    const i3 = i * 3;
    array[i3 + 1] += moteSpeeds[i] * dt;
    array[i3] += Math.sin(elapsed * 0.4 + i) * dt * 0.12;
    if (array[i3 + 1] > 24) array[i3 + 1] = 0.2;   // recycle at the floor
  }
  moteGeometry.attributes.position.needsUpdate = true;
}

// A soft glow that rides along with the blob, so it lights the goo it lands on.
const blobLight = new THREE.PointLight(0xa8ff3c, 8, 16, 2);
scene.add(blobLight);

// ---------------------------------------------------------------- boot ----
const overlay = document.getElementById('overlay');
controls.isTouch = quality.isTouch;
document.getElementById('start').addEventListener('click', () => controls.start());
overlay.addEventListener('click', () => controls.start());

if (quality.isTouch) {
  setupTouch(controls, canvas, {
    stick: document.getElementById('stick'),
    knob: document.getElementById('stick-knob'),
    fire: document.getElementById('btn-fire'),
    jump: document.getElementById('btn-jump'),
    cut: document.getElementById('btn-cut'),
    cling: document.getElementById('btn-cling'),
    respawn: document.getElementById('btn-respawn'),
  });
}

// --------------------------------------------------------------- loop -----
const FIXED = 1 / 60;
const clock = new THREE.Clock();
let accumulator = 0;
let hudTimer = 0;

const aimPoint = new THREE.Vector3();
const muzzle = new THREE.Vector3();
const shotDir = new THREE.Vector3();

const hud = {
  strands: document.getElementById('hud-strands'),
  speed: document.getElementById('hud-speed'),
  state: document.getElementById('hud-state'),
  goo: document.getElementById('hud-goo'),
  gooBar: document.getElementById('hud-goo-bar'),
};

let dryFlash = 0;

function fire() {
  controls.aimPoint(aimPoint);
  shotDir.subVectors(aimPoint, blob.center).normalize();
  blob.particle(blob.nearestParticle(shotDir), muzzle);
  shotDir.subVectors(aimPoint, muzzle).normalize();
  // Out of goo: the gun coughs instead of firing, and the HUD says so.
  if (!gun.shoot(muzzle.clone().addScaledVector(shotDir, 0.1), shotDir)) dryFlash = 0.3;
}

function step(dt, override) {
  const input = override ? { ...controls.consume(), ...override } : controls.consume();

  if (input.fire) fire();
  if (input.cut) gun.cutAll();
  if (input.respawn) {
    gun.cutAll();
    blob.reset(world.spawn);
  }

  gun.reeling = input.fireHeld && gun.strandCount > 0;
  document.body.classList.toggle('reeling', gun.reeling);
  splatBudget = Math.max(0, splatBudget - dt);
  dryFlash = Math.max(0, dryFlash - dt);
  document.body.classList.toggle('dry', dryFlash > 0);

  blob.update(dt, {
    move: input.move || (controls.locked ? controls.moveDirection() : controls.move.set(0, 0, 0)),
    jump: input.jump,
    cling: input.cling ?? controls.clinging,
  });
  gun.viewPoint = camera.position;
  gun.update(dt);

  const gained = puddles.collect(blob.center, blob.radius);
  if (gained > 0) blob.addGoo(gained);
  puddles.update(dt, blob.center);

  if (blob.center.y < -14) {
    gun.cutAll();
    blob.reset(world.spawn);
  }
}

const BASE_CAMERA_DISTANCE = 7.2;

function render(dt) {
  elapsed += dt;
  world.update(dt, elapsed);
  driftMotes(dt);
  const speed = blob.velocity.length();
  // Pull in as the blob shrinks so a drained blob is still readable.
  controls.distance = BASE_CAMERA_DISTANCE * (0.55 + 0.45 * blob.scale);
  controls.update(dt, blob.center, speed, blob.contacts > 0 ? blob.contactNormal : null);
  const camDistance = camera.position.distanceTo(blob.center);
  blob.setViewFade(THREE.MathUtils.clamp((camDistance - blob.radius * 0.9) / (blob.radius * 1.3), 0, 1));
  blobLight.position.copy(blob.center);
  blobLight.intensity = 5 + Math.min(speed, 16) * 0.25;
  renderer.render(scene, camera);
}

/**
 * Everything runs at full quality until the device says otherwise. Frame time
 * is averaged over a couple of seconds — long enough that a shader compile or
 * a backgrounded tab cannot trigger it — and each time it comes back slow we
 * give up one more expensive thing, cheapest to look at first.
 */
const downgrades = [
  () => {
    renderer.setPixelRatio(Math.min(renderer.getPixelRatio(), 1));
    motes.visible = false;
    return 'resolution and dust';
  },
  () => {
    // Transmission is a second render of the whole scene; the rim carries the
    // goo on its own if it has to.
    for (const material of [blob.mesh.material, puddles.material]) {
      material.transmission = 0;
      material.needsUpdate = true;
    }
    blob.transmission = 0;
    blob.uniforms.uRimBoost.value = 1.7;
    return 'refraction';
  },
  () => {
    renderer.shadowMap.enabled = false;
    sun.castShadow = false;
    return 'shadows';
  },
];

let sampleFrames = 0;
let sampleTime = 0;
let stage = 0;

function measureFrames(frame) {
  if (stage >= downgrades.length || frame > 0.5) return;
  sampleFrames++;
  sampleTime += frame;
  if (sampleFrames < 150) return;
  const average = sampleTime / sampleFrames;
  sampleFrames = 0;
  sampleTime = 0;
  if (average < 0.030) return;                        // better than ~33 fps: leave it alone
  const gave = downgrades[stage++]();
  console.info(`[sticky] ${(1 / average).toFixed(0)} fps — dropped ${gave}`);
}

function tick() {
  requestAnimationFrame(tick);
  const frame = Math.min(clock.getDelta(), 0.1);
  accumulator += frame;

  let steps = 0;
  if (window.sticky.paused) {
    accumulator = 0;
  } else {
    while (accumulator >= FIXED && steps < 5) {
      step(FIXED);
      accumulator -= FIXED;
      steps++;
    }
    if (steps === 5) accumulator = 0; // never spiral on a slow frame
  }

  render(frame);

  measureFrames(frame);

  hudTimer += frame;
  if (hudTimer > 0.1) {
    hudTimer = 0;
    hud.strands.textContent = String(gun.strandCount);
    hud.speed.textContent = blob.velocity.length().toFixed(1);
    hud.state.textContent = controls.clinging && blob.grounded
      ? 'clinging'
      : gun.reeling
        ? 'reeling'
        : blob.grounded
          ? 'grounded'
          : 'airborne';
    hud.goo.textContent = `${Math.round(blob.goo * 100)}%`;
    hud.gooBar.style.width = `${Math.min(100, blob.goo * 100)}%`;
    hud.gooBar.classList.toggle('low', !blob.canSpend(blob.shotCost));
    hud.gooBar.classList.toggle('over', blob.goo > 1.001);
  }
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
// Rotating a phone fires orientationchange before the new size is readable.
addEventListener('orientationchange', () => setTimeout(resize, 120));
visualViewport?.addEventListener('resize', resize);

// Debug handle: poke at the simulation from the console, e.g.
//   sticky.blob.pressure = 14000
//   sticky.paused = true            // freeze physics, keep rendering
//   sticky.step(60)                 // advance 60 fixed frames by hand
window.sticky = {
  scene, camera, renderer, world, blob, gun, controls, puddles, quality,
  paused: false,
  step: (frames = 1, input) => {
    for (let i = 0; i < frames; i++) step(FIXED, input);
  },
};
window.__stickyBooted = true;
tick();
