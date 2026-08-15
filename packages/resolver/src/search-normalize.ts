/**
 * Search-text normalization, shared by INDEX time and QUERY time.
 *
 * The two must be the same function or the whole thing is theatre: a corpus
 * indexed as "ful" and a query folded to "fool" simply never meet. The build
 * (tools/nutrition-data) folds names and synonyms with this; apps/food-server
 * folds the incoming `q` with this.
 *
 * FTS5's `unicode61 remove_diacritics 2` already handles Latin diacritics inside
 * the index, but it does NOT fold Arabic orthography (أ/إ/آ -> ا, ة -> ه,
 * ى -> ي) and it does not know that "foul" and "ful" are the same word to
 * anyone typing Arabic food names in Latin script. Those two jobs are here.
 */

/** Arabic block, incl. Arabic Supplement and Presentation Forms-A/B. */
export const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/

/** Tashkeel (harakat), superscript alef, and the tatweel elongation mark. */
const TASHKEEL_RE = /[ً-ٰٟـ]/g

const ARABIC_INDIC_ZERO = 0x0660
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0

function digits(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) {
      out += String(cp - ARABIC_INDIC_ZERO)
    } else if (cp >= EASTERN_ARABIC_INDIC_ZERO && cp <= EASTERN_ARABIC_INDIC_ZERO + 9) {
      out += String(cp - EASTERN_ARABIC_INDIC_ZERO)
    } else {
      out += ch
    }
  }
  return out
}

/** Arabic-script folding. Orthographic variants collapse; letters do not. */
export function foldArabic(text: string): string {
  return digits(text)
    .replace(TASHKEEL_RE, '')
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    .trim()
}

/**
 * Latin folding for Arabic transliterations.
 *
 * The vowel-cluster rules are the ones that actually matter for food names:
 * ou/oo -> u (foul/fool -> ful), ee -> i, aa -> a (zaatar -> zatar), and the
 * glottal-stop apostrophes people type in "za'atar" carry no information.
 * Doubled consonants collapse last, so "mansaff" and "mansaf" agree.
 */
export function foldLatin(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`ʼʻ‘’]/g, '')
    .replace(/ou|oo/g, 'u')
    .replace(/ee/g, 'i')
    .replace(/aa/g, 'a')
    .replace(/([a-z])\1+/g, '$1')
    .trim()
}

/**
 * Fold a whole query or a whole indexed string, token by token.
 *
 * Per-token dispatch, not per-string: "فول medames" is one real query and both
 * halves deserve their own rules. Whitespace collapses so the output is stable
 * enough to be idempotent, which the build depends on — a re-index must produce
 * the same keys as the first index.
 */
export function normalizeSearchText(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => t !== '')
    .map((token) => (ARABIC_RE.test(token) ? foldArabic(token) : foldLatin(token)))
    .filter((t) => t !== '')
    .join(' ')
}
