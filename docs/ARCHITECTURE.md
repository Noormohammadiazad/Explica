# Explica — Architecture & Mathematical Model

Explica turns a local PDF into a physically simulated book. Nothing leaves the
device: the PDF is read with the File API, parsed by pdf.js in a Web Worker,
rasterised (off the main thread where the browser allows it) and uploaded to the
GPU. The app is a static bundle with no runtime network access; a
Content-Security-Policy with `connect-src 'self'` enforces this.

The document is split into six parts:

1. [Mechanics of a sheet of paper](#1-mechanics-of-a-sheet-of-paper)
2. [Time integration](#2-time-integration)
3. [Interaction state machine](#3-interaction-state-machine)
4. [Rendering & ingestion architecture](#4-rendering--ingestion-architecture)
5. [Reading direction & colour themes](#5-reading-direction--colour-themes)
6. [Annotations](#6-annotations)

---

## 1. Mechanics of a sheet of paper

### 1.1 What paper is, mechanically

A sheet of paper is a thin plate whose membrane stiffness is orders of
magnitude larger than its bending stiffness. Over the deformations a page sees
while being turned, it is effectively **inextensible**: it bends but does not
stretch or shear. By Gauss' *theorema egregium* an isometric deformation of a
flat sheet keeps Gaussian curvature `K = 0`, so the deformed page is a
**developable surface** — a ruled surface whose rulings are straight segments
along which the surface is flat.

Instead of simulating a cloth mesh and fighting to keep it inextensible
(stiff springs, many iterations, crumpling artefacts), Explica **restricts the
configuration space to developable isometries by construction**, then does
Lagrangian mechanics on that manifold. Nothing can stretch, because no
coordinate exists that would stretch it.

### 1.2 Material coordinates

A sheet occupies the material domain

```
Ω = [0, W] × [−H/2, H/2]        (u = distance from the spine, v = along the spine)
```

in SI units (metres); `W, H` come from the PDF's page box (1 pt = 1/72 in).
The spine is the edge `u = 0`. Book frame: `x` across the book (right-hand
pages at `x > 0`), `y` along the spine, `z` out of the book.

### 1.3 The ruling field: a fan through an apex on the spine line

Real page curls are approximately **generalised cones** whose apex lies on the
(extended) spine line: that is the only way for the spine itself to remain a
straight ruling while the corner peels diagonally. Cylinders (parallel
rulings) are the limiting case with the apex at infinity.

We parameterise the family with a single scalar `p` (the *fan convergence*):

```
ruling k:   passes through o_k = (u_k, 0),  direction d_k ∝ (u_k·p, 1),   u_k = k·W/K
apex:       (0, −1/p)       (p > 0: apex below the page, p < 0: above, p = 0: parallel)
```

All rulings pass through the apex, so they never intersect inside `Ω` as long
as the apex is outside it: `|p| < 2/H` (we enforce `|p| ≤ 1.6/H`). A material
point belongs to the ruling with *fan coordinate*

```
σ(u, v) = u / (1 + p·v)
```

which is smooth in `p` through `p = 0`, and the strip index is
`s(u, v) = clamp(⌊σ K / W⌋, 0, K−1)`.

### 1.4 Discrete developable: an articulated chain of rigid strips

The rulings cut the page into `K` convex polygons ("strips"). Each strip is a
**rigid planar panel**; consecutive strips are joined by a **hinge along the
shared ruling**. This is the classic discrete model of a developable surface
(a planar-quad strip): every strip is an exact isometry of its material
polygon, neighbouring strips agree on their shared ruling, so the sheet is
continuous, piecewise flat, and exactly unstretched for every configuration.

The generalised coordinates are

```
q = (p, ψ_0, ψ_1, …, ψ_{K−1})  ∈ ℝ^{K+1}
```

* `ψ_0` — rotation of the whole sheet about the spine (0 = lying right, π = lying left)
* `ψ_k` — hinge angle on ruling `k` (bending), `k ≥ 1`
* `p`   — ruling-field shape (cylinder ↔ cone)

Forward kinematics uses the **product-of-exponentials** formula from robotics.
Each hinge is a unit rotation twist about the rest-frame line `(o_k, a_k)` with
`a_k = −d_k` (so positive angles lift the outer part towards `+z`):

```
T_k(q) = B · e^{ψ_0 ξ̂_0} · e^{ψ_1 ξ̂_1} ⋯ e^{ψ_k ξ̂_k}
X(u, v; q) = T_{s(u,v)}(q) · (u, v, 0)ᵀ
```

`B` translates the spine axis to the binding's pivot. Velocities follow from
spatial twists: for a point in strip `s`,

```
∂X/∂ψ_j = ω'_j × (X − c'_j)          (j ≤ s, ω'_j = R(T_{j−1}) a_j, c'_j = T_{j−1} o_j)
∂X/∂p   = ω^p_s × X + v^p_s           (per-strip rigid twist, central difference of T_s)
```

so every Jacobian column is a rigid twist of a strip. The `p`-twist is
obtained by central differences of the strip transforms (cheap: `O(K)`).

### 1.5 Mass and the O(n²) assembly

Mass is sampled by a fixed, cell-centred grid of **material** quadrature
points (2K × 10). They must be material points — not, say, per-strip
quadrature points — because the incremental potential below compares each
point's position at the start and end of a step, and a point may migrate
from one strip to the next as `p` (the ruling field) changes.

Every Jacobian column of a point in strip `s` is a rigid twist `ξ = (ω, v)`,
so its velocity is `A(X)·ξ` with `A = [−[X]×, I]`. Any per-point quadratic
form `½ Σᵢ (Jᵢ q̇)ᵀ Qᵢ (Jᵢ q̇)` therefore collapses into one 6×6 block per strip,
`G_s = Σ_{i∈s} Aᵢᵀ Qᵢ Aᵢ` (a spatial inertia when `Qᵢ = mᵢ I`). Hinge `j` moves
every strip `s ≥ j` with the same twist, so with suffix sums `Ḡ_k = Σ_{s≥k} G_s`
the Hessian is `H_jk = ξ_jᵀ Ḡ_max(j,k) ξ_k`: assembly costs O(points + n²·36)
instead of O(points · n²). Inertia, gravity, air drag, contacts and the hand all
funnel through the same per-strip blocks.

### 1.6 Potential energy

```
E(q) = E_bend + E_spine + E_grav + E_hand + E_contact + E_limits
```

**Bending.** For a plate with `K_gauss = 0` the Kirchhoff–Love energy
`½D∫[(κ₁+κ₂)² − 2(1−ν)κ₁κ₂]dA` reduces to `½D∫κ²dA`, with flexural rigidity
`D = E t³ / 12(1−ν²)`. A hinge of angle `ψ_k` spread over the local ruling
spacing `h_k` has curvature `κ ≈ ψ_k / h_k`, giving

```
E_bend = Σ_{k≥1} ½ c_k(p) ψ_k²,      c_k(p) = D ∫_{ℓ_k ∩ Ω} ds / h_k(s)
```

where `h_k(s)` is the dual-cell width (mean distance to the neighbouring
rulings), integrated with Simpson's rule along the clipped ruling. For a
cylinder this is `D·H/Δ`; for a cone it reproduces the exact cone energy
`(D/2)∫ k_g² ln(r_out/r_in) dα`.

**Spine (binding tension).** The binding is a torsion spring
`E_spine = ½ k_s (ψ_0 − π/2)²`; a stiff, new binding wants pages to stand up,
gravity and the stack keep them down.

**Gravity.** `E_grav = −Σ_i m_i g·X_i` with `g` expressed **in the book frame**:
tilting the book in your hands changes how a turning page falls.

**Hand.** The grabbed material point `x_h` is tied to the pointer target
`y(t)` by a stiff spring with damping: `E_hand = ½ k_h |X(x_h) − y|²`. A finite
spring is what makes the page *force-responsive*: a fast drag outruns the
paper, inertia and air resistance show up as lag and curl.

**Contact.** Each stack surface is a cylinder `z = S(x)` (the gutter curves
the stack down into the binding). For a sheet in flight the surface is the
pointwise maximum of that idealised stack and the **actual cross-section of the
resting sheet directly beneath it**, raised by one sheet thickness:
sheet-on-sheet contact. (Resting sheets are domed by the binding's spring, so
colliding with the idealised stack alone lets a lifted page sink into the one
below — the first prototype showed exactly that as bleed-through.) Contact
samples lie on every hinge line and the fore-edge, five per line, with a
one-sided penalty `½ k_c min(0, z − S(x))²`, contact damping and a
friction-like tangential damping.

**Limits.** Soft barriers keep `|p| ≤ 1.6/H` and `|ψ_k| ≤ 0.95π`.

### 1.7 Dissipation (Rayleigh)

```
R = ½ β Σ c_k ψ̇_k²                 internal (visco-elastic) damping of the fibres
  + ½ Σ_i c_air,i (n_i·V_i)²        aerodynamic drag on the sheet's normal velocity
  + ½ c_h |V_h − ẏ|²                damping of the hand spring
  + ½ c_c Σ_active (φ̇_c)²          contact damping
```

Air drag is quadratic in reality (`F = ½ρ C_d A v²`, `C_d ≈ 1.2` for a flat
plate); we use the linearisation `c_air = ½ ρ_air C_d A |v_n|` with `|v_n|`
from the previous step, plus a small linear floor. This is what makes a
flicked page decelerate and curl the way paper does.

### 1.8 Default parameters (80 g/m² book paper)

| Quantity | Symbol | Value |
|---|---|---|
| Areal density | ρ_A | 0.08 kg/m² |
| Flexural rigidity | D | 2.5·10⁻⁴ N·m |
| Elasto-gravity length | (D/ρ_A g)^{1/3} | ≈ 6.8 cm |
| Strips | K | 24 |
| Spine stiffness | k_s | 4·10⁻⁴ N·m/rad |
| Hand spring | ω_h | 95 rad/s (lag ≈ g/ω_h² ≈ 1 mm) |
| Contact spring | ω_c | 600 rad/s (sink ≈ 0.03 mm < sheet spacing) |
| Internal damping | β | 0.015 s |
| Air density / drag coeff. | ρ_air, C_d | 1.2 kg/m³, 1.2 |

The elasto-gravity length being smaller than the page width is exactly why a
lifted page droops and curls over instead of swinging like a board.

---

## 2. Time integration

Paper is a stiff system: the highest hinge mode of a 24-strip A5 page is
~1300 rad/s while the page swings at ~5 rad/s. Explicit integrators would need
microsecond steps. Explica uses **implicit Euler written as an incremental
potential** in the reduced coordinates:

```
q_{n+1} = argmin_q  Φ(q) = Σ_i m_i/(2h²) |X_i(q) − X̃_i|²  +  E(q)  +  h·R((q − q_n)/h)
X̃_i    = X_i(q_n) + h·J_i(q_n)·q̇_n
q̇_{n+1} = (q_{n+1} − q_n)/h
```

The inertia term is evaluated on the **nonlinear** kinematics `X(q)`, so
centrifugal stiffening (a fast flick straightens the page) is captured without
hand-derived Coriolis terms. `Φ` is minimised by **Gauss–Newton** with an
analytic Jacobian and a backtracking line search on `Φ`:

```
H = Σ m_i/h² J_iᵀJ_i + ∂²E + (1/h) C,       g = ∇Φ,       δ = −H⁻¹g (dense Cholesky, n = K+1 = 25)
```

Implicit Euler is unconditionally stable and dissipates only the highest,
physically over-damped modes. Fixed step `h = 1/240 s`, ≤ 3 Gauss–Newton
iterations; the simulation is deterministic (no randomness, fixed step,
`Float64Array`s, a fixed accumulation order), so tests can assert bit-identical
replays.

**Resting pose.** A sheet lying on a stack is drawn in its **static
equilibrium**, computed by the simulator itself (large damped implicit steps
≡ a damped Newton iteration on the potential), seeded with the analytic pose
whose hinge lines lie on the gutter curve. The analytic pose alone is not an
equilibrium: the binding's torsion spring domes the sheet near the gutter and
stiff paper bridges a tight gutter rather than hugging it. Because the drawn
pose *is* the physical one, picking a page up never makes it jump.

**Sleeping & landing.** A released sheet is committed to a stack when its
spine angle is within 0.25 rad of that side's equilibrium and its fastest
point has moved slower than 2 cm/s for 0.16 s. Its coordinates are then
blended for 160 ms into the cached equilibrium. A sheet balanced upright on a
stiff binding for 0.9 s gets a tiny nudge.

### Verification (see `tests/`)

* **Isometry** — the material metric `JᵀJ` of `X(u,v)` equals `I` everywhere;
  hinge lines are mapped identically by both adjacent strips.
* **Spine invariance** — `u = 0` stays on the binding axis for any `q`.
* **Jacobians** — analytic twists match finite differences.
* **Hessian/gradient consistency** — the assembled gradient equals the
  finite-difference gradient of the incremental potential.
* **Hinge stiffness** — the closed form for a cone matches direct quadrature.
* **Euler–Bernoulli cantilever** — a horizontally clamped stiff sheet's tip
  deflection matches `δ = ρ_A g W⁴ / 8D` within a few percent.
* **Energy** — with no damping or external work, total energy never increases.
* **Behaviour** — a flicked page lands on the left; a gently released one
  falls back; a bottom-corner peel produces a cone with the apex below the page
  (`p > 0`), a top-corner peel the opposite.
* **Momentum** — a sheet spinning freely about the spine keeps > 97 % of its
  kinetic energy over half a second (the turning motion is not numerically
  damped; only stiff bending modes are).
* **Resting pose** — the static equilibrium is a fixed point of the dynamics.
* **Determinism** — two identical runs produce identical bits.
* **State machine** — transitions for every input sequence in the table below.
* **Turning in the hands** — a horizontal drag turns the book about its own
  spine (the spine does not move); a vertical drag tilts it about the screen's
  horizontal axis; a twist follows the fingers. For 300 random poses (any twist,
  turns up to ±210°, the full tilt range) a small drag in each of 8 directions
  swings the visible face's normal towards the drag on screen whenever that
  face is within ~72° of the reader, and pure horizontal or vertical drags do so
  even near edge-on. Circling drags never roll the spine off the screen
  vertical; throws keep their sense and decay; tilt stops at its limits; reset
  takes the short way home; panning still follows the hand.
* **Page block** — vertical rays fired at a dense grid (right into the corners)
  find the block top at least 0.9 × the 0.12 mm gap below the resting sheet's
  underside wherever it is not resting on the board, for left and right sheets
  in their static equilibrium and for a strongly conical sheet. On stacks 1–3
  sheets thin it never rises above the sheet. Its walls end exactly on the
  sheet's underside edges and face outwards.
* **Picking** — reading face only for resting pages, either side for pages in
  flight, and covers, spine and block walls hide what is behind them.
* **Text selection** — a held press on text selects and drag extends it, while
  clicks and drags that start on text still tap and peel; holding where there is
  no text stays a page press. The geometry is checked too: run boxes, the CSS
  affine and its inverse, carets and word boundaries.
* **Sheet bounds** — a sheet raycast before it was ever posed keeps its true
  bounding sphere and is hit once posed (the old lazy bound was radius 0).
* **Missed releases** — a new press from a pointer still marked as down ends the
  stuck page drag, orbit or selection, then starts afresh.
* **Annotations** — tools act from the first point while Alt, Shift, the right
  button and the background still handle the book; a second finger ends a stroke.
  The store persists per document key, rounds coordinates, groups a gesture into
  one undo step (empty steps leave no trace), reports changed pages and storage
  failures, and survives corrupt records. Polyline simplification, quad tests and
  isotropic eraser reach are checked too.
* **Direction and identity** — Persian, Arabic, Urdu and Hebrew text reads
  right-to-left and English left-to-right (a Persian page quoting English is
  still Persian); too few letters abstain. The document fingerprint is SHA-256
  (checked against the FIPS 180-2 vector).
* **Reading direction** — RTL opens with page 1 on the left, a forward turn
  moves the verso to the right, keys and pager buttons mirror, and gravity
  reaches the physics in the mirrored book frame for any tilt (checked against
  the inverse of the full book-root transform).
* **Themes** — a stored choice beats the system, a choice equal to the system
  is not stored; the scene palettes keep page irradiance within 8 % between
  themes while the dark key-to-fill ratio stays > 1.6× the light one.

---

## 3. Interaction state machine

Page-turning and 6-DoF handling share the same pointer. Conflicts are resolved
**once, at pointer-down**, by hit-testing; the decision is locked for the
whole gesture. The machine is a pure function
`(state, event) → (state, effects[])`, unit-tested without a DOM.

**Hit-testing respects the book's solids.** The pointer ray is cast against
the pages *and* the cover boards, the spine and the page blocks' walls. A pure
picker (`input/pick.ts`) then decides, nearest hit first, using only faces
turned towards the eye. A board, the spine or a block wall in front hides
everything behind it. A resting page can be taken only by its reading face
(the front of a sheet on the right stack, the back of one on the left); meeting
its underside means you are looking at the book from behind. Pages in flight
can be caught from either side. So a book rolled onto its back is handled by
its cover and never turns a page through it.

```
                 ┌──────────────── pointerdown on page (primary, no modifier) ─────────────┐
                 │                                                                          ▼
 ┌──────┐  down on background / Alt-drag    ┌─────────────┐            move > 4 px   ┌──────────┐
 │ Idle │ ────────────────────────────────▶ │ PressSpace  │                           │PressPage │
 └──────┘                                   └─────────────┘                           └──────────┘
   ▲  ▲  right/middle/Shift/Space down            │ move > 4 px                  up ◀─┤ │ move > 4 px
   │  │  ───────────────▶ Pan                     ▼                     (tap → auto-turn)│ ▼
   │  │                                         Orbit ── up ──▶ Idle (+ inertia)      ┌──────────┐
   │  │                                                                               │ PageDrag │
   │  └──────────── up / cancel (release page, keeps momentum) ◀──────────────────────┤          │
   │                                                                                  └──────────┘
   │        second touch in any state  ──▶  TwoFinger (pinch-zoom + pan + twist)
   └──────────────────────── all touches lifted ◀── TwoFinger / Settle
```

| State | Enters on | Pointer moves | Leaves on |
|---|---|---|---|
| `Idle` | — | hover cursor (grab/pointer) | `down` |
| `PressPage` | `down` on a grabbable sheet | > 4 px → `PageDrag` (grab at the *down* point) | `up` → tap → auto-turn |
| `PageDrag` | threshold crossed | hand target = ray ∩ drag surface | `up` → release (momentum kept); 2nd touch → release + `TwoFinger` |
| `PressSpace` | `down` on background, or Alt+drag anywhere | > 4 px → `Orbit` | `up` → click (double-click resets view) |
| `Orbit` | threshold crossed | turn about the book's spine, tilt about screen-horizontal (the face follows the hand) | `up` → inertial spin-down |
| `Pan` | right/middle button, Shift or Space held | translate in view plane | `up` → inertial glide |
| `TwoFinger` | 2nd touch | pinch → dolly to centroid, centroid → pan, twist → twist with the fingers | touches < 2 → `Settle` |
| `Settle` | a finger lifts in `TwoFinger` | ignored | all up → `Idle` |
| `SelectText` | `hold` (0.42 s still) in `PressPage` on text | extend the selection to the nearest caret | `up` → selection kept, Copy offered |
| `Annotate` | `down` on a resting page with a tool other than Read | pen / highlighter / eraser follow the pointer | `up` → the stroke, highlight or erasure is committed as one undo step |

Wheel: `ctrlKey` (trackpad pinch) or line-mode/large discrete deltas (mouse
wheel) → zoom towards the cursor; small pixel deltas (trackpad scroll) → pan.
Keyboard: ←/→ turn towards that side of the screen (so they swap meaning in
RTL books), ↓/PgDn and ↑/PgUp turn forward and back in reading order,
Home/End, +/− zoom, `0` reset, `F` fullscreen.

**Drag surface.** The pointer ray is intersected with a height-field
`z = Z(x)` along the book: flat at the grab's rest height near the grab, rising
smoothly as `A·sin²(π/2·(x₀−x)/x₀)` (zero slope at the start, so small drags
stay low and produce a delicate peel; maximum `A ≈ 0.55·x₀` over the spine)
and descending to the opposite stack. The hand target follows the ray
intersection; the physics decides the actual shape.

**6-DoF handling.** The book is the manipulated object (lights stay fixed in
the world, so the paper's sheen and shadows move as you tilt it). Pose =
critically-damped springs on turn, tilt, twist, pan and dolly, with release
velocity carried into exponentially decaying inertia. Zoom dollies towards the
point under the cursor so that point stays fixed on screen.

**Rotation is direct manipulation about a book's own axes.** The face turned
towards the reader swings with the hand, as when turning a real book:

| Gesture | Axis | Effect |
|---|---|---|
| horizontal drag | the book's **spine** (its longitudinal axis) | drag right: the face swings right, the left page comes towards you, the right page goes back. Keep going and the book rolls onto its back cover |
| vertical drag | the screen's horizontal axis | drag down: the face swings down towards you and the head rises, as when lifting a book to read (+34° holds it upright) |
| two-finger twist | the line of sight | the book turns with the fingers |

The pose is `R = R_sight(twist) · R_x(tilt) · R_spine(turn)` (with the base
pose, `R_spine(turn) = R_z(−turn)` in world terms).

*Why these axes.* The first version yawed about world-up. With the book lying
back under a 56° view, world-up is the book's *normal*, so a horizontal drag
spun the book flat like a lazy Susan. Its near edge went one way and its far
edge the other, the face never turned, and either sign felt backwards
somewhere. A free trackball (rotation about screen axes) always moves the face
with the cursor, but circling drags accumulate a roll: the spine drifts off
vertical and the book ends up lying crooked. Turning about the spine and
tilting about the screen-horizontal axis are exactly the rotations that keep
the spine in the screen's vertical plane. So the book can never drift crooked,
retracing a drag retraces the pose (the angles simply add), and both motions
are what hands do with a book.

*How exact the "follows the hand" claim is.* In the un-twisted frame the visible
normal moves on screen by `J·(Δturn, Δtilt)` with

```
      ⎡ |cos ψ|                   0                ⎤
  J = ⎢                                             ⎥     ψ = turn, p = tilt, e = 56°
      ⎣ ±sin ψ·cos(p+e)    |cos ψ|·sin(p+e)        ⎦
```

The diagonal (the direct terms) is never negative across the tilt range
−32°…85°, so horizontal and vertical drags always follow the hand. The
off-diagonal term is the inclined spine: with the book lying back, the spine
leans 34° towards the reader, so turning also swings the face slightly up or
down. It can outweigh the direct terms only for diagonal drags on a book turned
nearly edge-on; while the face is within ~72° of the reader (`|n·eye| ≥ 0.3`)
the symmetric part of `J` is positive definite, so every drag direction
follows. With the book upright (p = 34°) the off-diagonal vanishes and a
horizontal drag turns it like a door.

Twists are about the line of sight and so follow the fingers exactly. Drags
are read in the un-twisted frame (rotated back by the current twist), so a
twisted book still follows the hand. The tilt is limited to −32°…85°, which
stops well before the spine would point along the line of sight, where turning
about it would degenerate into a spin on screen. Panning is a translation and
follows the hand.

---

## 4. Rendering & ingestion architecture

```
File (drop / picker)
   └─▶ ArrayBuffer ──▶ pdf.js worker (parse)  ──▶ pdf.js renderer worker (rasterise, OffscreenCanvas)
                                                        │ ImageBitmap
                                                        ▼
                         TextureManager: LOD tiers 256…4096 px, LRU byte budget, priority queue,
                                         detail tiles at screen-native resolution for close-ups
                                                        │ THREE.Texture (mipmapped, anisotropic)
 three.js scene ◀────────────────────────────────────────┘
   ├─ Camera (fixed) · key light (soft PCF shadows) · hemisphere fill · RoomEnvironment PMREM
   │    (intensities, colours and shadow density from the theme's ScenePalette)
   ├─ Shadow-catcher ground
   └─ BookRoot (pose from ViewController; scale x = −1 for right-to-left books)
        ├─ Cover boards + spine (stamped cloth: gilt artwork + roughness/metalness maps)
        ├─ Page blocks L/R (built from the resting top sheet's own underside; page-edge walls)
        ├─ Resting top sheet L/R  (SheetMesh at rest configuration)
        └─ Flying sheets          (SheetMesh driven by SheetSim)
```

**SheetMesh.** The physics uses 24 hinges; rendering refines each hinge into 4
sub-hinges carrying `ψ_k/4` (curvature spread uniformly over the hinge cell).
This is still an exact isometry, but now smooth to the eye. A 72×48 grid (denser near
the spine) is deformed on the CPU from cached strip transforms; normals come analytically
from strip rotations and are interpolated across sub-strips. Front and back
faces are offset by ±t/2 along the normal and use separate textures.

**Page blocks.** The stack under a resting top sheet is drawn as a block. Its
top is that sheet's stack-facing face (`SheetMesh.stackFace`) pushed a further
`BLOCK_GAP` = 0.12 mm along the normal. It uses the **same render grid and
triangulation** as the sheet, so the two surfaces are parallel triangle by
triangle. The gap therefore holds everywhere: in the domed gutter, under a
conical (`p ≠ 0`) sheet's corners, and between grid vertices, where the chord
sagitta of one surface is matched exactly by the other. The top is clamped to
the board, is never the first thing a pointer ray meets, and also carries a
large polygon offset (factor 4, 32 units). The slope factor covers grazing
views; the units cover face-on views, where the slope term vanishes. The head,
tail and fore-edge walls rise from the board to the sheet's actual underside
edges, so the stack meets the page without a seam. (The first version extruded
a 1-D gutter profile with a 0.2 mm floor. That floor rose above the sheets of
thin stacks, and face-on it showed as pale bands across the page.)

**Covers.** Every document is bound the same way: classic stamped book cloth
carrying only the Explica marks, never the document's title. Each canvas is drawn
at the face's own aspect ratio (about 7 px per mm), and the marks scale with the
board, so nothing is stretched and every book size keeps the same proportions:

- **Front cover:** a double-rule frame with crossed Oxford corners, the EXPLICA
  wordmark in letter-spaced capitals, a short rule, and the Explica device (an open
  book with a leaf unfolding, in a double ring) as line art.
- **Back cover:** the frame, the device and a small imprint.
- **Spine:** paired rules at head and tail, and EXPLICA running head to tail.
- **Hinge groove:** shaded beside the spine on each cover.

The cloth is a plain weave with slubbed threads; its normal map is tiled per
face in weave repeats per metre, and the boards' thin edges have UVs measured in
repeats too. A second map gives the gilt foil metalness 1 and roughness 0.34
(cloth 0.88), so it glints as the book is tilted under the fixed lights. The
board under the verso stack is the front cover. Because RTL books are drawn
through a mirror, the artwork is redrawn, its groove moved to the other side,
and flipped in u, so it still reads correctly.

**Tone mapping.** Khronos PBR Neutral, which keeps paper white and ink black
(AgX/ACES visibly grey a white page).

**Paper material.** `MeshPhysicalMaterial` (roughness 0.74, sheen for the
grazing-angle lustre of calendered paper, procedural fibre normal map) with an
`onBeforeCompile` patch that adds: a warm paper tint, **show-through** of the
reverse page (paper is translucent), **gutter ambient occlusion**, and the
**detail-tile** lookup for close-ups. Self-shadowing comes from a tight
2048² PCF-soft shadow map fitted to the book.

**Crisp text at any distance.** Each frame the TextureManager estimates every
visible page's on-screen footprint in device pixels and requests the next LOD
tier above it (max 4096 px or GPU limit). When the footprint exceeds the base
tier (deep zoom), it renders a **detail tile** — just the visible UV
rectangle, at native resolution — and the shader samples it inside that
rectangle. Mipmaps + max anisotropy keep oblique views sharp.

**Memory.** Textures live in an LRU keyed by `(page, tier)` with a byte budget
(360 MB, 140 MB and a 2048 px tier cap on devices reporting ≤ 4 GB). Neighbouring pages are pre-fetched
at low tiers, far pages are evicted, pdf.js page objects are `cleanup()`-ed,
and in-flight renders are cancelled when they become irrelevant.

**Frame pacing.** Rendering is on demand: frames are drawn only while physics,
inertia or texture uploads are active, so an idle book costs nothing.

**Selectable text.** The text of the open spread can be selected and copied:

- *Extraction.* `PageSource.textContent` returns runs in page points.
  - For PDFs: pdf.js `getTextContent()`, mapped through the page's own viewport,
    so rotation and `/Rotate` are applied, and cached per page.
  - For the built-in book: a recording of its own `fillText` calls.
- *Placement.* Once the book has settled (nothing in flight, no turns queued,
  the view at rest for 0.12 s), every run gets a transparent `<span>` in a
  fixed overlay (`user-select: text`). The corners of each run's box (ascent
  0.82, descent 0.24 of the font size) are projected onto the screen through:
  1. the page's letter-box rectangle;
  2. the RTL print flip;
  3. the resting sheet's real, curled shape (its hinge chain at rest);
  4. the camera.

  A CSS affine then maps the span onto those three points. So the text follows
  the paper into the gutter and carries the view's perspective, accurately at
  the scale of a run. A page turned more than about 75° from the eye is hidden.
  The layer is re-placed whenever the pose or viewport changes, and hidden while
  anything moves; a selection survives that and reappears in place.
- *Interaction.* The overlay never takes pointer events, so the canvas keeps
  every click and drag. The decision is made at pointer-down, as for all
  gestures:
  - a click turns the page;
  - a drag peels it;
  - a press held still for 0.42 s on text (the `hold` event) enters
    `SelectText`: the word is selected, dragging extends the selection with
    carets placed from measured character advances, and release ends it.

  It is an ordinary DOM selection, so ⌘/Ctrl+C copies natively. ⌘/Ctrl+A selects
  the open pages, Esc clears, and a Copy button serves touch screens.

**Robustness across documents.**

- Sheet meshes carry a fixed bounding sphere from construction: the spine is
  fixed and paper cannot stretch, so `hypot(W, H/2)` bounds every point. Before
  this, three.js computed a sphere lazily on the first raycast. That raycast
  could come from a zoom, before a hidden sheet was ever posed, giving a
  zero-radius sphere that was cached for good. The sheet was then missed by
  every pick and culled whenever the spine left the screen.
- Zoom anchors ignore hidden objects; raycasts do not check `visible`.
- A press from a pointer whose release never arrived (a dialog, a dropped
  file) ends that gesture instead of being swallowed.
- Loading a document resets the gesture machine and the view's drag state.

**As a package.** `src/index.ts` is the npm entry: `ExplicaApp`, the page sources
and the public types. The app's chrome (`src/ui/` apart from the text layer) is
not part of it. pdf.js is told where its workers and data live through
`configurePdfjs`. The app passes the URLs Vite emits for its own bundle, in a
module loaded with pdf.js on the first PDF. The package defaults to copies of
the workers shipped beside its module, named with `new URL('./…',
import.meta.url)` so that the consumer's bundler emits them. `ExplicaApp.dispose()`
releases everything an instance holds: the frame loop, every listener (one
`AbortController` per owner), the document and its source, GPU resources and the
WebGL context. Since the text layer is positioned in viewport pixels, its pose
includes the canvas' place on the page, and it follows a scrolling page.

---

## 5. Reading direction & colour themes

### 5.1 Right-to-left books as a mirror image

A right-to-left book (Persian, Arabic, Hebrew, Urdu…) is the mirror image of a
left-to-right one. It opens with the unread pages on the left, page 1 is the
left-hand page, and pages travel from left to right. Explica uses this literally.
There is **one book frame** for both directions. In it the unread stack is
always on the right (`+x`) and a forward turn always crosses the spine from
`+x` to `−x`. The layout, the hinge-chain physics, the drag surfaces, auto-turns
and the gesture machine are all unaware of direction. An RTL book is drawn
through the reflection `M = diag(−1, 1, 1)` on the book root:

```
world = T · R_view · R_base · M · book
```

Everything that crosses the boundary between the book frame and the world goes
through the full transform, so it stays consistent automatically:

* **Picking and dragging** — pointer rays are mapped into the book frame with
  the inverse book-root matrix (which includes `M`), so a drag to the right on
  screen is a drag towards `−x` in the book frame, exactly as the physics
  expects.
* **Gravity** — `g_book = M⁻¹ · (R_view R_base)⁻¹ · g`. The view supplies the
  bracket and `toBookFrame` flips x (`M⁻¹ = M`). A unit test checks this
  against inverting the whole book-root matrix for random tilts.
* **Rendering** — three.js flips the front-face winding for objects whose world
  matrix has a negative determinant, so culling, shadows and normals stay
  correct.

Only the print must not be mirrored. The paper shader reads page content at
`sheetUv = (1 − u, v)` when `uFlipPrint = 1`. The reverse-page show-through,
the letter-box rectangle (symmetric in x) and the detail-tile rectangle (its
`u ↦ 1 − u` is applied in `visibleContentRect`) all follow from that single
flip. The gutter occlusion still uses the geometric uv, because the spine has
not moved on the sheet.

The UI translates screen sides into the book frame. ← and → (and the pager
button on each side) turn towards that side of the screen, so in RTL ← moves
forward. The slider runs right-to-left. The folio is written in reading order
("2–3 / 48") and laid out with `dir="rtl"`, so it shows "48 / 3–2", matching
the pages as they lie, while screen readers still read it in order. Portrait
framing centres the left-hand page.

Toggling the direction carries the reading position, and any page in flight,
over unchanged, because the logical book does not change.

**Every PDF opens in its own direction**, without changing the reader's saved
preference:

1. If it declares `/ViewerPreferences /Direction /R2L` (or `/L2R`), that wins.
2. Otherwise the text of its first pages (up to eight, until about 4 000
   characters) is sampled through the same `getTextContent` path the text layer
   uses. Strong right-to-left letters (`\p{Script=Arabic}`, which covers
   Persian and Urdu, plus Hebrew, Syriac, Thaana, N'Ko, Adlam and others) are
   counted against all other letters; digits and punctuation are neutral. The
   majority decides once at least 24 letters were seen.
3. A scanned PDF with no text keeps the preference.

The LTR / RTL switch shows the result and can change it at any time.

The built-in sample document re-typesets itself for the direction: running
heads, folios and the corner hint swap sides. Its text block and title are laid
out symmetrically, so the text itself never moves and annotations stay on it.
Its textures are marked stale and re-rendered, and the old rasters stay on
screen until the new ones arrive, so nothing flashes blank.

### 5.2 Colour themes

The interface is built on **semantic design tokens** defined once per theme on
`:root` / `:root[data-theme="dark"]`:

| Layer | Tokens |
|---|---|
| Backdrop (the "table" behind the transparent canvas) | `--backdrop-0/1/2` (registered `<color>` properties, so the radial gradient cross-fades) |
| Glass over the book | `--surface-bar` (toolbar, pager), `--surface-panel` (settings, cards, dialogs, toasts) |
| Controls on a surface | `--fill-1/2/3` (rest, hover, pressed/selected), `--surface-raised` + `--shadow-raised` (switch thumbs) |
| Lines | `--hairline`, `--hairline-strong` |
| Text | `--text-1/2/3` (body ≥ 4.5:1 on panels in both themes) |
| Accent & focus | `--accent`, `--accent-hi`, `--accent-ink`, `--on-accent`, `--focus-ring` |
| Motion | `--dur-fast`, `--dur`, `--dur-theme` with one easing curve |

The system preference (`prefers-color-scheme`) is the default. The top-bar
switch stores a choice only while it differs from the system, so switching
back resumes following the system. `public/theme-boot.js` applies the theme
before first paint (a same-origin file, so the CSP needs no inline script),
and transitions are suppressed until the app has painted once.

The 3D scene follows the theme through a `ScenePalette`, blended over the
same 0.45 s as the CSS backdrop:

| | key light | fill (sky / bounce) | ground shadow |
|---|---|---|---|
| Dark — a reading lamp in a dim room | 2.1, warm | 0.55, dark bounce | 0.42 opacity: dense enough to read on a dark backdrop |
| Light — daylight in a pale room | 1.72, neutral | 0.92, pale bounce | 0.24 opacity: a pale backdrop shows shadows readily |

The light theme moves light from the key into the fill, so self-shadows on the
paper are softer. Irradiance on an upward-facing page stays within a few
percent between the two, so paper is equally white in either theme (measured
in the browser: 248/244/240 in light, 247/241/233 in dark).

**First paint.** `theme-boot.js` (a synchronous script in `<head>`) sets the
theme and a `preload` class before the body is parsed. A few lines of inline
critical CSS paint the theme's backdrop and keep every element hidden while
`preload` is set. In development the stylesheet is injected by script after
the markup has been parsed, and before this the raw controls (unsized SVG icons,
bare buttons, a white page) could flash for a moment. The app removes `preload`
after its first frame; the "WebGL 2 is required" fallback removes it too.

---

## 6. Annotations

**Model.** Highlights, ink strokes and notes are stored in *page coordinates*:
fractions of the page's width and height from its top-left (y down), with
widths as fractions of the page width. They are independent of resolution,
zoom, sheet size and reading direction.

| Kind | Data |
|---|---|
| Highlight | quads around the selected characters (exact to the character, from the text runs' measured advances), colour, the text |
| Stroke | polyline (Ramer–Douglas–Peucker simplified at 0.0004 page widths), colour, width |
| Note | anchor point and text |

**Rendering: in the page, not over it.** Each annotated page gets a canvas
texture at the page's aspect ratio (up to 2048 px) holding its marks. The paper
shader samples it in the page's content coordinates (the same letter-box
rectangle and RTL flip as the print) and composites with a **darken** blend,
`mix(paper, min(paper, mark), α)`. A light highlighter colour tints white paper
but leaves black type black, and dark ink simply shows. Because the marks are
part of the page surface, they bend into the gutter, ride on a page as it
turns, tilt with the book and stay sharp at any zoom with no projection of
their own. Textures are redrawn only when their page's annotations change;
least-recently used ones are dropped beyond twelve pages.

**Input.** A rail of tools: Read (default), Highlight, Pen, Note, Eraser.

- **Read:** every gesture keeps its reading meaning. Note marks show their text
  in a preview while the pointer rests on them.
- **Other tools:** at pointer-down on a resting page's reading face (and nothing
  in flight), the hit is flagged `annotate`, and the gesture machine enters
  `Annotate` at once: no threshold, no tap/drag distinction. A press that
  starts elsewhere still handles the book; Alt, Shift, Space and the right
  button keep orbiting and panning.
- **Screen to page:** a screen point is mapped to page coordinates by raycasting
  the resting sheet's reading face and taking its uv back through the RTL flip
  and the letter-box rectangle.
- **Highlight:** drag across text, caret to caret. A tap highlights a word.
- **Pen:** freehand. Crossing the spine ends the stroke and starts one on the
  other page.
- **Note:** a click pins a note and opens its editor, anchored on screen by
  projecting the note's page point through the resting sheet's shape. Clicking
  a note again edits it; an emptied note is removed.
- **Eraser:** removes whatever it touches, measured isotropically in
  page-width units.
- **Selected text:** a floating toolbar offers Copy, five highlight colours, and
  Remove when the selection touches an existing highlight.

**Storage.** One JSON record per document in `localStorage`
(`explica.annotations.<key>`), with coordinates rounded to 1/100 000 of a page.

- **Key for PDFs:** `sha256:` of the file's bytes (above 64 MB, of its first
  and last 32 MB and its length), computed before pdf.js takes the buffer. The
  same file finds its annotations again under any name. Nothing is written into
  the PDF or exported.
- **Key for the sample document:** a fixed one.
- **Loading:** data read back is shape-checked entry by entry, so corrupt or
  foreign records cannot break a document.
- **Undo:** changes are grouped into undoable steps, one per gesture (an eraser
  pass that removed nothing leaves no step), with undo and redo on ⌘/Ctrl+Z and
  ⇧⌘/Ctrl+Z. A storage failure (quota) keeps the annotation for the visit and
  says so.

