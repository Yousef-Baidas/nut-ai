import { Tabs, router } from 'expo-router'
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from '../../src/components/Icon'
import { useTheme } from '../../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../../src/theme/tokens'

/**
 * Three tabs plus the detached FAB.
 *
 * GROUPS IS GONE. A social feed cannot be local-first without a server we
 * operate, it needs Apple 1.2 moderation machinery before it can ship at all,
 * and it is the highest eating-disorder-risk surface in this product category.
 * Cutting it is the decision, not a gap.
 *
 * The FAB is ALWAYS present and ALWAYS opens real logging. The reference
 * paywalls this button, which is the direct cause of its most-reported
 * complaint. No IAP is configured anywhere in this project, which is what leaves
 * App Store Guideline 3.1.1 nothing to attach to.
 */

const TABS: ReadonlyArray<{ name: string; label: string; icon: IconName }> = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'progress', label: 'Progress', icon: 'chart' },
  { name: 'profile', label: 'Profile', icon: 'person' },
]

interface Action {
  label: string
  icon: IconName
  route: string
}

const ACTIONS: Action[] = [
  { label: 'Log exercise', icon: 'dumbbell', route: '/log-exercise' },
  { label: 'Saved foods', icon: 'bookmark', route: '/saved-foods' },
  { label: 'Enter by hand', icon: 'pencil', route: '/manual-entry' },
  { label: 'Food Database', icon: 'search', route: '/food-search' },
  { label: 'Scan food', icon: 'scan', route: '/camera' },
]

export default function TabLayout() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [sheetOpen, setSheetOpen] = useState(false)

  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: theme.bg } }}
        tabBar={({ state, navigation }) => (
          <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
            <View style={[styles.pill, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              {TABS.map((tab, i) => {
                const focused = state.index === i
                return (
                  <Pressable
                    key={tab.name}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: focused }}
                    accessibilityLabel={tab.label}
                    onPress={() => navigation.navigate(tab.name)}
                    style={[styles.tab, focused && { backgroundColor: theme.bgSunken }]}
                    hitSlop={space.sm}
                  >
                    <Icon name={tab.icon} size={21} color={focused ? theme.text : theme.textFaint} />
                    <Text style={[type.micro, { color: focused ? theme.text : theme.textFaint, marginTop: 1 }]}>
                      {tab.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add"
              onPress={() => setSheetOpen(true)}
              style={[styles.fab, { backgroundColor: theme.text }]}
            >
              <Icon name="plus" size={26} color={theme.bg} weight={2.2} />
            </Pressable>
          </View>
        )}
      >
        {TABS.map((t) => (
          <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />
        ))}
      </Tabs>

      <Modal visible={sheetOpen} transparent animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setSheetOpen(false)}>
          <View style={[styles.grid, { paddingBottom: Math.max(insets.bottom, space.md) + 90 }]}>
            {ACTIONS.map((a) => (
              <Pressable
                key={a.label}
                accessibilityRole="button"
                onPress={() => {
                  setSheetOpen(false)
                  router.push(a.route as never)
                }}
                style={[styles.action, { backgroundColor: theme.bgElevated }]}
              >
                <Icon name={a.icon} size={28} color={theme.text} />
                <Text style={[type.bodyStrong, styles.actionLabel, { color: theme.text }]}>
                  {a.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={[styles.closeWrap, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
            <View style={{ flex: 1 }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setSheetOpen(false)}
              style={[styles.fab, { backgroundColor: theme.text }]}
            >
              <Icon name="close" size={22} color={theme.bg} weight={2.2} />
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xs,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
    borderRadius: radius.pill,
  },
  fab: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  /**
   * Icon and label are centred on BOTH axes inside the card.
   *
   * `alignSelf: 'center'` matters: the grid wraps, and a wrapping flex container
   * defaults to `alignItems: 'stretch'`, which lets a line stretch a card's
   * height past the one `aspectRatio` asked for. When that happens the card grows
   * but the content stays where the pre-stretch layout put it, which reads as the
   * icon and label sitting low in the box. Opting the card out of the stretch
   * makes `aspectRatio` the only thing deciding its height, so `justifyContent`
   * centres against the height actually drawn.
   *
   * The label's spacing is `gap` on the card rather than `marginTop` on the Text,
   * so the gap belongs to the stack instead of hanging off one child.
   */
  action: {
    width: '47%',
    aspectRatio: 1.35,
    alignSelf: 'center',
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.sm,
  },
  // Centred so a label that wraps stays centred instead of going ragged-right.
  actionLabel: { textAlign: 'center' },
  closeWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    paddingHorizontal: space.lg,
  },
})
