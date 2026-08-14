import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DONE_ACCESSORY_ID, KeyboardDoneBar } from '../src/components/KeyboardDoneBar'
import { validateManualEntry, type ManualEntryForm } from '../src/scan/manual-entry'
import { startManualLog } from '../src/scan/orchestrator'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Manual entry — the floor under every other path.
 *
 * When the corpus has no match, the barcode is not in a generic-tier dataset,
 * and there is no API key, this is what stands between the user and an
 * unloggable meal. It runs entirely offline and asks for the least it can:
 * a name and a calorie figure.
 *
 * It logs through `startManualLog`, i.e. through `readyFromRows`, so a typed
 * meal reaches the review screen as the same object a scan produces and gets
 * the same edit, save and Health-sync affordances.
 */
export default function ManualEntry() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ name?: string }>()

  const [form, setForm] = useState<ManualEntryForm>({
    name: typeof params.name === 'string' ? params.name : '',
    grams: '',
    kcal: '',
    protein: '',
    carbs: '',
    fat: '',
  })
  const [error, setError] = useState<string | null>(null)

  function set(key: keyof ManualEntryForm, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
    setError(null)
  }

  function submit() {
    const result = validateManualEntry(form)
    if (!result.ok) {
      setError(result.error)
      return
    }
    startManualLog(result.value)
    router.replace('/result')
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.bg }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 160 }}
      >
        <View style={styles.head}>
          <Text style={[type.title, { color: theme.text }]}>Enter by hand</Text>
          <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
            <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
          </Pressable>
        </View>
        <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
          Copy the numbers off the packet. Only a name and calories are required — this works
          with no key and no network.
        </Text>

        <Field label="Name" value={form.name} onChange={(v) => set('name', v)} autoFocus />
        <Field label="Grams in this portion" value={form.grams} onChange={(v) => set('grams', v)} numeric placeholder="100" />
        <Field label="Calories (kcal)" value={form.kcal} onChange={(v) => set('kcal', v)} numeric />
        <Field label="Protein (g)" value={form.protein} onChange={(v) => set('protein', v)} numeric placeholder="0" />
        <Field label="Carbs (g)" value={form.carbs} onChange={(v) => set('carbs', v)} numeric placeholder="0" />
        <Field label="Fat (g)" value={form.fat} onChange={(v) => set('fat', v)} numeric placeholder="0" />

        {error ? (
          <Text style={[type.caption, { color: theme.safety, marginTop: space.lg }]}>{error}</Text>
        ) : null}
      </ScrollView>

      <View
        style={[
          styles.actions,
          { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg, borderColor: theme.border },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          onPress={submit}
          style={[styles.primary, { backgroundColor: theme.text }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg }]}>Add to review</Text>
        </Pressable>
      </View>

      <KeyboardDoneBar />
    </KeyboardAvoidingView>
  )
}

function Field({
  label,
  value,
  onChange,
  numeric = false,
  autoFocus = false,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  numeric?: boolean
  autoFocus?: boolean
  placeholder?: string
}) {
  const theme = useTheme()
  return (
    <View style={{ marginTop: space.lg }}>
      <Text style={[type.label, { color: theme.textMuted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textFaint}
        keyboardType={numeric ? 'numeric' : 'default'}
        inputAccessoryViewID={DONE_ACCESSORY_ID}
        autoCorrect={!numeric}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    marginTop: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: MIN_TAP_TARGET,
  },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primary: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
  },
})
