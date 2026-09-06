/**
 * What to render and how. Everything ships at full quality — phones included —
 * and the renderer only steps down if frames actually come in slow (see the
 * downgrade ladder in main.js). The one unconditional concession is the pixel
 * ratio: phones report 3x, and rendering a soft body scene at 3x buys nothing
 * you can see on a 6-inch screen.
 */
export function detectQuality() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints || 0) > 1;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent || '');

  return {
    isTouch: (coarse && touch) || mobileUA,
    pixelRatio: Math.min(devicePixelRatio || 1, 2),
    transmission: 0.94,
    blobOpacity: 1,
    puddleTransmission: 0.55,
    shadowMapSize: 2048,
    motes: 700,
    maxTorchLights: 12,
    antialias: true,
    blobDetail: 3,
  };
}
