# Explica

*Explicāre* (Latin): to unfold, to open out.

**A book that behaves like one.** Explica turns any PDF on your device into a
physically simulated 3D book in the browser. Pages bend but never stretch, have
weight, stiffness and momentum, and answer the way you pull them: a slow peel
curls a corner, a flick throws the page over, a page in the air can be caught,
and tilting the book changes how pages fall. Right-to-left books (Persian,
Arabic, Hebrew…) are recognised and open and turn the right way round. You can
select, copy and highlight text, write on the pages and pin notes to them. The
interface has light and dark themes.

Nothing is uploaded. There is no backend. The PDF is read with the File API,
parsed and rasterised by pdf.js in Web Workers, and goes only to your own GPU.
A Content-Security-Policy (`connect-src 'self'`) stops the page from contacting
any other origin.

## How it works

The full model is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). In short:

- **Paper as a developable surface.** Each sheet is a chain of rigid strips
  hinged along straight rulings that fan out from an apex on the spine line (a
  discrete cone; a cylinder in the limit). The sheet is inextensible by
  construction, not because a penalty stops it stretching. Generalised
  coordinates: `q = (p, ψ₀ … ψ₂₃)`, where `p` is the fan convergence and `ψ`
  are the hinge angles.
- **Mechanics.** Kirchhoff–Love bending `½D∫κ²dA` (closed form per hinge for
  cones), gravity in the book frame, the binding's torsion spring,
  sheet-on-sheet contact, a compliant hand, quadratic air drag and visco-elastic
  damping. Parameters are SI: 80 g/m² paper has D ≈ 2.5·10⁻⁴ N·m.
- **Integration.** Implicit Euler written as an incremental potential over `q`,
  solved by Gauss–Newton with analytic twist Jacobians, an O(n²) strip-block
  assembly and a line search. Fixed 240 Hz step and fully deterministic.
  A page in flight costs about 0.15 ms per step.
- **Interaction.** A pure state machine decides at pointer-down whether a
  gesture turns a page (it started on paper) or handles the book (it started
  anywhere else), so the two never conflict. The book is the object you move,
  by direct manipulation about its own axes: drag sideways to turn it about its
  spine, up or down to tilt it towards you, twist to rotate it, plus pan and
  cursor-anchored zoom, all with springs and inertia.
- **Rendering.** three.js with `MeshPhysicalMaterial` paper (sheen, fibre
  normal map) patched for show-through of the reverse page, gutter occlusion and
  letter-boxing. Soft PCF shadows, PBR Neutral tone mapping, and a frame is
  drawn only when something changes.
- **Crisp text at any distance.** Pages are rasterised to the LOD tier their
  on-screen size needs (256–4096 px). At close range a native-resolution tile of
  just the visible region is rendered and blended in. Textures are kept in an
  LRU cache with a byte budget.

## Use it

| Action | Mouse / trackpad | Touch | Keys |
|---|---|---|---|
| Turn a page | drag it (slow peel or brisk flick), or click it | drag | ← → PgUp PgDn |
| Catch a page | grab it in mid-air | grab | |
| Turn & tilt | drag the background, or Alt-drag: the book's face follows your hand (sideways turns it about the spine, up/down tilts it towards you) | one-finger drag on background | |
| Pan | right/middle-drag, Shift- or Space-drag, two-finger scroll | two-finger drag | |
| Zoom | wheel, pinch | pinch | + − |
| Twist | | two-finger twist (the book turns with your fingers) | |
| Copy text | press and hold on a line until a word lights up, then drag | same, then **Copy** | ⌘/Ctrl+C copies, ⌘/Ctrl+A selects the open pages, Esc clears |
| Highlight | select text and pick a colour, or the **Highlight** tool and drag across text | same | H |
| Write, pin notes, erase | **Pen**, **Note** and **Eraser** tools on the left rail | same | P, N, E; R returns to reading; ⌘/Ctrl+Z / ⇧⌘/Ctrl+Z undo and redo |
| Reset view | double-click background | | 0 |
| Jump | page slider | page slider | Home End |
| Reading direction | **LTR / RTL** switch in the top bar | same | ← → follow the screen, so they swap in RTL; ↓ ↑ PgDn PgUp follow reading order |
| Theme | **Light / Dark** switch in the top bar (follows the system until you choose) | same | |

