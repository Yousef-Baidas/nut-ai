import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PortionSheet } from '../src/components/PortionSheet'
import { db } from '../src/data/repo'
import {
  deleteSavedMeal,
  listSavedMeals,
  parseSavedItems,
  touchSavedMeal,
  type SavedMealRow,
} from '../src/data/saved-meals'
import { startSavedMealLog } from '../src/scan/orchestrator'
import { useTheme } from '../src/theme/ThemeProvider'
import { radius, space, type } from '../src/theme/tokens'

/**
 * Saved meals.
 *
 * A saved meal stores the CORRECTED ingredient array, not a food name to
 * re-analyze. That is what makes relogging free: zero network requests, zero
 * clarifying questions, and identical numbers to the day you fixed them.
 *
 * The portion sheet is reused rather than reinvented: for a saved meal its
 * options are fractions of the saved size, and the grams the user confirms
 * become a scale factor over every row. Same component, same gram field, same
 * "the number stays editable" promise.
 */
export default function SavedFoods() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [meals, setMeals] = useState<SavedMealRow[]>([])
  const [pending, setPending] = useState<SavedMealRow | null>(null)

  const reload = useCallback(async () => {
    const h = await db()
    return listSavedMeals(h)
  }, [])

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        try {
          const rows = await reload()
          if (alive) setMeals(rows)
        } catch {
          // Fail soft: an unreadable list is an empty list, never an unhandled
          // rejection on a screen with no error UI of its own.
          if (alive) setMeals([])
        }
      })()
      return () => { alive = false }
    }, [reload]),
  )

  function confirmDelete(meal: SavedMealRow) {
    Alert.alert('Delete saved meal', `Remove “${meal.name}”? Meals already logged are untouched.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deleteSavedMeal(await db(), meal.id)
              setMeals(await reload())
            } catch {
              Alert.alert('Could not delete', 'Nothing was removed. Try again.')
            }
          })()
        },
      },
    ])
  }

  function logAgain(grams: number) {
    const meal = pending
    setPending(null)
    if (!meal) return
    const rows = parseSavedItems(meal.items_json)
    const total = rows.reduce((a, r) => a + r.grams, 0)
    if (rows.length === 0 || total <= 0) {
      Alert.alert('Could not read this saved meal', 'Its ingredients could not be restored.')
      return
    }
    void (async () => {
      try {
        await touchSavedMeal(await db(), meal.id, Date.now())
        startSavedMealLog(rows, grams / total)
        router.replace('/result')
      } catch {
        Alert.alert('Could not log this meal', 'Nothing was logged. Try again.')
      }
    })()
  }

  const pendingRows = pending ? parseSavedItems(pending.items_json) : []
  const pendingTotal = pendingRows.reduce((a, r) => a + r.grams, 0)

  // The sheet only mounts when `pendingTotal > 0`, so a corrupt or 0-gram
  // saved meal would otherwise leave `pending` set with nothing rendered —
  // a tap that looks dead. Surface it and clear `pending` instead.
  useEffect(() => {
    if (pending && pendingTotal <= 0) {
      Alert.alert('Could not read this saved meal', 'Its ingredients could not be restored.')
      setPending(null)
    }
  }, [pending, pendingTotal])

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.lg }}>
      <View style={styles.head}>
        <Text style={[type.title, { color: theme.text }]}>Saved foods</Text>
        <Pressable onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        {meals.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: theme.bgSunken }]}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>Nothing saved yet</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
              After you correct a scan, tap Save on the review screen. Relogging it later costs
              nothing — no scan, no network request, and none of the questions you already
              answered.
            </Text>
          </View>
        ) : (
          meals.map((m) => (
            <View key={m.id} style={[styles.row, { backgroundColor: theme.bgSunken }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={m.name}
                onPress={() => setPending(m)}
                style={{ flex: 1 }}
              >
                <Text style={[type.bodyStrong, { color: theme.text }]}>{m.name}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>
                  Logged {m.use_count} {m.use_count === 1 ? 'time' : 'times'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Log ${m.name} again`}
                onPress={() => setPending(m)}
                hitSlop={space.sm}
              >
                <Text style={[type.label, { color: theme.protein }]}>Log again</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${m.name}`}
                onPress={() => confirmDelete(m)}
                hitSlop={space.md}
              >
                <Text style={{ color: theme.textFaint, fontSize: 20 }}>×</Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>

      {pending && pendingTotal > 0 ? (
        <PortionSheet
          title={pending.name}
          subtitle={`Saved at ${Math.round(pendingTotal)} g across ${pendingRows.length} ${pendingRows.length === 1 ? 'ingredient' : 'ingredients'}`}
          options={[
            { label: 'Full meal', grams: pendingTotal },
            { label: 'Half', grams: pendingTotal / 2 },
            { label: 'Double', grams: pendingTotal * 2 },
          ]}
          initialGrams={pendingTotal}
          confirmLabel="Add to review"
          onCancel={() => setPending(null)}
          onConfirm={logAgain}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  empty: { padding: space.lg, borderRadius: radius.xl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.lg, marginBottom: space.sm,
  },
})
