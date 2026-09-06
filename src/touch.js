/**
 * Touch controls for landscape phones and tablets.
 *
 * Left half of the screen is a floating stick — it appears wherever the thumb
 * lands, so there is nothing to aim for. The right half is look, dragged like a
 * trackpad. Everything else is a button, because firing and reeling are the
 * same input held for different lengths of time and that needs a real target.
 */
export function setupTouch(controls, canvas, ui) {
  const stickRadius = 62;
  let stickId = null;
  let lookId = null;
  let lookX = 0;
  let lookY = 0;

  const setStick = (x, y) => {
    controls.touch.x = x;
    controls.touch.y = y;
    if (!ui.knob) return;
    ui.knob.style.transform = `translate(${x * stickRadius}px, ${y * stickRadius}px)`;
  };

  const showStick = (x, y) => {
    if (!ui.stick) return;
    ui.stick.style.left = `${x}px`;
    ui.stick.style.top = `${y}px`;
    ui.stick.classList.add('visible');
  };

  const hideStick = () => {
    if (ui.stick) ui.stick.classList.remove('visible');
    setStick(0, 0);
  };

  let originX = 0;
  let originY = 0;

  // Capture keeps a drag alive when the finger leaves the element; some
  // browsers refuse for pointers they do not recognise, which is not fatal.
  const capture = (element, id) => {
    try { element.setPointerCapture(id); } catch { /* not capturable */ }
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    capture(canvas, event.pointerId);

    // Left third-ish drives, the rest looks. Split by the pointer's own start
    // position so a thumb that drifts across the middle keeps doing its job.
    if (event.clientX < innerWidth * 0.45 && stickId === null) {
      stickId = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
      showStick(originX, originY);
      setStick(0, 0);
    } else if (lookId === null) {
      lookId = event.pointerId;
      lookX = event.clientX;
      lookY = event.clientY;
    }
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId === stickId) {
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      const length = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(length, stickRadius) / stickRadius;
      setStick((dx / length) * clamped, (dy / length) * clamped);
    } else if (event.pointerId === lookId) {
      controls.yaw -= (event.clientX - lookX) * controls.touchSensitivity;
      controls.pitch = Math.max(-0.9, Math.min(1.15, controls.pitch - (event.clientY - lookY) * controls.touchSensitivity));
      lookX = event.clientX;
      lookY = event.clientY;
    }
    event.preventDefault();
  });

  const release = (event) => {
    if (event.pointerId === stickId) {
      stickId = null;
      hideStick();
    } else if (event.pointerId === lookId) {
      lookId = null;
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  /** Wire one on-screen button. `hold` buttons report press and release. */
  const button = (element, { onPress, onRelease, toggle }) => {
    if (!element) return;
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      capture(element, event.pointerId);
      element.classList.add('pressed');
      if (toggle) element.classList.toggle('active');
      onPress?.();
    });
    const up = (event) => {
      event.preventDefault();
      element.classList.remove('pressed');
      onRelease?.();
    };
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  };

  button(ui.fire, {
    onPress: () => { controls.firePressed = true; controls.fireHeld = true; },
    onRelease: () => { controls.fireHeld = false; },
  });
  button(ui.jump, { onPress: () => { controls.jumpPressed = true; } });
  button(ui.cut, { onPress: () => { controls.cutPressed = true; } });
  button(ui.respawn, { onPress: () => { controls.respawnPressed = true; } });
  // Cling is a toggle on touch: you cannot comfortably hold a modifier and
  // still drive and look at the same time.
  button(ui.cling, {
    toggle: true,
    onPress: () => { controls.touchCling = !controls.touchCling; },
  });

  return { hideStick };
}
