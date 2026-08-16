import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { availability, type HealthAvailability } from '../../src/health/healthkit'
import { OnboardingScreen } from '../../src/components/onboarding/Chrome'
import { nextRoute, stepIndex, TOTAL_STEPS } from '../../src/onboarding/flow'
import { setAnswer } from '../../src/onboarding/store'
import { Icon } from '../../src/components/Icon'
import { useTheme } from '../../src/theme/ThemeProvider'
import { palette, radius, space, type } from '../../src/theme/tokens'

/**
 * Apple Health — informational only.
 *
 * This screen does NOT request HealthKit permission and does NOT connect
 * anything. #5: it used to present the permission sheet here, and nothing in
 * the app ever read or wrote a single sample — asking for medical data access
 * to power nothing is the one thing a health app cannot afford to do.
 *
 * The real ask now lives on the "Sync meals to Apple Health" toggle in
 * Profile: WRITE-only (it writes the meals you log; it never reads steps,
 * workouts, weight or energy), and only presented when the user turns it on.
 * This screen just tells them that toggle exists and moves on.
 */
export default function HealthScreen() {
  const theme = useTheme()
  const [avail, setAvail] = useState<HealthAvailability | null>(null)

  useEffect(() => {
    let alive = true
    void availability().then((a) => {
      if (alive) setAvail(a)
    })
    return () => {
      alive = false
    }
  }, [])

  const go = () => router.push(nextRoute('health') as never)

  function proceed() {
    setAnswer('healthConnected', avail === 'available')
    go()
  }

  const unsupported = avail === 'not-ios' || avail === 'unavailable'

  return (
    <OnboardingScreen
      step={stepIndex('health')}
      total={TOTAL_STEPS}
      title=""
      cta="Continue"
      onCta={proceed}
      secondaryLabel="Skip"
      onSecondary={() => {
        setAnswer('healthConnected', false)
        go()
      }}
      scroll
    >
      <View style={{ alignItems: 'center' }}>
        <View style={[styles.halo, { backgroundColor: theme.uncertainBg }]}>
          <View style={styles.row}>
            <View style={[styles.tile, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              <Icon name="heart" size={34} color={palette.chartWithoutPlan} />
            </View>
            <Icon name="chevron" size={20} color={theme.textMuted} />
            <View style={[styles.tile, { backgroundColor: theme.text }]}>
              <Icon name="flame" size={34} color={theme.bg} />
            </View>
          </View>
        </View>
      </View>

      <Text style={[styles.heading, { color: theme.text }]}>Apple Health</Text>
      <Text style={[type.body, { color: theme.textMuted, marginTop: space.md }]}>
        Nut AI can write the meals you log to Apple Health as food entries. It never reads
        anything — no steps, workouts, weight or energy.
      </Text>

      <View style={[styles.note, { backgroundColor: theme.uncertainBg }]}>
        <Text style={[type.caption, { color: theme.text }]}>
          {avail === 'available'
            ? 'This is off by default. Switch on “Sync meals to Apple Health” in Profile whenever you want — we will ask Health for permission at that moment, not now.'
            : unsupported && avail != null
              ? avail === 'not-ios'
                ? 'Apple Health is iOS only. Nothing here depends on it.'
                : 'Apple Health is not available in this build. It needs a development build, not Expo Go.'
              : 'Checking availability…'}
        </Text>
      </View>
    </OnboardingScreen>
  )
}

const styles = StyleSheet.create({
  halo: {
    width: '100%', borderRadius: radius.xl, paddingVertical: space.xxl,
    alignItems: 'center', marginTop: space.lg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  tile: {
    width: 86, height: 86, borderRadius: radius.lg,
    alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth,
  },
  heading: { fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -1, marginTop: space.xl },
  note: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg },
})
