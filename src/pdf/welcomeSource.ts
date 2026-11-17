import type { PageRegion, PageSource, TextRun } from './pageSource';
import type { ReadingDirection } from '../book/readingDirection';

const PW = 420; // A5 in points
const PH = 595;
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = '#1d1a16';
const MUTED = '#6b6257';
const ACCENT = '#8a3b1f';

type Block =
  | { kind: 'h'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'eq'; text: string }
  | { kind: 'li'; head: string; text: string }
  | { kind: 'gap'; h: number }
  | { kind: 'fan' }
  | { kind: 'micro' };

interface PageSpec {
  run?: string;
  blocks?: Block[];
  draw?: (g: CanvasRenderingContext2D, left: boolean) => void;
}

const PAGES: PageSpec[] = [
  { draw: titlePage },
  {
    run: 'Holding the book',
    blocks: [
      { kind: 'h', text: 'Holding the book' },
      { kind: 'p', text: 'Explica is a book you handle, not a viewer you scroll. Every gesture is decided where it starts: on paper it moves paper, anywhere else it moves the book.' },
      { kind: 'gap', h: 6 },
      { kind: 'li', head: 'Turn a page', text: 'Drag it from anywhere — slowly to peel a corner, briskly to flick it over. Click a page, or press ← →, to turn it for you.' },
      { kind: 'li', head: 'Catch a page', text: 'Grab a page while it is still in the air.' },
      { kind: 'li', head: 'Turn & tilt', text: 'Drag the background, or hold Alt and drag anywhere: sideways turns the book about its spine, down lifts it towards you.' },
      { kind: 'li', head: 'Pan', text: 'Right-drag, Shift-drag, Space-drag or two-finger scroll.' },
      { kind: 'li', head: 'Zoom', text: 'Scroll wheel, trackpad pinch, or + and −. Zoom follows the cursor.' },
      { kind: 'li', head: 'Reset', text: 'Double-click the background, or press 0.' },
      { kind: 'li', head: 'Touch', text: 'One finger turns pages or tilts the book; two fingers pinch, pan and twist.' },
    ],
  },
  {
    run: 'Paper is not cloth',
    blocks: [
      { kind: 'h', text: 'Paper is not cloth' },
      { kind: 'p', text: 'A sheet of paper bends at the slightest touch, yet it practically cannot stretch. Gauss’s theorema egregium then forbids its Gaussian curvature from ever leaving zero: every curl of a page is a developable surface, swept by straight rulings along which the paper stays flat.' },
      { kind: 'p', text: 'So Explica never simulates a stretchy mesh. Each sheet is a chain of rigid strips hinged along rulings that fan out from a point on the spine line — a discrete cone, which becomes a cylinder when the apex runs off to infinity. Stretching is not penalised; it is impossible by construction.' },
      { kind: 'fan' },
    ],
  },
  {
    run: 'Energy',
    blocks: [
      { kind: 'h', text: 'Energy' },
      { kind: 'p', text: 'For a plate whose Gaussian curvature vanishes, the Kirchhoff–Love bending energy collapses to a single term:' },
      { kind: 'eq', text: 'E = ½ D ∬ κ² dA,     D = E t³ ⁄ 12 (1 − ν²)' },
      { kind: 'p', text: 'Each hinge stores ½ cₖ ψₖ², with cₖ the flexural rigidity integrated over its ruling and divided by the local strip width — exact for both cylinders and cones. Gravity, the torsion spring of the binding, the stack beneath, and the hand that holds the page complete the potential; air drag ½ ρ C_d A v² and visco-elastic losses dissipate it.' },
      { kind: 'p', text: 'For 80 g/m² paper D ≈ 2.5 × 10⁻⁴ N·m. Its elasto-gravity length (D ⁄ ρg)^⅓ ≈ 7 cm is shorter than the page — which is why a lifted page droops and curls over instead of swinging like a board.' },
    ],
  },
  {
    run: 'Time',
    blocks: [
      { kind: 'h', text: 'Time' },
      { kind: 'p', text: 'Paper is stiff in the numerical sense: its fastest bending mode is three hundred times quicker than a page turn. Explica therefore takes implicit Euler steps, posed as the minimum of an incremental potential over the strip angles:' },
      { kind: 'eq', text: 'qₙ₊₁ = argmin  Σ mᵢ ⁄ 2h² ‖xᵢ(q) − x̃ᵢ‖² + E(q) + h R' },
      { kind: 'p', text: 'Gauss–Newton with an analytic Jacobian and a line search solves each 1⁄240 s step in a fraction of a millisecond. Because inertia is measured on the true, nonlinear kinematics, a fast flick straightens the page by itself.' },
      { kind: 'p', text: 'There is no randomness anywhere: the same gesture always produces the same page turn, bit for bit — which is what lets the mechanics be tested.' },
    ],
  },
  {
    run: 'Light',
    blocks: [
      { kind: 'h', text: 'Light' },
      { kind: 'p', text: 'The book is the object you move; the lamp stays put. Tilt it and the soft sheen of the paper slides across the page, while the curling sheet throws a soft shadow on the stack beneath.' },
      { kind: 'p', text: 'Paper is translucent, so the reverse page shows faintly through. The gutter darkens where the sheets dive into the binding. Text is rasterised for the size it occupies on screen; zoom in and a native-resolution tile of exactly what you are looking at replaces it.' },
      { kind: 'p', text: 'Nothing is drawn when nothing moves: an idle book costs no power at all.' },
    ],
  },
  {
    run: 'Things to try',
    blocks: [
      { kind: 'h', text: 'Things to try' },
      { kind: 'li', head: 'Peel', text: 'Lift a corner a little and let go. It sighs back onto the stack.' },
      { kind: 'li', head: 'Flick', text: 'Throw a page hard: it overtakes your hand and slaps down.' },
      { kind: 'li', head: 'Catch', text: 'Turn several pages quickly, then snatch one out of the air.' },
      { kind: 'li', head: 'Tilt', text: 'Stand the book up while a page is in flight. Gravity is real here.' },
      { kind: 'li', head: 'Paper', text: 'Open the settings and turn the pages into card stock — or tissue.' },
      { kind: 'li', head: 'Zoom', text: 'Get as close as you like to the line below. It stays sharp.' },
      { kind: 'micro' },
    ],
  },
  {
    run: 'Privacy',
    blocks: [
      { kind: 'h', text: 'Your file stays yours' },
      { kind: 'p', text: 'There is no server. Explica is a handful of static files; once loaded it needs no network at all.' },
      { kind: 'p', text: 'A PDF you open is read with the browser’s File API, parsed and rasterised by pdf.js in background workers, and uploaded only to your own graphics card. A Content-Security-Policy forbids the page from contacting any other origin, so not even a bug could send your document anywhere.' },
      { kind: 'p', text: 'Close the tab and it is gone: nothing is stored.' },
    ],
  },
  {
    run: 'Colophon',
    blocks: [
      { kind: 'h', text: 'Colophon' },
      { kind: 'p', text: 'Explica — from the Latin explicāre, to unfold or open out (ex-, out, and plicāre, to fold): what a reader once did to a scroll, and what this book does for a PDF. Mechanics: a reduced-coordinate multibody of rigid strips with exact polygonal mass properties and a fan-ruled developable kinematics. Rendering: three.js with physically based materials. Documents: pdf.js.' },
      { kind: 'p', text: 'This little book was typeset by the program itself, at whatever resolution your screen asks for.' },
      { kind: 'gap', h: 20 },
      { kind: 'p', text: 'Now open a book of your own: drop a PDF anywhere on this window.' },
    ],
  },
  { draw: endPage },
];

