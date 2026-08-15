import { router } from 'expo-router'
import { useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from '../src/components/Icon'
import { DONE_ACCESSORY_ID, KeyboardDoneBar } from '../src/components/KeyboardDoneBar'
import { describeExercise } from '../src/exercise/describe'
import { latestWeightKg, saveEntry } from '../src/exercise/entries'
import {
  exerciseKcal,
  INTENSITY_ANCHORS,
  type ExerciseKind,
  type Intensity,
} from '../src/exercise/met'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Log exercise — the four-path flow.
 *
 * Run and Weight lifting are DETERMINISTIC: MET x body weight x minutes, the
 * same three intensity anchors the incumbent shows, no model anywhere.
 * Describe is the one model-owned path and says so on screen. Manual is the
 * user's own number, recorded verbatim.
 *
 * Everything lands in exercise_entries with provenance 'manual' (typed here,
 * as opposed to imported from Apple Health) so the HealthKit reader can never
 * double-count a workout that was also typed in.
 */

type Step =
  | { kind: 'menu' }
  | { kind: 'intensity'; exercise: ExerciseKind }
  | { kind: 'describe' }
  | { kind: 'manual' }

const MENU: Array<{ step: Step; icon: IconName; title: string; sub: string }> = [
  { step: { kind: 'intensity', exercise: 'run' }, icon: 'run', title: 'Run', sub: 'Running, jogging, sprinting, etc.' },
  { step: { kind: 'intensity', exercise: 'weights' }, icon: 'dumbbell', title: 'Weight lifting', sub: 'Machines, free weights, etc.' },
  { step: { kind: 'describe' }, icon: 'pencil', title: 'Describe', sub: 'Write your workout in text' },
  { step: { kind: 'manual' }, icon: 'flame', title: 'Manual', sub: 'Enter exactly how many calories you burned' },
]

const KIND_META: Record<ExerciseKind, { icon: IconName; title: string }> = {
  run: { icon: 'run', title: 'Run' },
  weights: { icon: 'dumbbell', title: 'Weight lifting' },
}

const DURATIONS = [15, 30, 60, 90] as const

/** Same fallback copy DescribeScreen shows for an unguarded rejection. */
const SAVE_FAILED_MESSAGE = 'Something went wrong saving this workout. Try again.'

export default function LogExercise() {
  const [step, setStep] = useState<Step>({ kind: 'menu' })

  // One accessory bar for the whole flow: only one sub-screen is mounted at a
  // time, so a single `nativeID` can never collide with itself.
  return (
    <>
      {step.kind === 'intensity' ? (
        <IntensityScreen exercise={step.exercise} onBack={() => setStep({ kind: 'menu' })} />
      ) : step.kind === 'describe' ? (
        <DescribeScreen onBack={() => setStep({ kind: 'menu' })} />
      ) : step.kind === 'manual' ? (
        <ManualScreen onBack={() => setStep({ kind: 'menu' })} />
      ) : (
        <MenuScreen onPick={setStep} />
      )}
      <KeyboardDoneBar />
    </>
  )
}

function Header({ title, icon, onBack }: { title: string; icon?: IconName; onBack: () => void }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack}
        style={[styles.backBtn, { backgroundColor: theme.bgSunken }]}
      >
        <View style={{ transform: [{ scaleX: -1 }] }}>
          <Icon name="chevron" size={18} color={theme.text} />
        </View>
      </Pressable>
      <View style={styles.headerTitle}>
        {icon ? <Icon name={icon} size={20} color={theme.text} /> : null}
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>{title}</Text>
      </View>
      <View style={{ width: 44 }} />
    </View>
  )
}

