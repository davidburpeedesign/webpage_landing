# CLAUDE.md — MORPHXGEN interactive WebGL hero/backdrop

Guidance for working in this repository. Read this before making changes.

## What this repo is

A collection of **self-contained, dependency-free WebGL "digital data sculpture" prototypes** for the **MORPHXGEN** brand (a generative / additive-manufacturing footwear label). The shipped work is two interactive Three.js pieces embedded on the MORPHXGEN Webflow site:

- **`swarm.js`** — a curl-noise **flocking swarm on a sphere**, used as the **home-page hero**.
- **`swarm-plane.js`** — the same engine on a **flat 2D plane**, used as the **labs-page backdrop**.

Both are loaded into Webflow via **jsDelivr, pinned to a commit** (see [Deployment](#deployment)). `index.html` is the standalone/dev harness for the sphere version.

There is **no build system, framework, package manager, or test runner.** Everything is vanilla ES modules + Three.js loaded from a CDN import map. "Compiling" = a browser opening the file.

## Repository layout

```
index.html                                  Standalone dev harness for the sphere swarm
swarm.js                                    Sphere swarm engine (ES module, embedded via jsDelivr)
swarm-plane.js                              2D-plane swarm engine (ES module, embedded via jsDelivr)
design/reference/morphxgen-visual-language.md   Authoritative MORPHXGEN design tokens & voice
CLAUDE.md                                    This file
```

`index.html` and `swarm.js` are kept in sync: `swarm.js` is the `<script type="module">` body of `index.html` extracted to a standalone file. **If you edit the engine, update both** (the module body in `index.html` and `swarm.js`). Historically this was done with:
```
node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");
  const m=h.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  fs.writeFileSync("swarm.js", m.replace(/^\n/,""));'
```

## Branches (each is a distinct prototype lineage — do not assume `main` is the only one)

| Branch | What it is |
|---|---|
| `claude/zen-clarke-tydjh5` | **Original** prototype: wireframe icosphere with A*/growth "lightning" pathfinding, faint topology, custom bloom. |
| `variant/edge-constrained-growth` | Branching growth constrained to the polygon edges; hidden lattice; Perlin-noise direction bias. |
| `variant/flow-field-agents` | **Flow-field swarm with a live slider control panel** + JSON param export/import. Use this to re-tune and re-export presets. |
| `variant/flow-field-hero` | Chrome-stripped, hardcoded-param **standalone hero** (`index.html` + `swarm.js`) plus the 2D `swarm-plane.js`. This is the shipped engine lineage. |
| `snapshot/morphxgen-prototype-v1` | Frozen snapshot of the original data-sphere look (tags don't push to this remote, hence a branch). |

`swarm.js` / `swarm-plane.js` are merged to `main` (what jsDelivr serves).

## The engine (both `swarm.js` and `swarm-plane.js`)

Structure of a swarm module, top to bottom:

1. **Imports** — `three` and `three/addons/postprocessing/Pass.js` (`FullScreenQuad`), resolved by the host page's import map.
2. **`MX`** — MORPHXGEN palette as linear `THREE.Color`s (void `#222222`, bone `#e4e3df`, white, coral `#e48484`, amber, blue).
3. **`P`** — the single flat parameter object (the "settings"). See [Parameters](#parameters). `CONFIG = P`.
4. **`Noise`** — a self-contained classic **Perlin gradient `noise3`** (no external lib), seeded from `Date.now()`.
5. **Flow field** — `flowDir(...)` (see [Algorithms](#algorithms)).
6. **Mount + renderer** — resolves the container, sizes to it, background canvas (see [Embedding](#embedding-model)).
7. **Custom bloom pipeline** — threshold → separable Gaussian → composite (with chromatic aberration). Verbatim shared between both files.
8. **Agent state** — structure-of-arrays typed arrays (`px,py,pz,vx,vy,...`), `MAXN = 5000` capacity, `P.count` active.
9. **Agent rendering** — streak (`LineSegments`) + soft-glow (`Points`) hybrid, both custom `ShaderMaterial`s that compute depth-of-field in the vertex shader.
10. **Interaction** — pointer → seek target (raycast to sphere / plane), coral proximity tint.
11. **Simulation** — flocking + flow, integrated per frame.
12. **Main loop + resize** — `requestAnimationFrame`; `ResizeObserver` on the mount.

### Sphere (`swarm.js`) vs plane (`swarm-plane.js`) — the only differences

| Concern | `swarm.js` (sphere) | `swarm-plane.js` (plane) |
|---|---|---|
| Domain | Agents on a sphere of radius `SPHERE_R = 2.4`; position = surface point, velocity = tangent | Agents on a flat field; move in (x,y); `pz` is a **static per-agent depth** in a slab (`DEPTH_SLAB`) purely to drive DoF |
| Flow field | Curl on the sphere: `flow = normal × ∇noise` (3D) | 2D curl noise: `flow = (∂N/∂y, −∂N/∂x)` |
| Flocking | 3D spatial hash + 3D distances | 2D spatial hash + 2D distances |
| Boundaries | Re-project position to the sphere each step; re-tangent velocity | Wrap in x/y at frustum edges (`EXT`, recomputed on resize) |
| Camera motion | Slow idle group rotation (`rotSpeed`) | None (`rotSpeed` kept in `P` for parity, unused) |
| Reference geo | Faint icosphere wireframe (`showSphere`, default off) | None |
| Focal setup | Depth spans the sphere hemispheres | Field centred so mean view-depth = `focalDist`; `DEPTH_SLAB` gives DoF variation |

The rendering pipeline, shaders, bloom, DoF, chromatic aberration, coral cursor, colour-by-speed, and embedding logic are **identical** between the two.

## Algorithms

- **Flow field (curl noise).** A divergence-free vector field derived from the curl of a Perlin noise potential, so agents follow contours and stay on-domain. Animated by drifting the noise sample point over time (`fdx/fdy/fdz += flowSpeed*…`). On the sphere it's `normal × ∇noise` (guaranteed tangent); on the plane it's the 2D curl.
- **Boids / flocking** (Reynolds): **separation**, **cohesion**, **alignment**, each with its own radius/strength and enable flag, plus **flow** steering and cursor **seek**. Each rule computes a desired velocity, and steering force = `clamp(desired − velocity, maxForce)`, smoothed (`smoothing`) into acceleration. Neighbours come from a **uniform spatial hash** (Map keyed by quantized cell; 27 cells in 3D / 9 in 2D).
- **Depth of field (per-agent, "Route A").** No depth buffer (agents are additive/transparent). Instead each agent's camera-space depth is computed in the **vertex shader**; a circle-of-confusion `coc = clamp(|viewDepth − focalDist| / focalRange, 0, 1)` drives two layers: **streaks fade** as they defocus, and **soft point sprites grow larger + dimmer** (bokeh). In focus → crisp darts; out of focus → soft glowing points.
- **Custom bloom.** Deliberately replaces `UnrealBloomPass` (whose multi-mip glow washes the mid-gray `#222` void). Pipeline: render scene → **threshold-gate** bright pixels at half-res → **small fixed-pixel separable Gaussian** (ping-pong) → **composite** `scene + glow*strength`, encode linear→sRGB. Glow stays tight to the paths; the void stays clean.
- **Radial chromatic aberration.** In the composite shader, RGB channels are sampled with a per-channel UV offset that grows from screen centre outward (`caStrength`), applied after bloom so the glow fringes too.
- **Cursor coral proximity.** The cursor's surface point (raycast) tints nearby agents toward coral via a smoothstep falloff over `coralRadius`, eased per-agent over time. Independent of the seek *force*, so it works even with steering off.

## Parameters (`P`)

The shipped hero/plane hardcode a tuned set. The slider version (`variant/flow-field-agents`) exposes all of them and can export/import the JSON.

```
count 1500            maxSpeed 0.009   maxForce 0.0004   smoothing 0.56
flowStrength 2.0      flowScale 0.45   flowSpeed 0.005
sepStrength 2.0/sepRadius 0.2   cohStrength 1.75/cohRadius 0.34   aliStrength 1.5/aliRadius 0.26
seekStrength 2.0/seekRadius 1.0   coralRadius 0.9
lineLen 0.035   agentAlpha 0.55   rotSpeed 0.1   showSphere false
caStrength 0.009   dofEnabled true   focalDist 6.0   focalRange 2.6   dofBlur 0.3
bloom { threshold 0.16, knee 0.10, strength 0.95, blurPx 1.0, iterations 2 }
```

Units are world-space (sphere radius 2.4; camera at z 8.2, fov 45). `MAXN = 5000` bounds all buffers; the count slider goes to 4000. Performance is CPU-bound in the boid loop — a GPU/transform-feedback port is the path to much higher counts.

## Embedding model

Both engines resolve a **mount container** in priority order, then render the canvas as a **background layer** inside it:

```
#swarm-stage  →  .mx-hero  →  #stage  →  (create a 100vh div prepended to .mx-page/body)
```

- The canvas is inserted as the mount's **first child**, `position:absolute; inset:0; pointer-events:none` (clicks pass through), sized to the mount via `ResizeObserver`, cursor mapped to the canvas box.
- The mount gets `position:relative` + **`isolation:isolate`**, and existing mount children are lifted with `position:relative` (NOT `z-index`) so overlay content sits above the swarm **and** can use `mix-blend-mode` against it.

### Critical layering rules (learned the hard way)

- **Overlay content that must show over / blend with the swarm has to live *inside* the mount container.** A separate/empty `#swarm-stage` will just be covered by the opaque canvas.
- **`mix-blend-mode: difference` on an overlay (e.g. the logo)** only works if neither the element nor any wrapper between it and the mount creates an isolating stacking context — i.e. **no `z-index`, `transform`, `opacity<1`, `filter`, or `will-change`** on that chain. The engine deliberately lifts content with `position` only for this reason.
- **A full-screen fixed overlay (e.g. a page loader) must be a direct child of `<body>`.** A `transform` on any ancestor turns `position:fixed` into "absolute relative to that ancestor," so page-height changes (like a 100vh hero) shift it.

## Design system (MORPHXGEN)

Authoritative tokens/voice: `design/reference/morphxgen-visual-language.md`. Essentials:
- **Void `#222222`** background, **bone `#e4e3df`** ink, exactly **one accent: coral `#e48484`** (used like an indicator light). The data palette (blue/amber/etc.) appears **only inside imagery** — the swarm counts as imagery.
- Monospace-forward type (Intel One Mono / Space Mono; Montserrat for the `MORPHXGEN` wordmark only). All-lowercase except the wordmark.
- Flat, hairline, square corners, corner-tick brackets, **no shadows / no blur panels / no emoji**. Mechanical motion (`cubic-bezier(0.65,0,0.35,1)`).

## Deployment

Served to Webflow via **jsDelivr, pinned to a commit** (immutable; bump the hash to update):
```
https://cdn.jsdelivr.net/gh/davidburpeedesign/webpage_landing@<commit>/swarm.js
https://cdn.jsdelivr.net/gh/davidburpeedesign/webpage_landing@<commit>/swarm-plane.js
```
The Webflow page footer holds the **import map + module `src`** loader; the engine auto-mounts. The repo is public (required for jsDelivr). Site: **Morphxgen** (`morphxgen.webflow.io`).

## Working conventions

- **No build/tests.** Validate a change by loading `index.html` in a browser. Syntax-check the module without a browser:
  ```
  node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");
    fs.writeFileSync("/tmp/c.mjs", h.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);' \
    && node --check /tmp/c.mjs
  ```
  For core-math changes, a headless Node harness that replicates the sim and asserts invariants (on-domain, bounded speed, no NaN) has been the standard smoke test.
- **Keep `index.html` and `swarm.js` in sync** when editing the sphere engine; edit `swarm-plane.js` separately (it must never be broken by sphere changes).
- **Three.js is pinned** to `0.160.0` via the import map; the custom bloom relies on `FullScreenQuad`, `RawShaderMaterial`, half-float MSAA render targets, and manual linear→sRGB in the composite (don't add an `OutputPass`/double-encode).
- **Never disable TLS / unset `HTTPS_PROXY`** in this environment.
- Prefer the smallest diff that matches surrounding style; the engine files favour dense, comment-annotated vanilla JS.
```