/** The built-in sample document, typeset procedurally (vector-sharp at any resolution). */
export class WelcomeSource implements PageSource {
  readonly name = 'Sample Document';
  /** Annotation storage key: the sample's content is fixed, so its key is too. */
  readonly key = 'sample-document@1';
  readonly baseSize = { w: PW, h: PH };
  private rtl = false;
  get pageCount(): number {
    return PAGES.length;
  }
  async pageSize(): Promise<{ w: number; h: number }> {
    return this.baseSize;
  }
  async render(i: number, canvas: HTMLCanvasElement, w: number, h: number, region?: PageRegion): Promise<void> {
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    const r = region ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
    const s = w / ((r.x1 - r.x0) * PW);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.setTransform(s, 0, 0, s, -r.x0 * PW * s, -r.y0 * PH * s);
    drawPage(g, i, this.rtl);
  }
  /**
   * The text of page i, recorded from the very calls that typeset it: every
   * fillText becomes a run, placed through the context's transform and
   * alignment (letter-spacing hair spaces are dropped from the copied text).
   */
  async textContent(i: number): Promise<TextRun[]> {
    const c = document.createElement('canvas');
    c.width = c.height = 2; // nothing needs to be visible: only the calls are recorded
    const g = c.getContext('2d')!;
    const runs: TextRun[] = [];
    g.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      const str = text.replace(/\u200a/g, '');
      if (!str.trim()) return;
      let w = g.measureText(text).width;
      if (maxWidth != null) w = Math.min(w, maxWidth);
      const a = g.textAlign;
      const x0 = a === 'center' ? x - w / 2 : a === 'right' || a === 'end' ? x - w : x;
      const m = g.getTransform();
      const p0 = m.transformPoint(new DOMPoint(x0, y));
      const p1 = m.transformPoint(new DOMPoint(x0 + w, y));
      const px = Number(/([\d.]+)px/.exec(g.font)?.[1] ?? 10);
      runs.push({
        str,
        x: p0.x,
        y: p0.y,
        width: Math.hypot(p1.x - p0.x, p1.y - p0.y),
        size: px * Math.hypot(m.a, m.b),
        angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
        eol: true,
      });
    };
    drawPage(g, i, this.rtl);
    return runs;
  }

  /** Margins, running heads, folios and the corner hint follow the side each page lies on. */
  setReadingDirection(d: ReadingDirection): boolean {
    const rtl = d === 'rtl';
    if (rtl === this.rtl) return false;
    this.rtl = rtl;
    return true;
  }
  async destroy(): Promise<void> {}
}

