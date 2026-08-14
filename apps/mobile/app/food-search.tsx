import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { DbAdapter } from '@nutai/db-adapter'
import { resolveByText, type ScoredCandidate } from '@nutai/resolver'
import { PortionSheet } from '../src/components/PortionSheet'
import { nutritionCorpusInfo, openNutritionDb } from '../src/db/expo-adapter'
import { DEFAULT_PORTION_GRAMS, portionOptionsFor, type PortionOption } from '../src/db/portion-options'
import { startSearchLog } from '../src/scan/orchestrator'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Foods — the library that replaces the incumbent's `Groups` social feed.
 *
 * Right now it is also the honest way to test the whole resolution stack on
 * device WITHOUT an API key: type a food, and the query runs through the real
 * `@nutai/resolver` — FTS5 candidate generation, six-signal scoring, the two-part
 * auto-accept rule — against the real 7,928-row USDA corpus. Everything here is
 * local. No network request is made by this screen, ever.
 */
export default function FoodSearch() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [db, setDb] = useState<DbAdapter | null>(null)
  const [corpus, setCorpus] = useState<{ foods: number; portions: number; builtAt: string | null } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [outcome, setOutcome] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ candidate: ScoredCandidate; options: PortionOption[] } | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const handle = await openNutritionDb()
      const info = await nutritionCorpusInfo(handle)
      if (!alive) return
      setDb(handle)
      setCorpus(info)
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!db || query.trim().length < 2) { setResults([]); setOutcome(''); return }
    let alive = true
    setBusy(true)
    const timer = setTimeout(async () => {
      const r = await resolveByText(db, {
        canonicalFoodKey: query,
        observedBrand: null,
        prepFacet: null,
        modelCategory: null,
        estimatedGrams: 150,
      })
      if (!alive) return
      if (r.outcome.kind === 'auto_accept') {
        setResults([r.outcome.match])
        setOutcome(`auto-accepted (score ${r.outcome.match.score.toFixed(2)})`)
      } else if (r.outcome.kind === 'disambiguate') {
        setResults(r.outcome.candidates)
        setOutcome(`${r.outcome.candidates.length} candidates — tap the right one`)
      } else {
        setResults([])
        setOutcome('no match — this would log as an AI estimate')
      }
      setBusy(false)
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [db, query])

  const corpusLine = useMemo(() => {
    if (!corpus) return 'Loading corpus…'
    if (corpus.foods === 0) {
      return 'Corpus missing — the app bundled without nutrition.db. Run `npm run data:build`.'
    }
    return `${corpus.foods.toLocaleString()} foods · ${corpus.portions.toLocaleString()} portion weights · USDA, CC0`
  }, [corpus])

  /**
   * Tapping a result is the whole point of this screen.
   *
   * It used to render plain Views: a search that could resolve a food perfectly
   * and then do nothing with it. The portion sheet is the only question left —
   * the corpus already knows the nutrition, it does not know how much you ate.
   */
  function openPortionSheet(candidate: ScoredCandidate) {
    if (!db) return
    void (async () => {
      const options = await portionOptionsFor(db, candidate.foodId)
      setPending({ candidate, options })
    })()
  }

  function confirmPortion(grams: number) {
    const candidate = pending?.candidate
    setPending(null)
    if (!candidate) return
    void (async () => {
      const ok = await startSearchLog(candidate.foodId, grams)
      // The review screen is a modal on the root stack; this screen is too, so
      // replace rather than push and there is no dead screen underneath.
      if (ok) router.replace('/result')
    })()
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 160 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[type.title, { color: theme.text }]}>Food Database</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
        </Pressable>
      </View>
      <Text style={[type.caption, { color: corpus?.foods === 0 ? theme.safety : theme.textMuted, marginTop: space.xs }]}>
        {corpusLine}
      </Text>

      <TextInput
        accessibilityLabel="Search foods"
        placeholder="Search — try “chicken breast”"
        placeholderTextColor={theme.textFaint}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        autoCapitalize="none"
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
      />

      {busy && <ActivityIndicator style={{ marginTop: space.lg }} color={theme.textFaint} />}

      {outcome !== '' && (
        <Text style={[type.micro, { color: theme.textFaint, marginTop: space.md }]}>{outcome.toUpperCase()}</Text>
      )}

      {results.map((r) => {
        // A row without energy has nothing to scale a portion against — startSearchLog
        // would happily log a phantom 0-kcal row. Stay visible, but not tappable.
        const loggable = r.energyKcal != null
        return (
          <Pressable
            key={r.foodId}
            accessibilityRole="button"
            accessibilityLabel={loggable ? `Log ${r.name}` : `${r.name}, energy not reported, cannot be logged`}
            accessibilityState={{ disabled: !loggable }}
            disabled={!loggable}
            onPress={loggable ? () => openPortionSheet(r) : undefined}
            style={[styles.row, { borderColor: theme.border }, !loggable && { opacity: 0.5 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[type.body, { color: theme.text }]} numberOfLines={2}>{r.name}</Text>
              <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                {loggable ? `${Math.round(r.energyKcal!)} kcal / 100 g` : 'energy not reported — cannot be logged'}
                {r.brand ? ` · ${r.brand}` : ''}
              </Text>
            </View>
            <Text style={[type.micro, { color: theme.textFaint }]}>{r.score.toFixed(2)}</Text>
          </Pressable>
        )
      })}

      {query.trim().length >= 2 && !busy && results.length === 0 && (
        <View style={{ marginTop: space.lg }}>
          <Text style={[type.caption, { color: theme.textMuted, lineHeight: 19 }]}>
            Nothing in the corpus matched “{query.trim()}”. That is not a dead end — enter the
            numbers off the packet and log it by hand.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/manual-entry', params: { name: query.trim() } } as never)}
            style={[styles.manualButton, { borderColor: theme.border }]}
          >
            <Text style={[type.bodyStrong, { color: theme.text }]}>Enter it by hand</Text>
          </Pressable>
        </View>
      )}

      {pending ? (
        <PortionSheet
          title={pending.candidate.name}
          subtitle={
            pending.candidate.energyKcal != null
              ? `${Math.round(pending.candidate.energyKcal)} kcal / 100 g · USDA`
              : 'Energy not reported for this food'
          }
          options={pending.options}
          initialGrams={pending.options[0]?.grams ?? DEFAULT_PORTION_GRAMS}
          confirmLabel="Add to review"
          onCancel={() => setPending(null)}
          onConfirm={confirmPortion}
        />
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  input: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 48,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  manualButton: {
    marginTop: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
    alignSelf: 'flex-start',
  },
})
