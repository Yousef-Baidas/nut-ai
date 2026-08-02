import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/ThemeProvider'
import { MIN_TAP_TARGET, space, type } from '../theme/tokens'

/**
 * A Done bar that sits above the keyboard.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE: iOS numeric keyboards — `numeric`,
 * `number-pad`, `decimal-pad` — have no return key. Not a return key that does
 * nothing: no key at all. `returnKeyType="done"` on such a field is silently
 * ignored, which is worse than omitting it, because the code reads as though
 * dismissal were handled. `multiline` fields have the mirror problem: they do
 * have a return key, and it inserts a newline.
 *
 * On either kind of field the only remaining dismissal gesture is a downward
 * swipe — which on a `presentation: 'modal'` screen is also the gesture that
 * tears the screen down, taking any unsaved work with it. That collision is not
 * something a user can be taught around; the keyboard has to grow an exit.
 *
 * Attach with `inputAccessoryViewID={DONE_ACCESSORY_ID}` on the TextInput and
 * render one `<KeyboardDoneBar />` somewhere in the same screen. iOS only —
 * `InputAccessoryView` has no Android implementation, and Android's system back
 * button already dismisses the keyboard without destroying the screen.
 */

export const DONE_ACCESSORY_ID = 'nutai-keyboard-done'

export function KeyboardDoneBar() {
  const theme = useTheme()
  if (Platform.OS !== 'ios') return null

  return (
    <InputAccessoryView nativeID={DONE_ACCESSORY_ID}>
      <View style={[styles.bar, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss keyboard"
          onPress={() => Keyboard.dismiss()}
          hitSlop={space.sm}
          style={styles.done}
        >
          <Text style={[type.bodyStrong, { color: theme.text }]}>Done</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  done: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
})