function drawPage(g: CanvasRenderingContext2D, i: number, rtl: boolean): void {
  const spec = PAGES[i];
  // LTR: odd pages are left-hand pages; an RTL book opens with page 1 on the left
  const left = (i % 2 === 1) !== rtl;
  if (spec.draw) {
    spec.draw(g, left);
    return;
  }
  // symmetric margins: the text block stays put when the book is re-typeset for the other
  // reading direction (annotations are stored in page coordinates); heads and folios swap sides
  const inner = 46;
  const outer = 46;
  const x0 = left ? outer : inner;
  const width = PW - inner - outer;
  // running head & folio
  g.fillStyle = MUTED;
  g.font = `500 7.2px ${SANS}`;
  g.textBaseline = 'alphabetic';
  if (spec.run) {
    g.textAlign = left ? 'left' : 'right';
    g.fillText(letterspace(spec.run.toUpperCase()), left ? x0 : x0 + width, 34);
  }
  g.font = `italic 9px ${SERIF}`;
  g.textAlign = left ? 'left' : 'right';
  g.fillText(String(i + 1), left ? x0 : x0 + width, PH - 30);
  g.textAlign = 'left';
  let y = 72;
  for (const b of spec.blocks ?? []) {
    switch (b.kind) {
      case 'h':
        g.fillStyle = INK;
        g.font = `400 23px ${SERIF}`;
        g.fillText(b.text, x0, y + 14);
        y += 30;
        g.fillStyle = ACCENT;
        g.fillRect(x0, y, 26, 1.2);
        y += 18;
        break;
      case 'p':
        g.fillStyle = INK;
        g.font = `400 10.4px ${SERIF}`;
        y = paragraph(g, b.text, x0, y, width, 14.6) + 7;
        break;
      case 'eq':
        g.fillStyle = INK;
        g.font = `italic 12.5px ${SERIF}`;
        g.textAlign = 'center';
        g.fillText(b.text, x0 + width / 2, y + 12);
        g.textAlign = 'left';
        y += 30;
        break;
      case 'li': {
        g.fillStyle = ACCENT;
        g.font = `600 7.6px ${SANS}`;
        g.fillText(letterspace(b.head.toUpperCase()), x0, y + 10);
        g.fillStyle = INK;
        g.font = `400 10.2px ${SERIF}`;
        y = paragraph(g, b.text, x0 + 78, y, width - 78, 14) + 9;
        break;
      }
      case 'gap':
        y += b.h;
        break;
      case 'fan':
        y = fanDiagram(g, x0, y + 6, width) + 8;
        break;
      case 'micro':
        g.fillStyle = INK;
        g.font = `italic 2.2px ${SERIF}`;
        g.fillText('If you can read this, the detail tile has found you: this line is set in 2.2-point type, a hundredth of an inch tall.', x0, y + 14);
        g.font = `italic 0.6px ${SERIF}`;
        g.fillText('And this one at six-tenths of a point — smaller than the grain of the paper it pretends to be printed on.', x0, y + 18);
        y += 24;
        break;
    }
  }
}

function paragraph(g: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lead: number): number {
  const words = text.split(/\s+/);
  let line = '';
  let yy = y + lead * 0.75;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > width && line) {
      g.fillText(line, x, yy);
      line = w;
      yy += lead;
    } else line = test;
  }
  if (line) g.fillText(line, x, yy);
  return yy + lead * 0.35;
}

function letterspace(s: string): string {
  return s.split('').join(' ');
}