The **Paper & physics** panel sets grammage (D ∝ t³), stiffness, binding
tension and air resistance, and has presets from bible paper to card stock.

In **RTL** mode page 1 opens on the left and pages turn from left to right onto
the right-hand stack. The page slider, the folio and the pager buttons are
mirrored. Every PDF opens in its own direction: what its `/ViewerPreferences
/Direction` declares, or else what the script of its first pages says (strong
Arabic-script, Hebrew and other right-to-left letters against left-to-right
ones). The switch still changes it at any time. Internally an RTL book is the
same book drawn through a mirror, with only its print flipped back (see the
architecture doc, §5).

**Annotations stay on this device and never touch the file.** Highlights, ink
and notes are kept in the browser's storage under a SHA-256 fingerprint of the
PDF's bytes, so they come back whenever the same file is opened again, and a
renamed copy finds them too. They are drawn into the page surface itself, so
they curl, turn and tilt with the paper. In **Read** mode, the default, every
gesture keeps its reading meaning; the other tools act only on the open pages.

## Use it in your own app

Explica is also an npm package: the 3D book as a component for your own page,
without the app's toolbar and dialogs.

```bash
npm install explica
```

Give it a canvas sized with CSS (the drawing buffer follows the canvas'
size), then load a document:

```html
<canvas id="book" style="width: 100%; height: 80vh; display: block"></canvas>
```

```ts
import 'explica/style.css'; // the selectable text layer
import { ExplicaApp, PdfSource, WelcomeSource } from 'explica';

const book = new ExplicaApp(document.querySelector<HTMLCanvasElement>('#book')!);
await book.load(new WelcomeSource()); // the built-in sample document

// a PDF from a file input or a drop: read on the device, never uploaded
input.addEventListener('change', async () => {
  const file = input.files![0];
  const pdf = await PdfSource.open(await file.arrayBuffer(), file.name);
  book.setDirection(pdf.direction ?? 'ltr'); // RTL books open right to left
  await book.load(pdf); // the book now owns `pdf` and destroys it when replaced
});
```

Everything you need is exported from `explica`:

| Export | What it is |
|---|---|
| `ExplicaApp` | The book: physics, rendering, gestures, text layer and annotations on one canvas. `load(source)`, `turn(±1)`, `jumpTo(page)`, `setDirection('ltr' \| 'rtl')`, `setTheme('light' \| 'dark')`, `setPaper(params, airScale)`, `setTool(tool)`, `undo()`, `redo()`, `dispose()` |
| `PdfSource` | A PDF opened by pdf.js: `PdfSource.open(bytes, name, { onProgress, onPassword })` resolves with its page count, its `direction` (declared or detected) and its annotation `key` (SHA-256 of the bytes) |
| `WelcomeSource` | The built-in sample document, typeset procedurally |
| `PageSource` | The interface both implement, if you want to feed the book your own pages |
| `configurePdfjs` | Where pdf.js finds its workers and data (see below) |
| `paperForGrammage`, `DEFAULT_PAPER` | Paper presets for `setPaper` |
| `HIGHLIGHT_COLORS`, `PEN_COLORS`, `PEN_WIDTHS` | The annotation palettes, for building your own tool UI |

The app reports through callbacks you assign: `onSpread` (page, page count,
document and direction after every turn), `onTextSelection`, `onToolChange`,
`onHistory` (undo / redo availability), `onNoteOpen`, `onNoteMove`,
`onNotePeek`, `onStorageError` and `onKeyCommand` (for keys the book does not
handle itself, such as `o` for open or `f` for full screen). Call `dispose()`
when you remove the book: it stops the frame loop, detaches its listeners,
frees the GPU memory and the WebGL context, and destroys the open document.

**pdf.js.** The package ships pdf.js's two workers next to its module, and
bundlers that understand `new URL('./file', import.meta.url)` emit them with
your build: Vite (dev server and build), webpack 5, Parcel and Rollup with an
asset plugin. To serve them from somewhere else, for example under a strict
Content-Security-Policy, point pdf.js at them before opening a PDF:

```ts
import { configurePdfjs } from 'explica';

configurePdfjs({
  workerSrc: '/static/pdf.worker.min.mjs', // from explica/pdf.worker.min.mjs
  rendererSrc: '/static/pdf.renderer.min.mjs', // from explica/pdf.renderer.min.mjs
  assetsUrl: '/static/pdfjs/', // see below
});
```

