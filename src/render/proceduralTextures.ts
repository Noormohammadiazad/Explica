import * as THREE from 'three';

/** Deterministic PRNG so the generated textures are identical on every load. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Converts a tileable height field into a tangent-space normal map. */
function heightToNormal(h: Float32Array, size: number, strength: number): ImageData {
  const img = new ImageData(size, size);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = 4 * (y * size + x);
      img.data[o] = (0.5 - 0.5 * dx * inv) * 255;
      img.data[o + 1] = (0.5 + 0.5 * dy * inv) * 255;
      img.data[o + 2] = (0.5 + 0.5 * inv) * 255;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function blur(h: Float32Array, size: number, passes: number): void {
  const tmp = new Float32Array(h.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const l = h[y * size + ((x + size - 1) % size)];
        const r = h[y * size + ((x + 1) % size)];
        tmp[y * size + x] = 0.25 * l + 0.5 * h[y * size + x] + 0.25 * r;
      }
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u = tmp[((y + size - 1) % size) * size + x];
        const d = tmp[((y + 1) % size) * size + x];
        h[y * size + x] = 0.25 * u + 0.5 * tmp[y * size + x] + 0.25 * d;
      }
  }
}

function canvasTexture(img: ImageData, colorSpace: THREE.ColorSpace): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Paper fibre normal map: short randomly oriented fibres plus fine grain. */
export function paperFibreNormalMap(size = 512): THREE.Texture {
  const r = mulberry(17);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = r() * 0.35;
  const fibres = size * 14;
  for (let f = 0; f < fibres; f++) {
    const x0 = r() * size;
    const y0 = r() * size;
    const ang = r() * Math.PI;
    const len = 6 + r() * 26;
    const w = 0.4 + r() * 0.8;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let s = 0; s < len; s += 0.7) {
      const x = Math.floor(x0 + dx * s) & (size - 1);
      const y = Math.floor(y0 + dy * s) & (size - 1);
      h[y * size + x] += w;
    }
  }
  blur(h, size, 1);
  return canvasTexture(heightToNormal(h, size, 0.55), THREE.NoColorSpace);
}

/** Stripes for the fore-edge / head / tail of a page block. */
export function pageEdgeTexture(): THREE.Texture {
  const W = 8;
  const H = 256;
  const r = mulberry(5);
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    const gap = y % 4 === 0;
    const base = gap ? 196 : 238 - r() * 14;
    for (let x = 0; x < W; x++) {
      const o = 4 * (y * W + x);
      img.data[o] = base;
      img.data[o + 1] = base * 0.975;
      img.data[o + 2] = base * 0.93;
      img.data[o + 3] = 255;
    }
  }
  const tex = canvasTexture(img, THREE.SRGBColorSpace);
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** Book-cloth (linen weave) colour and normal maps. */
export function linenTextures(color = new THREE.Color('#24414f')): { map: THREE.Texture; normalMap: THREE.Texture } {
  const size = 256;
  const r = mulberry(11);
  const h = new Float32Array(size * size);
  const col = new ImageData(size, size);
  const threads = 64;
  const period = size / threads;
  const warp = Array.from({ length: threads }, () => 0.75 + r() * 0.5);
  const weft = Array.from({ length: threads }, () => 0.75 + r() * 0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = Math.floor(x / period);
      const ty = Math.floor(y / period);
      const fx = (x % period) / period;
      const fy = (y % period) / period;
      const over = (tx + ty) % 2 === 0;
      const a = Math.sin(Math.PI * fx) * warp[tx];
      const b = Math.sin(Math.PI * fy) * weft[ty];
      const height = over ? Math.max(a, 0.6 * b) : Math.max(b, 0.6 * a);
      const noise = r() * 0.15;
      h[y * size + x] = height + noise;
      const shade = 0.82 + 0.25 * height + noise * 0.4;
      const o = 4 * (y * size + x);
      col.data[o] = Math.min(255, color.r * 255 * shade);
      col.data[o + 1] = Math.min(255, color.g * 255 * shade);
      col.data[o + 2] = Math.min(255, color.b * 255 * shade);
      col.data[o + 3] = 255;
    }
  }
  return {
    map: canvasTexture(col, THREE.SRGBColorSpace),
    normalMap: canvasTexture(heightToNormal(h, size, 1.2), THREE.NoColorSpace),
  };
}

