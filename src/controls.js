import * as THREE from 'three';

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _toCam = new THREE.Vector3();

/**
 * Third-person orbit camera + input. The camera hangs behind the blob on a
 * yaw/pitch arm, pulls in when the level is in the way, and widens its FOV
 * as you pick up speed.
 */
export class Controls {
  constructor(camera, domElement, world) {
    this.camera = camera;
    this.dom = domElement;
    this.world = world;

    this.yaw = Math.PI;
    this.pitch = 0.22;
    this.distance = 7.2;
    this.currentDistance = 7.2;
    this.sensitivity = 0.0022;

    this.keys = new Set();
    this.locked = false;
    this.isTouch = false;

    // Touch state: a stick vector in screen space plus a cling toggle.
    this.touch = { x: 0, y: 0 };
    this.touchCling = false;
    this.touchSensitivity = 0.0038;

    this.firePressed = false;
    this.fireHeld = false;
    this.cutPressed = false;
    this.jumpPressed = false;
    this.respawnPressed = false;

    this.move = new THREE.Vector3();
    this.aim = new THREE.Vector3(0, 0, -1);
    this.target = new THREE.Vector3();

    this._bind();
  }

  _bind() {
    const onMouseMove = (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - e.movementY * this.sensitivity,
        -0.9,
        1.15
      );
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      document.body.classList.toggle('playing', this.locked);
      if (!this.locked && !this.isTouch) {
        this.keys.clear();
        this.fireHeld = false;
      }
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.firePressed = true; this.fireHeld = true; }
      if (e.button === 2) this.cutPressed = true;
    });
    this.dom.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const code = e.code;
      this.keys.add(code);
      if (code === 'Space') { this.jumpPressed = true; e.preventDefault(); }
      if (code === 'KeyQ') this.cutPressed = true;
      if (code === 'KeyR') this.respawnPressed = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /**
   * Begin play. On a mouse the camera needs pointer lock; on touch there is
   * nothing to lock, so we just go — and ask for fullscreen and a landscape
   * lock, which is what makes a phone browser get out of the way.
   */
  start() {
    if (!this.isTouch) {
      this.dom.requestPointerLock();
      return;
    }
    this.locked = true;
    document.body.classList.add('playing');
    const root = document.documentElement;
    root.requestFullscreen?.().then(
      () => screen.orientation?.lock?.('landscape').catch(() => {}),
      () => {}
    );
  }

  get clinging() {
    return this.touchCling || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Camera-relative movement direction, flattened to the horizontal plane. */
  moveDirection(out = this.move) {
    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    out.set(0, 0, 0);
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) out.add(_forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) out.sub(_forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) out.add(_right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) out.sub(_right);
    // Stick: up the screen is away from the camera.
    if (this.touch.x || this.touch.y) {
      out.addScaledVector(_forward, -this.touch.y);
      out.addScaledVector(_right, this.touch.x);
    }
    // Clamp rather than normalise: a keyboard always asks for full speed, but
    // a half-pushed stick should mean half speed.
    const length = out.length();
    if (length > 1) out.divideScalar(length);
    return out;
  }

  /** Where the crosshair is pointing, resolved against the level. */
  aimPoint(out = new THREE.Vector3()) {
    this.camera.getWorldDirection(_forward);
    const hit = this.world.raycast(this.camera.position, _forward, 220);
    if (hit) out.copy(hit.point);
    else out.copy(this.camera.position).addScaledVector(_forward, 120);
    return out;
  }

  update(dt, focus, speed = 0, contactNormal = null) {
    // Nudge the orbit centre off the surface the blob is stuck to, so the arm
    // has somewhere to go when you are flattened against a wall.
    // Framing offsets scale with the arm length, so a pulled-in camera does
    // not shove the blob out of the bottom of the frame.
    const framing = THREE.MathUtils.clamp(this.currentDistance / 7, 0.35, 1.1);
    _desired.copy(focus).addScaledVector(_offset.set(0, 1, 0), 0.35 * framing);
    if (contactNormal) _desired.addScaledVector(contactNormal, 0.4 * framing);
    this.target.lerp(_desired, 1 - Math.pow(0.0008, dt));

    const cosPitch = Math.cos(this.pitch);
    _toCam.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch
    ).normalize();

    // Pull the arm in when a wall would otherwise be between us and the blob.
    let distance = this.distance;
    const hit = this.world.raycast(this.target, _toCam, this.distance + 0.6);
    // Never push the camera *through* geometry: a close-in view beats clipping.
    if (hit) distance = Math.max(0.9, Math.min(distance, hit.distance - 0.35));
    this.currentDistance = THREE.MathUtils.lerp(
      this.currentDistance,
      distance,
      1 - Math.pow(distance < this.currentDistance ? 1e-6 : 0.02, dt)
    );

    _desired.copy(this.target).addScaledVector(_toCam, this.currentDistance);
    this.camera.position.lerp(_desired, 1 - Math.pow(0.0005, dt));
    this.camera.lookAt(this.target);

    const targetFov = THREE.MathUtils.clamp(62 + speed * 0.7, 62, 78);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.pow(0.02, dt));
    this.camera.updateProjectionMatrix();
  }

  /** Read-and-clear edge-triggered inputs. */
  consume() {
    const state = {
      fire: this.firePressed,
      fireHeld: this.fireHeld,
      cut: this.cutPressed,
      jump: this.jumpPressed,
      respawn: this.respawnPressed,
    };
    this.firePressed = false;
    this.cutPressed = false;
    this.jumpPressed = false;
    this.respawnPressed = false;
    return state;
  }
}
