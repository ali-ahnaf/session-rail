# Styling

Follow Apple Human Interface Guidelines.

## General Styling Rules

- Prefer flex gap over margin and padding styles
- Prefer padding over margin where possible and use consistent padding/margin.
- For any components that are near the screen edge, use the padding from `app-ui/src/constants/theme.ts` `ScreenPadding` constant.
- Always account for safe area, either with stack headers, tabs, or ScrollView/FlatList `contentInsetAdjustmentBehavior="automatic"`
- Ensure both top and bottom safe area insets are accounted for
- Inline styles not StyleSheet.create unless reusing styles is faster
- Add entering and exiting animations for state changes
- Use `{ borderCurve: 'continuous' }` for rounded corners unless creating a capsule shape
- When padding a ScrollView, use `contentContainerStyle` padding and gap instead of padding on the ScrollView itself (reduces clipping)
- CSS and Tailwind are not supported - use inline styles
- use `fontWeight: '500'` and `fontFamily: GSFont.bold` for defining titles
- Rename modal components with Modal at the end, ie AppAlertModal

## Text Styling

- Add the `selectable` prop to every `<Text/>` element displaying important data or error messages
- For labels above text inputs or any form inputs, use the following style:

```js
fieldLabel: {
    fontFamily: GSFont.extrabold,
    color: theme.textTertiary,
    letterSpacing: ms(0.7),
    fontSize: ms(12.5),
    fontWeight: '500',
},
```

- all input fields should have the following:

```js
borderRadius: ms(18),
backgroundColor: theme.surface,
boxShadow: `0 6px 14px ${theme.cardShadow}`,

```

## Shadows

Use CSS `boxShadow` style prop. NEVER use legacy React Native shadow or elevation styles.

```tsx
<View style={{ boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' }} />
```

'inset' shadows are supported.