function MenuScreen({ onPick }: { onPick: (s: Step) => void }) {
  const theme = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title="Exercise" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 120 }}>
        <Text style={[type.title, { color: theme.text, fontSize: 34 }]}>Log Exercise</Text>

        <View style={{ marginTop: space.xl, gap: space.md }}>
          {MENU.map((m) => (
            <Pressable
              key={m.title}
              accessibilityRole="button"
              onPress={() => onPick(m.step)}
              style={[styles.optionCard, { backgroundColor: theme.bgSunken }]}
            >
              <Icon name={m.icon} size={26} color={theme.text} />
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>{m.title}</Text>
                <Text style={[type.body, { color: theme.textMuted, marginTop: 2 }]}>{m.sub}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

function IntensityScreen({ exercise, onBack }: { exercise: ExerciseKind; onBack: () => void }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [level, setLevel] = useState<Intensity>('medium')
  const [minutes, setMinutes] = useState('15')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const anchors = INTENSITY_ANCHORS[exercise]
  const mins = Number.parseInt(minutes, 10)
  const valid = Number.isFinite(mins) && mins > 0 && mins <= 600
  // Thumb sits at the selected anchor: index 0 (high) at the top.
  const idx = anchors.findIndex((a) => a.level === level)

  async function save() {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      // latestWeightKg (a SQLite read) and saveEntry (db() + INSERT) can both
      // reject — an unguarded await here strands the CTA on "Saving…"
      // forever, the same defect shape fixed for DescribeScreen.
      const kg = await latestWeightKg()
      const kcal = exerciseKcal(exercise, level, kg, mins)
      await saveEntry(`${KIND_META[exercise].title} — ${level}, ${mins} min`, kcal)
      router.back()
    } catch {
      setSaving(false)
      setError(SAVE_FAILED_MESSAGE)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title={KIND_META[exercise].title} icon={KIND_META[exercise].icon} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        <View style={styles.sectionHead}>
          <Icon name="sun" size={20} color={theme.text} />
          <Text style={[type.title, { color: theme.text, fontSize: 26 }]}>Set intensity</Text>
        </View>

        <View style={[styles.intensityCard, { backgroundColor: theme.bgSunken }]}>
          <View style={{ flex: 1, gap: space.xl }}>
            {anchors.map((a) => {
              const active = a.level === level
              return (
                <Pressable key={a.level} onPress={() => setLevel(a.level)} hitSlop={space.sm}>
                  <Text style={[active ? type.heading : type.bodyStrong, { color: active ? theme.text : theme.textMuted }]}>
                    {a.title}
                  </Text>
                  <Text
                    style={[
                      active ? type.bodyStrong : type.body,
                      { color: active ? theme.text : theme.textFaint, marginTop: 2, lineHeight: 20 },
                    ]}
                  >
                    {a.desc}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          {/* The level track: three tap zones, thumb at the active third. */}
          <View style={styles.track}>
            <View style={[styles.trackLine, { backgroundColor: theme.text }]} />
            {anchors.map((a, i) => (
              <Pressable
                key={a.level}
                accessibilityRole="button"
                accessibilityLabel={`${a.title} intensity`}
                onPress={() => setLevel(a.level)}
                style={[styles.trackZone, { top: `${(i * 100) / 3}%` as const }]}
              />
            ))}
            <View
              pointerEvents="none"
              style={[
                styles.thumb,
                { backgroundColor: theme.text, borderColor: theme.bg, top: `${(idx * 100) / 3 + 8}%` as const },
              ]}
            />
          </View>
        </View>

        <View style={[styles.sectionHead, { marginTop: space.xl }]}>
          <Icon name="clock" size={20} color={theme.text} />
          <Text style={[type.title, { color: theme.text, fontSize: 26 }]}>Duration</Text>
        </View>

        <View style={styles.chipRow}>
          {DURATIONS.map((d) => {
            const active = minutes === String(d)
            return (
              <Pressable
                key={d}
                onPress={() => setMinutes(String(d))}
                style={[
                  styles.chip,
                  active
                    ? { backgroundColor: theme.text }
                    : { borderWidth: 1.5, borderColor: theme.text },
                ]}
              >
                <Text style={[type.bodyStrong, { color: active ? theme.bg : theme.text }]}>{d} mins</Text>
              </Pressable>
            )
          })}
        </View>

        <TextInput
          accessibilityLabel="Duration in minutes"
          keyboardType="number-pad"
          inputAccessoryViewID={DONE_ACCESSORY_ID}
          value={minutes}
          onChangeText={(t) => {
            setMinutes(t)
            setError(null)
          }}
          style={[styles.minutesInput, { color: theme.text, borderColor: theme.border }]}
        />

        {error ? (
          <View style={[styles.example, { backgroundColor: theme.safetyBg, marginTop: space.md }]}>
            <Text style={[type.caption, { color: theme.safety, lineHeight: 19 }]}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={save}
          disabled={!valid || saving}
          style={[styles.cta, { backgroundColor: valid ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
            {saving ? 'Saving…' : 'Continue'}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

function DescribeScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    const desc = text.trim()
    if (!desc || busy) return
    setBusy(true)
    setError(null)

    // describeExercise owns the whole setting/credential/estimate/save chain
    // and never throws — any rejection in that chain resolves to
    // { ok: false, message }, so busy always gets cleared here instead of
    // stranding the spinner on an unhandled rejection (issue #27's shape).
    const outcome = await describeExercise(desc)
    setBusy(false)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    router.back()
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title="Describe Exercise" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
        <TextInput
          autoFocus
          placeholder="Describe workout time, intensity, etc."
          placeholderTextColor={theme.textFaint}
          value={text}
          onChangeText={(t) => {
            setText(t)
            setError(null)
          }}
          style={[styles.describeInput, { color: theme.text, borderColor: theme.border }]}
        />

        <View style={[styles.aiPill, { borderColor: theme.border }]}>
          <Icon name="scan" size={14} color={theme.text} />
          <Text style={[type.label, { color: theme.text }]}>Estimated with your API key</Text>
        </View>

        <View style={[styles.example, { backgroundColor: theme.bgSunken }]}>
          <Text style={[type.body, { color: theme.textMuted, lineHeight: 22 }]}>
            <Text style={{ fontWeight: '700', color: theme.text }}>Example:</Text> Leg strength
            training for 35 mins, 9/10 intensity
          </Text>
        </View>

        {error ? (
          <View style={[styles.example, { backgroundColor: theme.safetyBg, marginTop: space.md }]}>
            <Text style={[type.caption, { color: theme.safety, lineHeight: 19 }]}>{error}</Text>
          </View>
        ) : null}

        {busy ? <ActivityIndicator color={theme.textMuted} style={{ marginTop: space.xl }} /> : null}
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={add}
          disabled={!text.trim() || busy}
          style={[styles.cta, { backgroundColor: text.trim() && !busy ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
            {busy ? 'Estimating…' : 'Add Exercise'}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

function ManualScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [kcal, setKcal] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const n = Number.parseInt(kcal, 10)
  const valid = Number.isFinite(n) && n > 0 && n <= 5000

  async function add() {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      // saveEntry (db() + INSERT) can reject — an unguarded await here
      // strands the CTA on "Saving…" forever, the same defect shape fixed
      // for DescribeScreen.
      await saveEntry(name.trim() || 'Workout', n)
      router.back()
    } catch {
      setSaving(false)
      setError(SAVE_FAILED_MESSAGE)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Header title="Manual" icon="flame" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
        <Text style={[type.label, { color: theme.textMuted }]}>Calories burned</Text>
        <TextInput
          autoFocus
          accessibilityLabel="Calories burned"
          keyboardType="number-pad"
          inputAccessoryViewID={DONE_ACCESSORY_ID}
          placeholder="250"
          placeholderTextColor={theme.textFaint}
          value={kcal}
          onChangeText={(t) => {
            setKcal(t)
            setError(null)
          }}
          style={[styles.minutesInput, { color: theme.text, borderColor: theme.border, marginTop: space.sm }]}
        />

        <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Name (optional)</Text>
        <TextInput
          accessibilityLabel="Exercise name"
          placeholder="Workout"
          placeholderTextColor={theme.textFaint}
          value={name}
          onChangeText={(t) => {
            setName(t)
            setError(null)
          }}
          style={[styles.minutesInput, { color: theme.text, borderColor: theme.border, marginTop: space.sm, fontSize: 17, fontWeight: '400' }]}
        />

        <Text style={[type.caption, { color: theme.textFaint, marginTop: space.lg, lineHeight: 19 }]}>
          Recorded exactly as entered. Your number, your log.
        </Text>

        {error ? (
          <View style={[styles.example, { backgroundColor: theme.safetyBg, marginTop: space.md }]}>
            <Text style={[type.caption, { color: theme.safety, lineHeight: 19 }]}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={add}
          disabled={!valid || saving}
          style={[styles.cta, { backgroundColor: valid ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
            {saving ? 'Saving…' : 'Add Exercise'}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    minHeight: 84,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg },
  intensityCard: {
    flexDirection: 'row',
    gap: space.lg,
    marginTop: space.lg,
    padding: space.lg,
    paddingVertical: space.xl,
    borderRadius: radius.lg,
  },
  track: { width: 28, alignItems: 'center', position: 'relative' },
  trackLine: { width: 8, flex: 1, borderRadius: 4, opacity: 0.9 },
  trackZone: { position: 'absolute', left: -space.md, right: -space.md, height: '33%' },
  thumb: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 4,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
  },
  minutesInput: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    fontSize: 20,
    fontWeight: '700',
    minHeight: 56,
  },
  describeInput: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    fontSize: 17,
    minHeight: 56,
  },
  aiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    marginTop: space.lg,
  },
  example: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg },
  cta: { height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
