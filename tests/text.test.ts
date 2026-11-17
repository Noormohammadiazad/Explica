import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { affineOnto, caretIndex, parallelogramCoords, parallelogramDistance, runBox, wordAround } from '../src/pdf/textGeometry';
import type { TextRun } from '../src/pdf/pageSource';
import { SheetMesh } from '../src/render/sheetMesh';
import { createPaperMaterial } from '../src/render/paperMaterial';
import { restConfiguration } from '../src/physics/rest';
import { A5 } from './helpers';

const run = (over: Partial<TextRun> = {}): TextRun => ({ str: 'Hello world', x: 72, y: 100, width: 60, size: 12, angle: 0, eol: false, ...over });

describe('Text layer geometry', () => {
  it('boxes a run above and below its baseline, along its direction', () => {
    const b = runBox(run());
    expect(b.tl.x).toBeCloseTo(72, 12);
    expect(b.tl.y).toBeLessThan(100); // above the baseline (page y points down)
    expect(b.tr.x - b.tl.x).toBeCloseTo(60, 12);
    expect(b.bl.y).toBeGreaterThan(100);
    // rotated a quarter turn clockwise: the run reads downwards, its top faces right
    const r = runBox(run({ angle: Math.PI / 2 }));
    expect(r.tr.y - r.tl.y).toBeCloseTo(60, 9);
    expect(r.tl.x).toBeGreaterThan(72);
  });

  it('the CSS affine maps the span box onto the projected corners, and back', () => {
    const tl = { x: 120, y: 80 };
    const tr = { x: 400, y: 95 };
    const bl = { x: 110, y: 118 };
    const [a, b, c, d, e, f] = affineOnto(tl, tr, bl, 320, 32);
    const map = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
    expect(map(0, 0)).toEqual(tl);
    expect(map(320, 0).x).toBeCloseTo(tr.x, 9);
    expect(map(0, 32).y).toBeCloseTo(bl.y, 9);
    const p = map(160, 16);
    const st = parallelogramCoords(tl, tr, bl, p)!;
    expect(st.s).toBeCloseTo(0.5, 9);
    expect(st.t).toBeCloseTo(0.5, 9);
    expect(parallelogramDistance(tl, tr, bl, p)).toBe(0);
    expect(parallelogramDistance(tl, tr, bl, { x: tr.x + 30, y: tr.y })).toBeCloseTo(30 * Math.cos(Math.atan2(15, 280)), 0);
    expect(parallelogramCoords(tl, tl, bl, p)).toBeNull(); // seen edge-on
  });

  it('places carets between characters and finds the word under them', () => {
    expect(caretIndex([0, 10, 20, 30], 14)).toBe(1);
    expect(caretIndex([0, 10, 20, 30], 16)).toBe(2);
    expect(caretIndex([0, 10, 20, 30], 99)).toBe(3);
    expect(wordAround('Paper is not cloth.', 2)).toEqual([0, 5]);
    expect(wordAround('Paper is not cloth.', 5)).toEqual([0, 5]); // just after a word
    expect(wordAround('Paper is not cloth.', 14)).toEqual([13, 18]);
    expect(wordAround('Paper is not cloth.', 18)).toEqual([13, 18]);
    expect(wordAround('a — b', 2)).toEqual([2, 3]); // punctuation alone
    expect(wordAround('Gauss’s theorema', 3)).toEqual([0, 7]);
    expect(wordAround('', 0)).toEqual([0, 0]);
  });
});

describe('Sheet mesh bounds', () => {
  const mesh = () => {
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const mk = (mirror: boolean) => createPaperMaterial({ blank, fibre: new THREE.Texture(), mirror, pageWidth: A5.W });
    return new SheetMesh(A5, 24, 0.00011, mk(false), mk(true));
  };

  it('a sheet raycast before it was ever posed keeps a true bound, and is hit once it is', () => {
    const m = mesh();
    // what a zoom used to do to a hidden, never-posed sheet: raycast it (three.js would compute a bound lazily)
    const rc = new THREE.Raycaster(new THREE.Vector3(0.07, 0, 1), new THREE.Vector3(0, 0, -1));
    expect(rc.intersectObject(m.mesh).length).toBe(0);
    expect(m.mesh.geometry.boundingSphere!.radius).toBeCloseTo(Math.hypot(A5.W, A5.H / 2) + 0.01, 12);
    // now it lands on the stack and is posed
    const surface = { base: 0.001, top: 0.002, gutter: 0.006 };
    m.update(restConfiguration(A5.W, 24, surface, 1, 0.001), 0.001);
    m.mesh.updateMatrixWorld(true);
    expect(rc.intersectObject(m.mesh).length).toBeGreaterThan(0);
    expect(m.mesh.geometry.boundingSphere!.center.z).toBeCloseTo(0.001, 12);
  });
});