pdf.js also reads CMaps, standard fonts, wasm image decoders and ICC profiles
on demand from `assetsUrl` (default: `pdfjs/` next to your page). Most PDFs
open without them, but CJK text that uses predefined CMaps, non-embedded
standard fonts and JPEG 2000 / JBIG2 images need them. Copy the folders from
the pdf.js release the package installs, for example into Vite's `public/`:

```bash
mkdir -p public/pdfjs && cp -R node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm,iccs} public/pdfjs/
```

**Good to know.**
- The book needs WebGL 2.
- three.js and pdf.js are dependencies of the package, not bundled into it.
- The text layer is laid out in viewport pixels (`position: fixed`), so it
  stays on the paper wherever the canvas sits and as the page scrolls.
  `--explica-selection` sets the selection colour.
- Keyboard shortcuts listen on `window` and ignore typing in form fields.
- Annotations are saved in `localStorage` under `explica.annotations.<key>`.

## Develop

Requires Node ≥ 22.13.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run verify
```

- `npm test` runs the deterministic physics and interaction suite (Vitest,
  Node, no DOM). It covers isometry, spine invariance, Jacobians against finite
  differences, gradient consistency, the closed-form cone stiffness, an
  Euler–Bernoulli cantilever check (< 2 % error), energy behaviour, momentum,
  flick and peel behaviour, the resting equilibrium, bit-exact replay, the
  gesture state machine, page picking (covers hide the pages behind them),
  the page block's clearance under the resting sheet, direct-manipulation
  rotation (the face follows the hand in every pose, without drift), the right-to-left
  mapping (including gravity in the mirrored book frame), theme resolution and
  the scene lighting palettes.
- `npm run build` typechecks and writes a static site to `dist/` with relative
  URLs, so it works from any sub-path. pdf.js CMaps, standard fonts and wasm
  decoders are copied next to it, so nothing is fetched from a CDN.
- `npm run build:lib` builds the npm package into `lib/`: an ES module from
  `src/index.ts` (Vite library mode, three.js and pdf.js left as dependencies),
  pdf.js's workers, the text-layer stylesheet and the TypeScript declarations
  (with explicit `.js` extensions, so `moduleResolution: nodenext` resolves
  them). `npm publish` runs it, after the typecheck and the tests.
- `npm run verify` is the gate before every commit and push: repository policy
  checks (one workflow under a rotated name; locally, one commit identity, clean
  messages and refs, and a workflow rotated since the last commit), then
  typecheck, tests and the production build.
- `npm run rotate:workflow` moves the workflow to a file name GitHub has never
  seen (`<slug of its name>-<UTC date>-<UTC time>.yml`), so each push's run is
  numbered #1. It is the first step of every push.

## Deploy to GitHub Pages

The workflow in `.github/workflows/` runs one pipeline: a `verify` job (`npm run
verify`) on every push and pull request, then a `deploy` job that publishes
`main` to GitHub Pages. Its file name changes on every push, so refer to it by
its directory, never by name. To enable deployment: push the repository to
GitHub, then open **Settings → Pages** and set **Source** to **GitHub
Actions**.

## Layout

```
src/
  index.ts   the npm package's entry (vite.lib.config.ts builds it into lib/)
  physics/   hinge-chain kinematics, bending, surfaces, implicit integrator, equilibrium
  book/      book layout (stacks, sheets, spreads), automatic turns, reading direction
  input/     gesture state machine, DOM adapter, drag surfaces
  view/      6-DoF book handling with inertia
  render/    stage, scene palettes, sheet meshes, paper material, stamped covers, page blocks
  pdf/       page sources (pdf.js, built-in sample document), texture LOD manager
  annotate/  highlights, ink and notes: model, storage, page textures
  ui/        toolbar, pager, settings, dialogs, theme, design tokens (styles.css)
public/      theme-boot.js (applies the theme before first paint)
scripts/     rotate-workflow.mjs, check-repo.mjs (repository policy for `npm run verify`),
             dts-extensions.mjs (declaration imports for the package)
tests/       physics, interaction, view, direction and theme suites
docs/        architecture and mathematical model
```

## License

MIT. pdf.js is Apache-2.0 (the package redistributes its two workers, with
their licence headers); three.js is MIT.
