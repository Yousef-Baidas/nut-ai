import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Linking } from 'react-native'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ProviderId } from '@nutai/prompt'
import { availability } from '../../src/health/healthkit'
import { disableHealthSync, enableHealthSync, healthSyncEnabled } from '../../src/health/meal-sync'
import { exportAndShareBackup, finishRestore, importBackup, pickBackupFile } from '../../src/data/backup'
import { foodServerUrl } from '../../src/data/food-server'
import {
  currentGoal,
  profileHeightCm,
  resetEverything,
  setting,
  setUnitSystem,
  unitSystem,
  type CurrentGoal,
} from '../../src/data/repo'
import { formatHeight, type UnitSystem } from '../../src/units/format'
import { loadCredential, maskCredential } from '../../src/inference/credentials'
import { PROVIDER_NAME } from '../../src/components/CredentialForm'
import { Icon } from '../../src/components/Icon'
import { useTheme } from '../../src/theme/ThemeProvider'
import { radius, space, type } from '../../src/theme/tokens'

/**
 * Profile.
 *
 * Structurally the reference's settings list, minus everything that only exists
 * to extract money or attention:
 *
 *   NO "Refer a friend and earn $10" — a referral bounty is a growth mechanic,
 *   and there is no money here to pay it with.
 *   NO "Upgrade to Family Plan", no Premium crown. There is no paid tier.
 *   NO Logout / Delete Account. There is no account and no server; a delete
 *     button that only clears local data should say exactly that, which is what
 *     "Erase all data" below does.
 *   NO Follow Us. A settings screen is not a marketing surface.
 */
