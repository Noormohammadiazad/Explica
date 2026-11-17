import type { ReadingDirection } from './readingDirection';

/** Letters of the scripts written right to left. */
const RTL =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Mende_Kikakui}\p{Script=Yezidi}]/u;
const LETTER = /\p{L}/u;

/** Strong right-to-left and left-to-right letters in a text (digits, spaces and punctuation are neutral). */
export function scriptCounts(text: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    if (RTL.test(ch)) rtl++;
    else ltr++;
  }
  return { rtl, ltr };
}

/**
 * The reading direction a text is written in: whichever of right-to-left
 * (Arabic, Persian, Urdu, Hebrew, …) and left-to-right letters it has more
 * of. Undefined when there are too few letters to tell (a scanned page, a
 * cover with a single word), so the reader's own preference stands.
 */
export function detectDirection(text: string, minLetters = 24): ReadingDirection | undefined {
  const { rtl, ltr } = scriptCounts(text);
  if (rtl + ltr < minLetters) return undefined;
  return rtl > ltr ? 'rtl' : 'ltr';
}