/** A soft, warm marbled endpaper. */
export function endpaperTexture(): THREE.Texture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ece4d4';
  g.fillRect(0, 0, size, size);
  const r = mulberry(23);
  for (let i = 0; i < 70; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 20 + r() * 90;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const hue = r() < 0.5 ? '150, 120, 90' : '110, 120, 125';
    grad.addColorStop(0, `rgba(${hue}, ${0.025 + r() * 0.035})`);
    grad.addColorStop(1, `rgba(${hue}, 0)`);
    g.fillStyle = grad;
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        g.save();
        g.translate(ox, oy);
        g.beginPath();
        g.arc(x, y, rad, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 1×1 white texture used as a stand-in until a page is rasterised. */
export function blankPageTexture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Inside face of a cover board: the cloth is turned in over the head, tail and
 * fore-edge (a 14 mm band), and the pasted-down endpaper covers the rest.
 */
export function boardInsideTexture(
  boardW: number,
  boardH: number,
  foreEdgeRight: boolean,
  cloth: THREE.Color,
  endpaper: THREE.Texture,
): THREE.Texture {
  const pxPerM = 2600;
  const w = Math.round(boardW * pxPerM);
  const h = Math.round(boardH * pxPerM);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const css = `#${cloth.getHexString(THREE.SRGBColorSpace)}`;
  g.fillStyle = css;
  g.fillRect(0, 0, w, h);
  // faint weave on the turn-in
  g.globalAlpha = 0.045;
  for (let y = 0; y < h; y += 3) {
    g.fillStyle = y % 6 === 0 ? '#ffffff' : '#000000';
    g.fillRect(0, y, w, 1);
  }
  g.globalAlpha = 1;
  const turn = Math.round(0.014 * pxPerM);
  const x0 = foreEdgeRight ? 0 : turn;
  const x1 = foreEdgeRight ? w - turn : w;
  const src = endpaper.image as HTMLCanvasElement;
  const pat = g.createPattern(src, 'repeat');
  if (pat) {
    g.fillStyle = pat;
    g.fillRect(x0, turn, x1 - x0, h - 2 * turn);
  }
  // the edge of the pastedown casts a hairline shadow on the cloth
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 2;
  g.strokeRect(x0 + 1, turn + 1, x1 - x0 - 2, h - 2 * turn - 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ============================================================================ cover artwork

const GILT_TOP = '#dcbd78';
const GILT_BOTTOM = '#b08a3d';
const COVER_SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
const WORDMARK = 'EXPLICA';

/** A stamped cloth surface: colour, and roughness (G) / metalness (B) for the gilt foil. */
export interface StampedArt {
  map: THREE.CanvasTexture;
  orm: THREE.CanvasTexture;
}

export type CoverKind = 'front' | 'back' | 'spine';

/**
 * Exterior artwork for a hardcover, drawn at true size: the canvas has the
 * face's own aspect ratio (≈ 7 px per mm), so rules, type and weave are never
 * stretched. Every document gets the same Explica binding, classic gilt
 * stamping on book cloth:
 *
 *  - front: double-rule frame with crossed ("Oxford") corners, the EXPLICA
 *    wordmark in letter-spaced capitals, a short rule and the Explica device;
 *  - back: the same frame, the device and a small imprint;
 *  - spine: paired rules at head and tail, EXPLICA running head to tail.
 *
 * Covers also show the hinge groove beside the spine (`spineSide`, as the face
 * is seen from outside). The foil sits in a slight impression, and the `orm`
 * map makes it metallic and smoother than the cloth, so it glints as the book
 * is tilted.
 */
export function coverArt(o: {
  width: number;
  height: number;
  cloth: THREE.Color;
  kind: CoverKind;
  spineSide?: 'left' | 'right';
}): StampedArt {
  const ppm = Math.min(8000, 1600 / Math.max(o.width, o.height));
  const W = Math.max(16, Math.round(o.width * ppm));
  const H = Math.max(16, Math.round(o.height * ppm));
  const mm = (v: number) => (v * ppm) / 1000;
  const design = coverDesign(o, W, H, mm);

  const colour = document.createElement('canvas');
  colour.width = W;
  colour.height = H;
  const g = colour.getContext('2d')!;
  clothGround(g, W, H, o.cloth, mm);
  if (o.kind !== 'spine') hingeGroove(g, W, H, mm, o.spineSide ?? 'left');
  // the impression the hot die leaves around the foil
  g.save();
  g.translate(mm(0.09), mm(0.12));
  g.fillStyle = g.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  design(g);
  g.restore();
  const gilt = g.createLinearGradient(0, 0, 0, H);
  gilt.addColorStop(0, GILT_TOP);
  gilt.addColorStop(1, GILT_BOTTOM);
  g.fillStyle = g.strokeStyle = gilt;
  design(g);

  // foil mask → roughness (G: cloth 0.88, foil 0.34) and metalness (B)
  const orm = document.createElement('canvas');
  orm.width = W;
  orm.height = H;
  const m = orm.getContext('2d')!;
  m.fillStyle = '#000';
  m.fillRect(0, 0, W, H);
  m.fillStyle = m.strokeStyle = '#fff';
  design(m);
  const img = m.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const foil = d[i] / 255;
    d[i] = 255;
    d[i + 1] = Math.round(255 * (0.88 - 0.54 * foil));
    d[i + 2] = Math.round(255 * foil);
    d[i + 3] = 255;
  }
  m.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(colour);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const ormTex = new THREE.CanvasTexture(orm);
  ormTex.colorSpace = THREE.NoColorSpace;
  ormTex.anisotropy = 8;
  return { map, orm: ormTex };
}

/** Book cloth: a fine plain weave with slubbed threads and a little mottling. */
function clothGround(g: CanvasRenderingContext2D, W: number, H: number, cloth: THREE.Color, mm: (v: number) => number): void {
  const base = cloth.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const r = mulberry(29);
  const pitch = Math.max(2, mm(0.34));
  const rows = Array.from({ length: Math.ceil(H / pitch) + 1 }, () => (r() - 0.5) * 0.045);
  const cols = Array.from({ length: Math.ceil(W / pitch) + 1 }, () => (r() - 0.5) * 0.045);
  const img = g.createImageData(W, H);
  const d = img.data;
  const k = (2 * Math.PI) / pitch;
  for (let y = 0; y < H; y++) {
    const wy = Math.sin(k * y);
    const ry = rows[Math.floor(y / pitch)];
    for (let x = 0; x < W; x++) {
      const f = 1 + 0.03 * Math.sin(k * x) * wy + ry + cols[Math.floor(x / pitch)] + (r() - 0.5) * 0.05;
      const o = 4 * (y * W + x);
      d[o] = Math.min(255, base.r * 255 * f);
      d[o + 1] = Math.min(255, base.g * 255 * f);
      d[o + 2] = Math.min(255, base.b * 255 * f);
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** The groove a hardcover's cloth takes over the hinge, 7 mm in from the spine. */
function hingeGroove(g: CanvasRenderingContext2D, W: number, H: number, mm: (v: number) => number, spineSide: 'left' | 'right'): void {
  const x = spineSide === 'left' ? mm(7) : W - mm(7);
  const half = mm(0.9);
  const shade = g.createLinearGradient(x - half, 0, x + half, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0.3)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shade;
  g.fillRect(x - half, 0, 2 * half, H);
  // the lip on the board side catches the light
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(spineSide === 'left' ? x + half : x - half - mm(0.5), 0, mm(0.5), H);
}

/** Returns a painter for the gilt design; it uses the context's current fill/stroke style. */
function coverDesign(
  o: { kind: CoverKind; spineSide?: 'left' | 'right' },
  W: number,
  H: number,
  mm: (v: number) => number,
): (g: CanvasRenderingContext2D) => void {
  const title = WORDMARK;
  if (o.kind === 'spine') {
    return (g) => {
      for (const y of [H * 0.07, H * 0.93]) {
        const dir = y < H / 2 ? 1 : -1;
        hRule(g, mm(1), W - mm(1), y, mm(0.55));
        hRule(g, mm(1), W - mm(1), y + dir * mm(1.1), mm(0.25));
      }
      g.save();
      g.translate(W / 2, H / 2);
      g.rotate(Math.PI / 2); // reads head → tail, letters standing towards the front cover
      const size = Math.min(W * 0.44, mm(4.6));
      spacedText(g, title, 0, size * 0.36, size, 0.4, H * 0.6);
      g.restore();
    };
  }
  // the panel: the board less the strip beyond the hinge groove
  const joint = mm(9);
  const px0 = o.spineSide === 'left' ? joint : 0;
  const px1 = o.spineSide === 'left' ? W : W - joint;
  const pw = px1 - px0;
  const cx = (px0 + px1) / 2;
  const margin = Math.min(mm(10), Math.max(mm(5.5), Math.min(pw, H) * 0.06));
  return (g) => {
    frame(g, px0 + margin, margin, px1 - margin, H - margin, mm);
    const inner = pw - 2 * margin - mm(14);
    if (o.kind === 'front') {
      // the wordmark sits on the upper third, the device on the optical centre below it;
      // both scale with the panel so every book size keeps the same proportions
      // (sized to the wordmark's length: a squeezed wordmark would distort its letters)
      const size = Math.min(mm(11), (inner * 0.75 * 100) / spacedWidth(g, title, 100, 0.42));
      const y = H * 0.3;
      spacedText(g, title, cx, y + size * 0.36, size, 0.42, inner);
      hRule(g, cx - mm(9), cx + mm(9), y + size * 0.36 + mm(7), mm(0.3));
      device(g, cx, H * 0.6, Math.min(inner * 0.19, mm(15)), mm);
    } else {
      const r = Math.min(inner * 0.12, mm(9));
      const cy = H * 0.47;
      device(g, cx, cy, r, mm);
      spacedText(g, title, cx, cy + r + mm(7), mm(2.5), 0.32, inner);
    }
  };
}

function hRule(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, t: number): void {
  g.fillRect(x0, y - t / 2, x1 - x0, t);
}

function vRule(g: CanvasRenderingContext2D, x: number, y0: number, y1: number, t: number): void {
  g.fillRect(x - t / 2, y0, t, y1 - y0);
}

/** Double-rule frame whose rules cross and run on at the corners (Oxford corners). */
function frame(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, mm: (v: number) => number): void {
  const run = mm(2.6);
  for (const [inset, t] of [
    [0, mm(0.75)],
    [mm(1.7), mm(0.3)],
  ]) {
    const a = x0 + inset;
    const b = y0 + inset;
    const c = x1 - inset;
    const d = y1 - inset;
    hRule(g, a - run, c + run, b, t);
    hRule(g, a - run, c + run, d, t);
    vRule(g, a, b - run, d + run, t);
    vRule(g, c, b - run, d + run, t);
  }
}

/** The Explica device: an open book with a leaf unfolding from the head of its spine, in a double ring. */
function device(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, mm: (v: number) => number): void {
  const ring = (rad: number, t: number) => {
    g.beginPath();
    g.arc(cx, cy, rad + t / 2, 0, 2 * Math.PI);
    g.arc(cx, cy, rad - t / 2, 0, 2 * Math.PI, true);
    g.fill();
  };
  ring(r, mm(0.55));
  ring(r - mm(1.3), mm(0.22));
  // the favicon's open book (64-unit box, spine at x = 32), scaled into the ring, as line art
  const k = (0.6 * r) / 24;
  const X = (u: number) => cx + (u - 32) * k;
  const Y = (v: number) => cy + (v - 33) * k;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const page = (s: 1 | -1) => {
    const x = (u: number) => X(32 + s * (u - 32) + s * 0.7);
    g.lineWidth = Math.max(1, mm(0.42));
    g.beginPath();
    g.moveTo(x(8), Y(14));
    g.bezierCurveTo(x(16), Y(10), x(24), Y(10), x(32), Y(16));
    g.lineTo(x(32), Y(53));
    g.bezierCurveTo(x(24), Y(47), x(16), Y(47), x(8), Y(51));
    g.closePath();
    g.stroke();
    // lines of type, following the curl of the page
    g.lineWidth = Math.max(1, mm(0.2));
    for (let i = 0; i < 5; i++) {
      const o = 7.5 + i * 6.4;
      g.beginPath();
      g.moveTo(x(12), Y(13 + o));
      g.bezierCurveTo(x(18), Y(10.5 + o), x(23), Y(10.5 + o), x(28.5), Y(14.4 + o));
      g.stroke();
    }
  };
  page(-1);
  page(1);
  // the unfolding leaf, lifting from the head of the spine
  g.beginPath();
  g.moveTo(X(33), Y(12.5));
  g.bezierCurveTo(X(38), Y(5), X(46), Y(3), X(54), Y(4));
  g.bezierCurveTo(X(48), Y(7), X(40), Y(12.5), X(33), Y(12.5));
  g.fill();
}

function spacedWidth(g: CanvasRenderingContext2D, text: string, size: number, tracking: number): number {
  g.font = `600 ${size}px ${COVER_SERIF}`;
  let w = 0;
  for (const ch of text) w += g.measureText(ch).width;
  return w + Math.max(0, [...text].length - 1) * tracking * size;
}

/** Letter-spaced text centred on x (manual tracking: works in every canvas implementation). */
function spacedText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, tracking: number, maxWidth: number): void {
  const total = spacedWidth(g, text, size, tracking);
  const squeeze = total > maxWidth ? maxWidth / total : 1;
  g.save();
  g.translate(x - (total * squeeze) / 2, y);
  g.scale(squeeze, 1);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  let at = 0;
  for (const ch of text) {
    g.fillText(ch, at, 0);
    at += g.measureText(ch).width + tracking * size;
  }
  g.restore();
}