export default function Profile() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [goal, setGoal] = useState<CurrentGoal | null>(null)
  const [healthAvail, setHealthAvail] = useState<'available' | 'not-ios' | 'unavailable' | 'checking'>('checking')
  const [healthBusy, setHealthBusy] = useState(false)
  const [healthSync, setHealthSync] = useState(false)
  const [diet, setDiet] = useState('')
  const [providerLabel, setProviderLabel] = useState('—')
  const [serverHost, setServerHost] = useState('')
  const [dataBusy, setDataBusy] = useState(false)
  const [units, setUnits] = useState<UnitSystem>('imperial')
  const [heightCm, setHeightCm] = useState<number | null>(null)

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const [g, avail, d, p, u, cm, hs, srv] = await Promise.all([
          currentGoal(),
          availability(),
          setting('diet.style', 'balanced'),
          setting('provider'),
          unitSystem(),
          profileHeightCm(),
          healthSyncEnabled(),
          foodServerUrl(),
        ])
        if (!alive) return
        // Show the host, not the scheme — the row answers "which machine?",
        // and the settings screen holds the full URL.
        setServerHost(srv.replace(/^https?:\/\//, ''))
        setGoal(g)
        setDiet(d)
        setUnits(u)
        setHeightCm(cm)
        setHealthSync(hs)
        setHealthAvail(avail === 'available' ? 'available' : avail === 'not-ios' ? 'not-ios' : 'unavailable')
        if (!p || p === 'none') {
          setProviderLabel('Not connected')
        } else {
          const cred = await loadCredential(p as ProviderId)
          if (!alive) return
          setProviderLabel(
            cred
              ? `${PROVIDER_NAME[p as ProviderId]} · ${maskCredential(cred.value)}`
              : `${PROVIDER_NAME[p as ProviderId]} · key missing`,
          )
        }
      })()
      return () => {
        alive = false
      }
    }, []),
  )

  /**
   * Switching units rewrites NOTHING but the preference.
   *
   * Every stored measurement is already metric — `weights.weight_kg`,
   * `user_profile.height_cm`, and the goal maths — so imperial is purely a render
   * skin. That is what makes this toggle safe to flip at any time: there is no
   * migration, no rounding loss, and no way for it to corrupt a weight history.
   */
  function changeUnits(next: UnitSystem) {
    if (next === units) return
    setUnits(next)
    void setUnitSystem(next)
  }

  /**
   * The toggle IS the permission ask. Nothing requests Health access before
   * this, and nothing writes to Health unless this is on.
   */
  function toggleHealthSync(next: boolean) {
    if (healthBusy) return
    setHealthBusy(true)
    void (async () => {
      if (!next) {
        await disableHealthSync()
        setHealthSync(false)
        setHealthBusy(false)
        return
      }
      const res = await enableHealthSync()
      setHealthSync(res.enabled)
      setHealthBusy(false)
      Alert.alert(res.enabled ? 'Health sync is on' : 'Health sync is off', res.message)
    })()
  }

  function exportData() {
    if (dataBusy) return
    setDataBusy(true)
    void (async () => {
      try {
        const res = await exportAndShareBackup()
        if (!res.shared) Alert.alert('Exported', `Saved to ${res.name}. Sharing is unavailable on this device.`)
      } catch {
        Alert.alert('Export failed', 'Could not write the backup file. Try again.')
      } finally {
        setDataBusy(false)
      }
    })()
  }

  function importData() {
    if (dataBusy) return
    void (async () => {
      const picked = await pickBackupFile()
      if (!picked.ok) {
        if (picked.reason !== 'cancelled') {
          Alert.alert('Not a backup', "That doesn't look like a Nut AI backup file.")
        }
        return
      }
      Alert.alert(
        'Restore this backup?',
        'This replaces ALL data currently on this device and cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            style: 'destructive',
            onPress: () => {
              setDataBusy(true)
              void (async () => {
                try {
                  const outcome = await importBackup(picked.payload)
                  if (!outcome.ok) {
                    Alert.alert('Cannot restore', 'This backup is from a newer version of Nut AI — update the app first.')
                    return
                  }
                  await finishRestore()
                  router.replace('/(tabs)' as never)
                } catch (e) {
                  // A restore that fails must SAY SO — the transaction rolled
                  // back, nothing was lost, and silence here cost us a real
                  // debugging session once already.
                  Alert.alert('Restore failed', `Nothing was changed. ${String((e as Error)?.message ?? e)}`)
                } finally {
                  setDataBusy(false)
                }
              })()
            },
          },
        ],
      )
    })()
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 150 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[type.title, { color: theme.text }]}>Profile</Text>

      <View style={[styles.hero, { backgroundColor: theme.bgSunken }]}>
        <Text style={[type.bodyStrong, { color: theme.text }]}>No account needed</Text>
        <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
          Everything lives on this device. There is no sign-in, no server, and nothing to breach.
        </Text>
      </View>

      <Section title="Goals & tracking">
        <Row
          label="Daily target"
          value={goal ? `${Math.round(goal.targetKcal)} kcal` : '—'}
          onPress={() => router.push('/edit-goals' as never)}
        />
        <Row
          label="Protein / Carbs / Fat"
          value={goal ? `${Math.round(goal.protein_g)} / ${Math.round(goal.carbs_g)} / ${Math.round(goal.fat_g)} g` : '—'}
          onPress={() => router.push('/edit-goals' as never)}
        />
        <Row label="Log weight" value="" onPress={() => router.push('/log-weight' as never)} />
        <UnitsRow units={units} onChange={changeUnits} />
        <Row label="Height" value={formatHeight(heightCm, units)} />
        <Row label="Diet style" value={diet} />
        <Row
          label="Adaptive target"
          value={goal ? (goal.adaptive ? 'On' : 'Off — set by hand') : '—'}
        />
      </Section>

      <Section title="AI provider">
        <Row label="Provider & key" value={providerLabel} onPress={() => router.push('/provider-settings' as never)} />
      </Section>

      <Section title="Food database">
        <Row label="Server address" value={serverHost} onPress={() => router.push('/food-server-settings' as never)} />
      </Section>

      <Section title="Apple Health">
        {healthAvail === 'available' ? (
          <>
            <Row
              label={healthBusy ? 'Working…' : 'Sync meals to Apple Health'}
              value={healthSync ? 'On' : 'Off'}
              onPress={() => toggleHealthSync(!healthSync)}
            />
            <Pressable onPress={() => void Linking.openSettings()} style={{ padding: space.lg, paddingTop: 0 }}>
              <Text style={[type.caption, { color: theme.textMuted, lineHeight: 18 }]}>
                Each meal you log is written as one food entry. Turning this off stops us writing;
                revoking access itself lives in{' '}
                <Text style={{ color: theme.protein }}>Settings → Privacy &amp; Security → Health</Text>.
              </Text>
            </Pressable>
          </>
        ) : (
          <Row label="Sync meals to Apple Health" value={healthAvail === 'not-ios' ? 'iOS only' : 'Needs a dev build'} />
        )}
      </Section>

      <Section title="Your data">
        <Row label={dataBusy ? 'Working…' : 'Export data'} value="" onPress={exportData} />
        <Row label="Import data" value="" onPress={importData} />
        <Text style={[type.caption, { color: theme.textFaint, padding: space.lg, paddingTop: space.xs, lineHeight: 18 }]}>
          One JSON file with everything: meals, weights, goals, settings. Your API key never
          travels in it — re-enter that once after restoring on a new phone.
        </Text>
      </Section>

      <Section title="How your numbers work">
        {goal ? (
          <View style={{ padding: space.lg, gap: space.sm }}>
            <Line label="BMR (Mifflin-St Jeor)" value={`${Math.round(goal.bmr)} kcal`} />
            <Line label="TDEE (BMR × activity)" value={`${Math.round(goal.tdee)} kcal`} />
            <Line label="Your target" value={`${Math.round(goal.targetKcal)} kcal`} />
            {goal.floorApplied ? (
              <Text style={[type.caption, { color: theme.uncertain, marginTop: space.xs }]}>
                Raised to our safe floor. Your inputs alone gave {Math.round(goal.targetRawKcal)} kcal.
              </Text>
            ) : null}
          </View>
        ) : null}
      </Section>

      <Section title="Start over">
        <Row
          label="Redo onboarding"
          value=""
          onPress={() => {
            Alert.alert(
              'Erase everything and start over?',
              'Deletes your profile, goals, weight history, logged meals and saved API keys from this device. It cannot be undone, and there is no backup on a server because there is no server.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Erase and restart',
                  style: 'destructive',
                  onPress: () => {
                    void resetEverything().then(() => router.replace('/onboarding' as never))
                  },
                },
              ],
            )
          }}
        />
      </Section>

      <Section title="About">
        <Row label="License" value="AGPL-3.0" />
        <Row label="Nutrition data" value="USDA (CC0) + Open Food Facts (ODbL) + curated-cited" />
      </Section>

      <Text style={[type.caption, { color: theme.textFaint, marginTop: space.xl, lineHeight: 19 }]}>
        Nut AI's estimates are AI-generated approximations and may not be accurate. It is not a
        medical device and does not diagnose, treat, cure or prevent any condition. Consult a
        registered dietitian or healthcare provider before making medical decisions.
      </Text>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme()
  return (
    <View style={{ marginTop: space.xl }}>
      <Text style={[type.label, { color: theme.textMuted, marginBottom: space.sm }]}>{title}</Text>
      <View style={[styles.group, { backgroundColor: theme.bgSunken }]}>{children}</View>
    </View>
  )
}

