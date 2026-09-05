# STICKY

A third-person demo where you play a blob of goo: a pressurised soft body that
squashes against everything it touches, clings to walls, and fires strands of
goo it can swing from and winch itself along — a slime-gun grapple.

No build step. Serve the folder and open it.

```sh
npm run dev          # python3 -m http.server 8000
# then open http://localhost:8000
```

(A server is required — ES modules do not load over `file://`. three.js is
pulled from a CDN by the import map in `index.html`, so the first load needs
network access.)

## Controls

| input | action |
| --- | --- |
| `W A S D` | roll around (camera-relative) |
| `Space` | jump |
| `Shift` | cling — stick to any surface, and drive straight up walls |
| Left mouse | fire a strand of goo at whatever the crosshair is over |
| Hold left mouse | winch yourself toward the anchor |
| Right mouse / `Q` | cut every strand |
| `R` | respawn |
| `Esc` | release the mouse |

Up to four strands can be attached at once; firing a fifth drops the oldest.

## How it works

### The blob is the simulation (`src/blob.js`)

The rendered mesh *is* the physics body. A subdivided icosahedron (162
vertices, 320 faces) is welded into a closed manifold and every vertex becomes
a Verlet particle:

- **Edge constraints** — structural edges plus a second ring of bend edges, so
  the skin holds together without folding flat on impact.
- **Gas pressure** — each face pushes outward along its normal with a force
  proportional to its area and to how far the body is compressed from its rest
  volume. This is what stops a landing from crumpling it, and it keeps volume
  within a few percent while the shape deforms freely.
- **Per-particle contacts** — every particle is collided against the level with
  friction, near-zero restitution and static friction, so goo creeps to a stop
  instead of sliding. Contacts are what produce the squash you see; nothing is
  faked with scale.
- **Locomotion** — movement force is projected onto the contact plane, with a
  little torque about it so the blob tumbles rather than skating. Pressing into
  a wall while clinging climbs it.

Clinging raises friction, adds adhesion for particles near a surface, and cuts
gravity to 8%, which is what lets the blob hang and climb.

### Strands (`src/strands.js`)

Firing launches a goo projectile with its own arc. Where it hits, it splats and
becomes a strand: a Verlet rope pinned to the world at one end and welded to the
nearest blob particle at the other.

- The rope solves as a chain of distance constraints and collides with the
  level, so it drapes over ledges instead of sinking through them.
- Rope tension is fed back into the soft body by dragging the attachment
  particle and its neighbours — clamped and spread so a hard yank stretches the
  goo instead of tearing a spike out of it.
- A **hard length constraint** keeps the whole body inside a sphere around the
  anchor. The correction moves position and previous-position together and only
  cancels outward radial velocity, so it adds no energy: strands swing like
  ropes, not rubber bands.
- Reeling shrinks the rope and adds a winch force along it, but only while the
  strand is taut.

Tubes are preallocated meshes with fixed topology; each frame sweeps a ring
along the rope with a parallel-transported frame, necking down where the strand
is stretched and rippling slightly so it reads as goo.

### The rest

- `src/world.js` — the arena and all collision. Every surface is an oriented box
  with point-contact and slab-raycast queries in box-local space, so ramps cost
  the same as walls.
- `src/controls.js` — pointer-locked third-person orbit camera. It pulls in
  rather than clipping through geometry, nudges its focus off whatever surface
  you are stuck to, and widens its FOV with speed.
- `src/main.js` — lighting, sky, fixed-timestep loop (1/60, max 5 steps per
  frame so a slow frame cannot spiral).

## Tests

The physics is plain math over typed arrays, so it runs headless:

```sh
npm install    # dev-only: three, for the node tests
npm test       # drop, settle, volume, locomotion, jump, strands, swing, cling, tunnelling
npm run bench  # cost of one simulation step
```

The current cost is about 1.1 ms per fixed step (162 particles, 1410
constraints, strands live) — roughly 7% of a 60 fps frame.

## Tuning

`window.sticky` is exposed for poking at it live from the console:

```js
sticky.blob.pressure = 14000   // stiffer, ball-like
sticky.blob.edgeStiffness = 0.15  // sloppier, more jiggle
sticky.gun.reelForce = 60      // harder winch
sticky.paused = true           // freeze physics, keep rendering
sticky.step(60)                // advance 60 fixed frames by hand
```
