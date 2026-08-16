import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ScoredCandidate } from '@nutai/resolver'
import { PortionSheet } from '../src/components/PortionSheet'
import {
  UNREACHABLE_COPY,
  fetchHealth,
  searchFoods,
  type FoodDetail,
  type Health,
} from '../src/data/food-server'
import { DEFAULT_PORTION_GRAMS, toPortionOptions, type PortionOption } from '../src/db/portion-options'
import { attributionFor, corpusRowFromResolved } from '../src/scan/rows'
import { startSearchLog } from '../src/scan/orchestrator'
import { CLEARED_SEARCH_STATE, searchOutcomeState } from '../src/scan/search-outcome'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Foods — the library that replaces the incumbent's `Groups` social feed.
 *
 * The corpus lives on the user's PC now, reached over Tailscale through
 * `../src/data/food-server`. There is no bundled database on the phone any
 * more, so "unreachable" is a first-class state here, not an edge case: the
 * PC being asleep must read as an honest sentence, never a hang or a false
 * "nothing matched".
 */
export default function FoodSearch() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [details, setDetails] = useState<Record<string, FoodDetail>>({})
  const [outcome, setOutcome] = useState<string>('')
  const [unreachable, setUnreachable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<
    { candidate: ScoredCandidate; options: PortionOption[]; source: string | null } | null
  >(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await fetchHealth()
      if (!alive) return
      if (r.kind === 'ok') { setHealth(r.value); setHealthError(null) }
      else { setHealth(null); setHealthError(UNREACHABLE_COPY) }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (query.trim().length < 2) {
      // CLEARED_SEARCH_STATE.busy is false — clearing the field must not leave
      // the spinner running under an empty box (see search-outcome.ts).
      setResults(CLEARED_SEARCH_STATE.results)
      setDetails(CLEARED_SEARCH_STATE.details)
      setOutcome(CLEARED_SEARCH_STATE.outcome)
      setUnreachable(CLEARED_SEARCH_STATE.unreachable)
      setBusy(CLEARED_SEARCH_STATE.busy)
      return
    }
    let alive = true
    setBusy(true)
    const timer = setTimeout(() => {
      void (async () => {
        // The moment the request fires, the rows on screen belong to the OLD
        // query — leaving them tappable under the spinner invites logging the
        // wrong food. Clearing here (post-debounce) rather than per keystroke
        // keeps typing flicker-free.
        setResults([])
        setDetails({})
        const r = await searchFoods(query.trim(), 150)
        if (!alive) return
        // The spinner is cleared on EVERY branch, including the failures. A
        // spinner that outlives its request is the defect class this screen
        // has already been fixed for once.
        setBusy(false)
        const state = searchOutcomeState(r)
        setResults(state.results)
        setDetails(state.details)
        setOutcome(state.outcome)
        setUnreachable(state.unreachable)
      })()
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])

  const corpusLine = useMemo(() => {
    if (healthError != null) return healthError
    if (health == null) return 'Checking the food server…'
    const tiers = health.tiers.length > 0 ? health.tiers.join(' + ') : 'no tiers recorded'
    return `${health.foods.toLocaleString()} foods · ${health.barcodes.toLocaleString()} barcodes · ${tiers} · on your PC`
  }, [health, healthError])

  /**
   * Tapping a result is the whole point of this screen.
   *
   * It used to render plain Views: a search that could resolve a food perfectly
   * and then do nothing with it. The portion sheet is the only question left —
   * the corpus already knows the nutrition, it does not know how much you ate.
   */
  function openPortionSheet(candidate: ScoredCandidate) {
    const detail = details[candidate.foodId]
    setPending({
      candidate,
      options: detail == null ? [] : toPortionOptions(detail.portions),
      source: detail?.food.source ?? null,
    })
  }

  function confirmPortion(grams: number) {
    const candidate = pending?.candidate
    setPending(null)
    if (!candidate) return
    const detail = details[candidate.foodId]
    const ok = detail == null ? false : startSearchLog(corpusRowFromResolved(detail.food), grams)
    if (ok) router.replace('/result')
    else Alert.alert('Could not log this food', 'Its data could not be read from the food server. Nothing was logged.')
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
      <Text style={[type.caption, { color: healthError != null ? theme.safety : theme.textMuted, marginTop: space.xs }]}>
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

      {query.trim().length >= 2 && !busy && results.length === 0 && !unreachable && (
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

      {unreachable && !busy && (
        <View style={{ marginTop: space.lg }}>
          <Text style={[type.caption, { color: theme.safety, lineHeight: 19 }]}>
            {UNREACHABLE_COPY} Nothing was searched. You can still enter this food by hand.
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
              ? `${Math.round(pending.candidate.energyKcal)} kcal / 100 g · ${attributionFor(pending.source)}`
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