function Row({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const theme = useTheme()
  const body = (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Text style={[type.body, { color: theme.text, flex: 1 }]}>{label}</Text>
      {value ? <Text style={[type.body, { color: theme.textMuted }]}>{value}</Text> : null}
      {onPress ? (
        <View style={{ marginLeft: space.sm }}>
          <Icon name="chevron" size={16} color={theme.textFaint} />
        </View>
      ) : null}
    </View>
  )
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    body
  )
}

/**
 * The units control.
 *
 * A segmented control rather than a chevron into a sub-screen: there are exactly
 * two choices and the effect is visible immediately on this very screen (the
 * Height row below it re-renders), so a navigation push would cost a round trip
 * to change one bit.
 */
function UnitsRow({ units, onChange }: { units: UnitSystem; onChange: (u: UnitSystem) => void }) {
  const theme = useTheme()
  const OPTIONS: ReadonlyArray<{ key: UnitSystem; label: string }> = [
    { key: 'imperial', label: 'lbs / ft' },
    { key: 'metric', label: 'kg / cm' },
  ]

  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Text style={[type.body, { color: theme.text, flex: 1 }]}>Units</Text>
      <View style={[styles.segment, { backgroundColor: theme.bgElevated }]}>
        {OPTIONS.map((o) => {
          const active = units === o.key
          return (
            <Pressable
              key={o.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={o.label}
              onPress={() => onChange(o.key)}
              style={[styles.segItem, active && { backgroundColor: theme.bg }]}
            >
              <Text style={[type.label, { color: active ? theme.text : theme.textMuted }]}>
                {o.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  const theme = useTheme()
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={[type.caption, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[type.caption, { color: theme.text, fontWeight: '600' }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  hero: { marginTop: space.lg, padding: space.lg, borderRadius: radius.xl },
  group: { borderRadius: radius.xl, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  // Matches the window selector on Progress, so a segmented control means the
  // same thing in both places.
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 2, gap: 2 },
  segItem: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
