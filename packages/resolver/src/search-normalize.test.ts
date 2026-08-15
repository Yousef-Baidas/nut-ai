import { describe, expect, it } from 'vitest'
import { foldArabic, foldLatin, normalizeSearchText } from './search-normalize.js'

describe('foldArabic', () => {
  it('strips tashkeel', () => {
    expect(foldArabic('فُولْ')).toBe('فول')
    expect(foldArabic('كُنَافَة')).toBe('كنافه')
  })

  it('folds alef variants, ta marbuta and alef maqsura', () => {
    expect(foldArabic('أرز')).toBe('ارز')
    expect(foldArabic('إفطار')).toBe('افطار')
    expect(foldArabic('آيس')).toBe('ايس')
    expect(foldArabic('لبنة')).toBe('لبنه')
    expect(foldArabic('مصطفى')).toBe('مصطفي')
  })

  it('normalizes Arabic-Indic digits to ASCII', () => {
    expect(foldArabic('٢٥٠ غرام')).toBe('250 غرام')
    expect(foldArabic('۳۰۰')).toBe('300')
  })

  it('strips tatweel', () => {
    expect(foldArabic('فـــول')).toBe('فول')
  })
})

describe('foldLatin', () => {
  it('lowercases and strips Latin diacritics', () => {
    expect(foldLatin('Fūl')).toBe('ful')
    expect(foldLatin('Zaʼatar')).toBe('zatar')
  })

  it('collapses the transliteration vowel clusters', () => {
    expect(foldLatin('foul')).toBe('ful')
    expect(foldLatin('fool')).toBe('ful')
    expect(foldLatin('kunafeh')).toBe('kunafeh')
    expect(foldLatin('koshari')).toBe('koshari')
  })

  it('drops apostrophes and collapses doubled letters', () => {
    expect(foldLatin("za'atar")).toBe('zatar')
    expect(foldLatin('zaatar')).toBe('zatar')
    expect(foldLatin('mansaff')).toBe('mansaf')
  })
})

describe('normalizeSearchText', () => {
  it('dispatches per token and keeps a mixed query intact', () => {
    expect(normalizeSearchText('  Foul   MEDAMES ')).toBe('ful medames')
    expect(normalizeSearchText('فُول مُدَمَّس')).toBe('فول مدمس')
    expect(normalizeSearchText('فول Foul')).toBe('فول ful')
  })

  it('is idempotent — index time and query time must agree', () => {
    const once = normalizeSearchText('Za’atar  فُول ٢')
    expect(normalizeSearchText(once)).toBe(once)
  })

  it('golden case: the three spellings of ful share one Latin key', () => {
    expect(foldLatin('ful')).toBe('ful')
    expect(foldLatin('foul')).toBe('ful')
    expect(foldLatin('fool')).toBe('ful')
    expect(foldArabic('فول')).toBe('فول')
  })
})
