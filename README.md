# STICKY

A third-person demo where you play a blob of goo loose in a ruined castle: a
pressurised soft body that squashes against everything it touches, clings to
walls, and fires strands of goo it can swing from and winch itself along — a
slime-gun grapple.

No build step, no install. Get it and run it:

```sh
git clone https://github.com/joshuaopel/sticky.git
cd sticky
git checkout claude/sticky-blob-goo-demo-qwoi7c
```

**Windows** — double-click **`run.bat`** (or `run.bat 8080` for a different
port). It serves the folder and opens your browser; close the window or press
Ctrl+C to stop.

**Anywhere** — `npm run dev`, which is the same tiny zero-dependency server
(`node tools/serve.mjs --open`).

A server is required either way: browsers refuse to load ES modules over
`file://`. three.js comes from a CDN via the import map in `index.html`, so the
first load needs network access.

### Hosting it on GitHub Pages

The demo is entirely static and every path in it is relative, so it runs from a
project subpath (`https://<user>.github.io/sticky/`) with no changes. On a
public repo: **Settings → Pages → Source: Deploy from a branch**, pick the
branch and `/ (root)`, save, and the site is live a minute later. No build step
and no workflow needed; `.nojekyll` keeps Pages from running the files through
Jekyll.

Pages serves over HTTPS, which pointer lock requires, and three.js loads from an
HTTPS CDN, so there is no mixed content. The only external dependency is that
CDN — if you would rather the page not need it, three.js can be vendored into
the repo and the import map pointed at the local copy.

## Controls

| input | action |
| --- | --- |
| `W A S D` | roll around (camera-relative) |
| `Space` | jump |
| `Shift` | cling — stick to any surface, and drive straight up walls |
| Left mouse | fire a strand of goo at whatever the crosshair is over |
| Hold left mouse | winch yourself toward the anchor |
| Right mouse / `Q` | cut every strand |
| roll over a **puddle** | soak it up and grow back |
| `R` | respawn |
| `Esc` | release the mouse |

On a phone or tablet, hold it in landscape and tap to play. The left half of the
screen is a floating stick — it appears wherever your thumb lands, so there is
nothing to aim for — and dragging the right half looks around. **FIRE** shoots a
strand and holding it reels you in, with **JUMP**, **CUT** and **CLING** beside
it; cling is a toggle there rather than a held key, because you cannot hold a
modifier and still drive and look. Portrait shows a rotate prompt.

Up to four strands can be attached at once; firing a fifth drops the oldest.

Every shot is **mass out of your body** — the blob visibly shrinks as you use
the gun, and the HUD meter tells you how much is left. Run low and the gun
coughs instead of firing. The goo is not gone, though: it is lying on the floor
where you spent it, so roll over puddles to soak it back up. Overfill past 100%
and you get a bigger blob than you started with.

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

### The look (`src/goo-material.js`)

A physical material with high transmission, so three renders the scene behind
the blob into its transmission pass and refracts it through the body — that is
what makes it read as a translucent thing rather than a tinted ball.
Attenuation gives it depth: thin edges are nearly clear, the middle soaks light
into green. Two shader injections sit on top of that, hooked into stock chunks
(`map_fragment` and `emissivemap_fragment`) so the rest of three's lighting is
untouched:

- **internal flow** — a cheap layered-sine field sampled in object space and
  advected in time, so the goo looks like it is slowly moving inside itself;
- **a fresnel rim** — the wet, bright edge you get where you are looking
  through the most material. This is the part that sells jello.

Both are scaled by how full the blob is, so a drained blob goes pale and
watery while a fat one is deep and lively. Impacts spike the rim for a moment,
which reads as a wobble of light across the surface.

### Mass, shrinking and puddles (`src/puddles.js`)

Goo is a resource. The body's rest state scales with the cube root of it, and
`GooBlob._applyScale` rescales the *simulation* — rest lengths, rest volume and
the contact radius — not just the render, so a small blob is genuinely a small
soft body with its own squash and pressure, not a shrunken picture of a big one.

Goo leaves the body when you fire a strand and when you hit something hard
enough to splash. Everything you lose lands in the world as a puddle, and
cutting a strand drips most of it back down at the anchor — which may be
somewhere awkward to go and get. Puddles are also seeded across the level at
startup, deterministically, so there is always something to find.

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

### The ruin (`src/world.js`)

A moonlit castle in pieces: a gatehouse with a stuck portcullis, a hollow
roofless keep with half a floor left and a stair up the outside, a great hall
of broken columns under fallen beams, a dungeon pit with cages hanging over an
iron grate, collapsed curtain walls you can climb through, and a bailey with a
toppled king, a dry well, braziers and a wrecked cart.

It is built entirely from blocks, by the same call that creates the collider —
so what you look at is exactly what you collide with. A few notes on how it
holds together:

- **Set-piece builders.** `_crenellations`, `_arch`, `_stairs`, `_column`,
  `_rubble`, `_torch`, `_banner`, `_chandelier`, `_cage`, `_statue`. The level
  is written in those terms rather than as a list of boxes, so a ruined wall is
  one call with a collapsed stretch in it. All randomness is seeded, so the ruin
  falls down the same way every run.
- **Merged draw calls.** Each block's geometry is baked into a per-material
  bucket and merged at the end, so ~400 blocks cost about a dozen draws.
- **Texture that keeps its scale.** BoxGeometry gives every face 0..1 UVs, which
  would stretch one stone course across a 60-metre wall. `scaleBoxUVs` rescales
  per face pair by that face's world size, so a course is a course everywhere.
  The stone, flagstone, timber and iron maps are drawn procedurally onto
  canvases at startup — no texture downloads.
- **Broadphase.** With several hundred blocks, testing every collider per
  particle per substep would eat the frame. Colliders are bucketed into a
  uniform grid over the floor plan and each query only looks at the cell it is
  in, which keeps the whole simulation at ~1.5 ms.
- **Torches** flicker on a sum of sines, and the flames are stacks of additive
  blocks. Fire, dust motes and a star dome do most of the atmosphere work.

Collision itself is unchanged: every surface is an oriented box with
point-contact and slab-raycast queries in box-local space, so a tilted block
costs the same as a wall.
- `src/controls.js` — pointer-locked third-person orbit camera. It pulls in
  rather than clipping through geometry, nudges its focus off whatever surface
  you are stuck to, and widens its FOV with speed.
- `src/main.js` — lighting, sky, fixed-timestep loop (1/60, max 5 steps per
  frame so a slow frame cannot spiral).
- `src/touch.js` + `src/quality.js` — touch input, and what to render. Every
  device gets the full look; the renderer only gives things up if frames
  actually come in slow, averaged over ~150 of them so a shader compile or a
  backgrounded tab cannot trigger it. It then sheds one thing at a time, in
  order: resolution and dust, then refraction (the transmission pass is a
  second render of the whole scene), then shadows. The only unconditional
  concession is capping the pixel ratio at 2, since phones report 3.

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
sticky.blob.addGoo(0.5)        // fatten up
sticky.blob.shotCost = 0.2     // strands are expensive now
sticky.gun.reelForce = 60      // harder winch
sticky.puddles.seed(40)        // litter the level with goo
sticky.paused = true           // freeze physics, keep rendering
sticky.step(60)                // advance 60 fixed frames by hand
```