function titlePage(g: CanvasRenderingContext2D, left: boolean): void {
  // mirror x for a left-hand title page (right-to-left books); the type itself is centred on the
  // page, so it lies in the same place in either direction (annotations are kept in page coordinates)
  const mx = (x: number) => (left ? PW - x : x);
  const cx = PW / 2;
  g.textAlign = 'center';
  g.fillStyle = MUTED;
  g.font = `500 7.4px ${SANS}`;
  g.fillText(letterspace('A BOOK THAT BEHAVES LIKE ONE'), cx, 150);
  g.fillStyle = INK;
  g.font = `400 76px ${SERIF}`;
  g.fillText('Explica', cx, 238);
  g.font = `italic 11px ${SERIF}`;
  g.fillStyle = MUTED;
  g.fillText('explicāre — Latin: to unfold, to open', cx, 262);
  g.fillStyle = ACCENT;
  g.fillRect(cx - 16, 284, 32, 1.2);
  g.fillStyle = INK;
  g.font = `400 10.6px ${SERIF}`;
  g.textAlign = 'left';
  const w = 250;
  let y = paragraph(g, 'Drop any PDF onto this window, or press Open. It becomes a book you can hold: paper that bends but never stretches, that has weight, stiffness and momentum, and that answers the way you pull it.', cx - w / 2, 306, w, 15);
  y = paragraph(g, 'Nothing is uploaded. Your document is read, rendered and simulated entirely on this device.', cx - w / 2, y + 6, w, 15);
  // invitation in the lower outer corner, pointing across the spine
  g.textAlign = left ? 'left' : 'right';
  g.fillStyle = ACCENT;
  g.font = `italic 10.5px ${SERIF}`;
  g.fillText(`take this corner and pull it to the ${left ? 'right' : 'left'}`, mx(PW - 40), PH - 48);
  g.strokeStyle = ACCENT;
  g.lineWidth = 0.9;
  g.beginPath();
  g.moveTo(mx(PW - 46), PH - 40);
  g.bezierCurveTo(mx(PW - 120), PH - 22, mx(PW - 200), PH - 24, mx(PW - 250), PH - 38);
  g.stroke();
  g.beginPath();
  g.moveTo(mx(PW - 250), PH - 38);
  g.lineTo(mx(PW - 241), PH - 33);
  g.moveTo(mx(PW - 250), PH - 38);
  g.lineTo(mx(PW - 242), PH - 43);
  g.stroke();
  g.textAlign = 'left';
}

function endPage(g: CanvasRenderingContext2D): void {
  g.textAlign = 'center';
  g.fillStyle = MUTED;
  g.font = `italic 13px ${SERIF}`;
  g.fillText('fin', PW / 2 - 6, PH / 2 - 6);
  g.fillStyle = ACCENT;
  g.beginPath();
  g.arc(PW / 2 - 6, PH / 2 + 12, 1.6, 0, Math.PI * 2);
  g.fill();
  g.textAlign = 'left';
}

/** A page with fan rulings converging on an apex below the spine line. */
function fanDiagram(g: CanvasRenderingContext2D, x0: number, y0: number, width: number): number {
  const w = width * 0.48;
  const h = w * 1.3;
  const px = x0 + (width - w) / 2 - 20;
  const py = y0;
  const apexY = py + h + 80; // apex below the page, on the spine line (x = px)
  g.save();
  g.strokeStyle = '#b9ad9c';
  g.lineWidth = 0.5;
  g.setLineDash([2, 2]);
  g.beginPath();
  g.moveTo(px, py - 6);
  g.lineTo(px, apexY);
  g.stroke();
  g.setLineDash([]);
  g.beginPath();
  g.rect(px, py, w, h);
  g.clip();
  g.strokeStyle = ACCENT;
  g.lineWidth = 0.55;
  const n = 14;
  for (let k = 1; k <= n; k++) {
    const xm = px + (k / n) * w * 1.6;
    g.beginPath();
    g.moveTo(px, apexY);
    g.lineTo(px + (xm - px) * 3, apexY - (apexY - (py + h / 2)) * 3);
    g.stroke();
  }
  g.restore();
  g.strokeStyle = INK;
  g.lineWidth = 0.8;
  g.strokeRect(px, py, w, h);
  g.fillStyle = INK;
  g.beginPath();
  g.arc(px, apexY, 1.8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = MUTED;
  g.font = `italic 8.5px ${SERIF}`;
  g.fillText('spine', px - 26, py + 12);
  g.fillText('apex (0, −1⁄p)', px + 6, apexY + 3);
  g.fillText('rulings: straight lines on which the paper stays flat', px + w + 8, py + h * 0.55, width - w - 28);
  return apexY + 14;
}
