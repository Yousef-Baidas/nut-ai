import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import {
  DEFAULT_FOOD_SERVER_URL,
  UNREACHABLE_COPY,
  fetchHealth,
  foodServerUrl,
  setFoodServerUrl,
} from '../src/data/food-server'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Where the food database lives.
 *
 * The default is the tailnet address of the PC that built the corpus. Editing it
 * is the whole screen; "Test" is the honest part — it answers with the corpus
 * line or with the unreachable sentence, so a typo is visible here rather than
 * three screens later in the middle of logging lunch.
 */
export default function FoodServerSettings() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [url, setUrl] = useState(DEFAULT_FOOD_SERVER_URL)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useFocusEffect(
    useCallback(() => {
      void (async () => { setUrl(await foodServerUrl()) })()
    }, []),
  )

  function test() {
    setBusy(true)
    setStatus('Checking…')
    void (async () => {
      await setFoodServerUrl(url)
      const r = await fetchHealth()
      setBusy(false)
      if (r.kind !== 'ok') { setStatus(UNREACHABLE_COPY); return }
      setStatus(
        `${r.value.foods.toLocaleString()} foods · ${r.value.barcodes.toLocaleString()} barcodes` +
          (r.value.schemaMismatch ? ' · the server and app versions may differ' : ''),
      )
    })()
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.head, { paddingTop: insets.top + space.sm }]}>
        <Text style={[type.title, { color: theme.text }]}>Food database</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
          <Icon name="close" size={22} color={theme.textMuted} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 120 }}>
        <Text style={[type.caption, { color: theme.textMuted, lineHeight: 19 }]}>
          The food database runs on your own PC and is reachable over Tailscale. Nothing here
          is sent to anyone else.
        </Text>

        <TextInput
          accessibilityLabel="Food server address"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_FOOD_SERVER_URL}
          placeholderTextColor={theme.textFaint}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={test}
          style={[styles.button, { borderColor: theme.border }, busy && { opacity: 0.5 }]}
        >
          <Text style={[type.bodyStrong, { color: theme.text }]}>{busy ? 'Checking…' : 'Save and test'}</Text>
        </Pressable>

        {status !== '' && (
          <Text style={[type.caption, { color: status === UNREACHABLE_COPY ? theme.safety : theme.textMuted, marginTop: space.md }]}>
            {status}
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  input: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 48,
  },
  button: {
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
