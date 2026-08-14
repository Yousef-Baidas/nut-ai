import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PortionOption } from '../db/portion-options'
import { DEFAULT_PORTION_GRAMS } from '../db/portion-options'
import { DONE_ACCESSORY_ID, KeyboardDoneBar } from './KeyboardDoneBar'
import { useTheme } from '../theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../theme/tokens'

/**
 * How many grams — the one question between a found food and a logged one.
 *
 * ONE component, three callers: text search, saved meals, and the barcode-miss
 * screen's "log it anyway" path. They differ only in what they call the thing
 * and what the options mean, which is why both are props rather than branches.
 *
 * The gram field is always present, even when there are household measures.
 * A measure is a shortcut, never a cage: the number it fills in stays editable,
 * because the user is the only one who knows what was actually on the plate.
 */
export interface PortionSheetProps {
  title: string
  subtitle?: string
  options: readonly PortionOption[]
  initialGrams: number
  confirmLabel: string
  onCancel: () => void
  onConfirm: (grams: number) => void
}

export function PortionSheet({
  title,
  subtitle,
  options,
  initialGrams,
  confirmLabel,
  onCancel,
  onConfirm,
}: PortionSheetProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [grams, setGrams] = useState(String(Math.round(initialGrams || DEFAULT_PORTION_GRAMS)))

  const parsed = Number(grams)
  const valid = Number.isFinite(parsed) && parsed > 0

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Dismiss" />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, space.lg) },
        ]}
      >
        <Text style={[type.heading, { color: theme.text }]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs }]}>{subtitle}</Text>
        ) : null}

        {options.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: space.sm, paddingVertical: space.md }}
          >
            {options.map((o) => (
              <Pressable
                key={`${o.label}|${o.grams}`}
                accessibilityRole="button"
                onPress={() => setGrams(String(Math.round(o.grams)))}
                style={[styles.chip, { borderColor: theme.border }]}
              >
                <Text style={[type.label, { color: theme.text }]}>{o.label}</Text>
                <Text style={[type.micro, { color: theme.textFaint }]}>{Math.round(o.grams)} g</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md }]}>
            No household measures for this food — type the grams.
          </Text>
        )}

        <View style={styles.gramRow}>
          <TextInput
            accessibilityLabel="Grams"
            keyboardType="numeric"
            inputAccessoryViewID={DONE_ACCESSORY_ID}
            value={grams}
            onChangeText={setGrams}
            style={[styles.gramInput, { color: theme.text, borderColor: theme.border }]}
          />
          <Text style={[type.body, { color: theme.textMuted }]}>grams</Text>
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={!valid}
          onPress={() => valid && onConfirm(parsed)}
          style={[styles.primary, { backgroundColor: theme.text }, !valid && { opacity: 0.4 }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg }]}>{confirmLabel}</Text>
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={space.md} style={{ alignSelf: 'center', marginTop: space.md }}>
          <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
        </Pressable>

        <KeyboardDoneBar />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
  },
  gramRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md },
  gramInput: {
    width: 96,
    textAlign: 'right',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: MIN_TAP_TARGET,
    fontSize: 16,
  },
  primary: {
    marginTop: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
  },
})
