import { describe, expect, it } from 'vitest'
import {
  displayWeight,
  formatHeight,
  formatRate,
  formatWeight,
  storedWeightKg,
  weightUnitLabel,
} from './format'

/**
 * The invariant that matters: kilograms are the ONLY representation ever stored.
 * Imperial is a display skin. Every test here either checks a conversion at the
 * display boundary or checks that a round trip through that boundary is lossless
 * enough to log a weight without it drifting.
 */

describe('weight display', () => {
  it('labels the unit', () => {
    expect(weightUnitLabel('metric')).toBe('kg')
    expect(weightUnitLabel('imperial')).toBe('lbs')
  })

  it('leaves kilograms untouched in metric', () => {
    expect(displayWeight(88.4, 'metric')).toBeCloseTo(88.4, 6)
  })

  it('converts to pounds in imperial', () => {
    expect(displayWeight(88.4, 'imperial')).toBeCloseTo(194.888, 2)
  })

  it('round-trips through the display boundary without drift', () => {
    for (const kg of [42, 62.5, 88.4, 120.75]) {
      for (const u of ['metric', 'imperial'] as const) {
        expect(storedWeightKg(displayWeight(kg, u), u)).toBeCloseTo(kg, 9)
      }
    }
  })

  it('formats with one decimal and the right unit', () => {
    expect(formatWeight(88.4, 'metric')).toBe('88.4 kg')
    expect(formatWeight(88.4, 'imperial')).toBe('194.9 lbs')
  })

  it('renders an em dash for a missing weight rather than NaN', () => {
    expect(formatWeight(null, 'metric')).toBe('—')
    expect(formatWeight(null, 'imperial')).toBe('—')
  })
})

describe('rate of change', () => {
  /**
   * `@nutai/goals` reports slope in lb/week because the kcal-per-pound model it
   * derives from is defined that way. Metric users must never see that leak out.
   */
  it('passes pounds per week through in imperial', () => {
    expect(formatRate(-1.02, 'imperial')).toBe('-1.02 lb/wk')
  })

  it('converts pounds per week to kilograms per week in metric', () => {
    expect(formatRate(-1.1023, 'metric')).toBe('-0.50 kg/wk')
  })

  it('signs a gain explicitly so direction is never ambiguous', () => {
    expect(formatRate(0.5, 'imperial')).toBe('+0.50 lb/wk')
    expect(formatRate(1.1023, 'metric')).toBe('+0.50 kg/wk')
  })

  it('renders an em dash when there is not enough history', () => {
    expect(formatRate(null, 'metric')).toBe('—')
  })
})

describe('height display', () => {
  it('shows whole centimetres in metric', () => {
    expect(formatHeight(180, 'metric')).toBe('180 cm')
    expect(formatHeight(180.4, 'metric')).toBe('180 cm')
  })

  it('shows feet and inches in imperial', () => {
    expect(formatHeight(180, 'imperial')).toBe('5\'11"')
    expect(formatHeight(152.4, 'imperial')).toBe('5\'0"')
  })

  it('carries 12 inches up to the next foot instead of printing 6\'12"', () => {
    // 182.7cm is 71.93in — rounds to 72in, which must read 6'0" and never 5'12".
    expect(formatHeight(182.7, 'imperial')).toBe('6\'0"')
  })

  it('renders an em dash for an unknown height', () => {
    expect(formatHeight(null, 'imperial')).toBe('—')
  })
})
