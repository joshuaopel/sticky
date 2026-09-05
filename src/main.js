import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { World } from './world.js';
import { GooBlob } from './blob.js';
import { GooGun } from './strands.js';
import { Controls } from './controls.js';

const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2734);
scene.fog = new THREE.Fog(0x203040, 55, 165);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, 6, 26);

// Environment map — the goo reads as wet only if it has something to reflect.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const hemi = new THREE.HemisphereLight(0x86a4c8, 0x1a2410, 0.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d5, 2.1);
sun.position.set(26, 42, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.camera.left = -46;
sun.shadow.camera.right = 46;
sun.shadow.camera.top = 46;
sun.shadow.camera.bottom = -46;
sun.shadow.bias = -0.0009;
sun.shadow.normalBias = 0.03;
scene.add(sun);

const rim = new THREE.DirectionalLight(0x7ad6ff, 0.6);
rim.position.set(-20, 14, -26);
scene.add(rim);

// Gradient dome so the arena has a sky instead of a void above the walls.
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(220, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x35507a) },
      bottom: { value: new THREE.Color(0x2b3d2a) },
      horizon: { value: new THREE.Color(0x5b7899) },
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
      void main() {
        float h = normalize(vPos).y;
        vec3 c = mix(horizon, top, smoothstep(0.0, 0.55, h));
        c = mix(c, bottom, smoothstep(0.0, -0.35, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
);
sky.frustumCulled = false;
scene.add(sky);

const world = new World(scene);
const blob = new GooBlob(world, { position: world.spawn.clone() });
scene.add(blob.mesh);

const gun = new GooGun(scene, world, blob);
blob.onSplat = (x, y, z, normal) => {
  if (Math.random() < 0.25) gun.addSplat(new THREE.Vector3(x, y, z), normal, 0.5);
};

const controls = new Controls(camera, canvas, world);
controls.target.copy(blob.center);

// A soft glow that rides along with the blob, so it lights the goo it lands on.
const blobLight = new THREE.PointLight(0xa8ff3c, 6, 14, 2);
scene.add(blobLight);

// ---------------------------------------------------------------- boot ----
const overlay = document.getElementById('overlay');
document.getElementById('start').addEventListener('click', () => controls.requestLock());
overlay.addEventListener('click', () => controls.requestLock());

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
  squash: document.getElementById('hud-squash'),
};

function fire() {
  controls.aimPoint(aimPoint);
  shotDir.subVectors(aimPoint, blob.center).normalize();
  blob.particle(blob.nearestParticle(shotDir), muzzle);
  shotDir.subVectors(aimPoint, muzzle).normalize();
  gun.shoot(muzzle.clone().addScaledVector(shotDir, 0.1), shotDir);
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

  blob.update(dt, {
    move: input.move || (controls.locked ? controls.moveDirection() : controls.move.set(0, 0, 0)),
    jump: input.jump,
    cling: input.cling ?? controls.clinging,
  });
  gun.update(dt);

  if (blob.center.y < -14) {
    gun.cutAll();
    blob.reset(world.spawn);
  }
}

function render(dt) {
  const speed = blob.velocity.length();
  controls.update(dt, blob.center, speed, blob.contacts > 0 ? blob.contactNormal : null);
  const camDistance = camera.position.distanceTo(blob.center);
  blob.setViewFade(THREE.MathUtils.clamp((camDistance - blob.radius * 0.9) / (blob.radius * 1.3), 0, 1));
  blobLight.position.copy(blob.center);
  blobLight.intensity = 5 + Math.min(speed, 16) * 0.25;
  renderer.render(scene, camera);
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
    hud.squash.textContent = blob.squash.toFixed(2);
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Debug handle: poke at the simulation from the console, e.g.
//   sticky.blob.pressure = 14000
//   sticky.paused = true            // freeze physics, keep rendering
//   sticky.step(60)                 // advance 60 fixed frames by hand
window.sticky = {
  scene, camera, renderer, world, blob, gun, controls,
  paused: false,
  step: (frames = 1, input) => {
    for (let i = 0; i < frames; i++) step(FIXED, input);
  },
};
window.__stickyBooted = true;
tick();
