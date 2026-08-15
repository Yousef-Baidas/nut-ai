/**
 * Open Food Facts row mapping.
 *
 * The dump is one JSON object per line and roughly nine gigabytes gzipped, so
 * every function here is per-line and allocation-light: nothing accumulates, the
 * caller streams.
 *
 * The completeness filter is not fussiness. A row missing fat is a row that will
 * silently log as 0 g fat forever, and the app's whole premise is never showing a
 * number it cannot justify. Absent means absent; the row is dropped.
 */

import { CLAMP_BOUNDS } from '@nutai/clamp'
import { normalizeSearchText } from '@nutai/resolver'

const CORE = ['energy-kcal_100g', 'proteins_100g', 'fat_100g', 'carbohydrates_100g']

/**
 * BOM (U+FEFF) and zero-width characters (U+200B-200D, U+2060), stripped
 * before anything is parsed or normalized.
 *
 * @nutai/resolver's ARABIC_RE spans U+FE70-U+FEFF, which includes the BOM
 * itself — a BOM-prefixed token would otherwise route to Arabic folding
 * instead of Latin. A raw leading BOM on the line also breaks JSON.parse.
 */
const INVISIBLE_RE = /[﻿​‌‍⁠]/g
const stripInvisible = (s) => s.replace(INVISIBLE_RE, '')

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** One JSONL line -> an OffFood, or null when the row cannot be trusted. */
export function parseOffLine(line) {
  if (line == null || line.trim() === '') return null

  const cleaned = stripInvisible(line)
  if (cleaned.trim() === '') return null

  let p
  try {
    p = JSON.parse(cleaned)
  } catch {
    return null
  }

  const code = typeof p.code === 'string' ? p.code.trim() : ''
  if (code === '' || !/^\d{6,14}$/.test(code)) return null

  const name = typeof p.product_name === 'string' ? p.product_name.trim() : ''
  if (name === '') return null

  const n = p.nutriments
  if (n == null || typeof n !== 'object') return null
  for (const key of CORE) if (num(n[key]) == null) return null

  // OFF stores sodium in GRAMS per 100 g. The corpus stores milligrams.
  const sodiumG = num(n.sodium_100g)

  const synonyms = []
  for (const [key, value] of Object.entries(p)) {
    if (!key.startsWith('product_name')) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    if (value.trim() !== name) synonyms.push(value.trim())
  }
  if (typeof p.brands === 'string' && p.brands.trim() !== '') synonyms.push(p.brands.trim())

  return {
    code,
    name,
    brand: typeof p.brands === 'string' && p.brands.trim() !== '' ? p.brands.trim().split(',')[0].trim() : null,
    kcal: num(n['energy-kcal_100g']),
    protein: num(n.proteins_100g),
    fat: num(n.fat_100g),
    satFat: num(n['saturated-fat_100g']),
    carb: num(n.carbohydrates_100g),
    fiber: num(n.fiber_100g),
    sugar: num(n.sugars_100g),
    sodiumMg: sodiumG == null ? null : sodiumG * 1000,
    servingSizeG: num(p.serving_quantity),
    servingDesc: typeof p.serving_size === 'string' && p.serving_size.trim() !== '' ? p.serving_size.trim() : null,
    synonyms,
  }
}

/** The clamp rules, applied to a corpus row instead of to a model answer. */
export function isNutritionallySane(f) {
  if (f == null) return false
  const macros = [f.protein, f.fat, f.carb]
  if (macros.some((m) => m == null || m < 0)) return false
  if (f.kcal == null || f.kcal < 0) return false
  if (f.kcal > CLAMP_BOUNDS.MAX_KCAL_PER_100G) return false
  if (macros.reduce((a, b) => a + b, 0) > 100) return false

  const atwater = 4 * f.protein + 4 * f.carb + 9 * f.fat
  // Sub-10 kcal rows (diet drinks, black coffee) are dominated by rounding, so
  // the ratio test is meaningless there and only the absolute bound applies.
  if (atwater < 10 && f.kcal < 10) return true
  const denom = Math.max(atwater, 1)
  // Clamp semantics: the stated kcal may be off by at most this FRACTION of the
  // Atwater estimate — a 15% band, not a 115% one. A stated kcal of 0 against
  // real macros is exactly the failure this exists to catch, on the low side.
  return Math.abs(f.kcal - atwater) / denom <= CLAMP_BOUNDS.MACRO_ARITHMETIC_TOLERANCE
}

/** OffFood -> the FoodRow the writer inserts. */
export function offFoodToRow(f) {
  const present = [f.kcal, f.protein, f.fat, f.carb].filter((v) => v != null).length
  return {
    source: 'off',
    sourceId: f.code,
    name: f.name,
    brand: f.brand,
    tier: 'off',
    license: 'ODbL-1.0',
    barcode: f.code,
    kcal: f.kcal,
    protein: f.protein,
    fat: f.fat,
    satFat: f.satFat,
    carb: f.carb,
    fiber: f.fiber,
    sugar: f.sugar,
    sodiumMg: f.sodiumMg,
    servingSizeG: f.servingSizeG,
    servingDesc: f.servingDesc,
    completeness: present / 4,
    synonyms: [...new Set(f.synonyms.map((s) => normalizeSearchText(s)).filter((s) => s !== ''))],
  }
}
