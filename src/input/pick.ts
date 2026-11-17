import type { Side } from '../book/bookLayout';

/** Something a pointer ray met, as the picker needs to know it. Hits arrive nearest first. */
export type RayHit =
  | { kind: 'occluder'; facesRay: boolean }
  | {
      kind: 'sheet';
      sheet: number;
      /** Which face of the sheet the ray met. */
      face: 'front' | 'back';
      /** The face's outward normal points against the ray (it is turned towards the eye). */
      facesRay: boolean;
      /** The stack the sheet lies on, or null while it is in flight. */
      resting: Side | null;
    };

/**
 * Which hit, if any, picks up a page (index into `hits`, or −1 for "the book":
 * the gesture then handles the book instead).
 *
 *  - Faces turned away from the eye are invisible and ignored.
 *  - The first visible thing decides. A cover board, the spine or the side of a
 *    page block hides everything behind it, so a book seen from behind is turned
 *    by its cover, never by a page through it.
 *  - A resting page can be taken only by its reading face: the front of a sheet
 *    on the right stack, the back of one on the left. Meeting its underside
 *    means looking at the book from behind or below.
 *  - Pages in flight can be caught from either side.
 */
export function pickSheet(hits: readonly RayHit[], grabbable: (sheet: number) => boolean): number {
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k];
    if (!h.facesRay) continue;
    if (h.kind === 'occluder') return -1;
    if (h.resting) {
      const reading = h.resting === 'R' ? 'front' : 'back';
      if (h.face !== reading) return -1;
    }
    if (grabbable(h.sheet)) return k;
  }
  return -1;
}
