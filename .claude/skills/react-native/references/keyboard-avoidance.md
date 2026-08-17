# Keyboard Handling (KAV Pattern)

When a screen requires keyboard avoidance (e.g., a bottom sheet form), use the **KAV Pattern** with Reanimated instead of the native `KeyboardAvoidingView`.

## Implementation Rules

1. **Shared Value**: Create a shared value for keyboard height: `const kbHeight = useSharedValue(0)`.
2. **Platform Listeners**: Use platform-specific listeners for the best feel:
   - **iOS**: `keyboardWillShow` / `keyboardWillHide` (feels more responsive).
   - **Android**: `keyboardDidShow` / `keyboardDidHide`.
3. **Smooth Timing**: Use `withTiming` with a duration of `250ms` to match the keyboard animation.
4. **Layout Structure**:
   - Wrap the content in an `Animated.View` with `flex: 1` and `justifyContent: 'flex-end'`.
   - Set `pointerEvents="box-none"` on this wrapper so it doesn't block background interactions.
   - Apply an animated style that sets `paddingBottom: kbHeight.value`.
5. **Inner Sheet**: The actual content (form/sheet) should be a standard `View` inside the animated wrapper.

## Code Template

```tsx
const kbHeight = useSharedValue(0);

useEffect(() => {
  const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
  const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

  const onShow = Keyboard.addListener(showEvent, (e) => {
    kbHeight.value = withTiming(e.endCoordinates.height, { duration: 250 });
  });
  const onHide = Keyboard.addListener(hideEvent, () => {
    kbHeight.value = withTiming(0, { duration: 250 });
  });

  return () => {
    onShow.remove();
    onHide.remove();
  };
}, []);

const kavStyle = useAnimatedStyle(() => ({
  paddingBottom: kbHeight.value,
}));

return (
  <View style={styles.root}>
    {/* Background Content */}
    <View style={styles.hero} />

    {/* KAV Wrapper */}
    <Animated.View style={[{ flex: 1, justifyContent: 'flex-end' }, kavStyle]} pointerEvents="box-none">
      <View style={styles.sheet}>
        {/* Form Content */}
      </View>
    </Animated.View>
  </View>
);
```

## Long Forms (KeyboardAwareScrollView)

Use this pattern where there are many input fields and it is not possible to use the KAV style:

- For screens with input fields or forms, use `KeyboardAwareScrollView` (from `react-native-keyboard-aware-scroll-view`) instead of `ScrollView`. Ensure you set `enableOnAndroid={true}` and configure `extraScrollHeight` (e.g. `ms(120)`) to account for fixed bottom navigation or footer CTA buttons so the focused input is not overlapped by them.
