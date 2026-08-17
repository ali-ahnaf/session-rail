# Responsive sizing with `react-native-size-matters`

Use `react-native-size-matters` for any pixel-based dimension that should adapt to device size. The package is already a dependency of `app-ui`.

### Which helper to use

- `moderateScale(size, factor?)` — **default for font sizes**, padding, margins, border radius, and most spacing. Scales gently so text doesn't blow up on tablets. Default factor is `0.5`.
- `scale(size)` — width/horizontal dimensions that should scale linearly with screen width (e.g. card widths sized to screen).
- `verticalScale(size)` — heights that should scale linearly with screen height (e.g. hero blocks pegged to viewport).
- `moderateVerticalScale(size, factor?)` — heights that should adapt but not linearly.
- Use aliases instead of full name imports, ie `import { s, vs, ms, mvs } from 'react-native-size-matters';`

### Conventions for this repo

1. **All `fontSize` values must be wrapped in `moderateScale(...)`** — never hard-coded numbers. This keeps typography readable on small phones and tablets without overscaling.

   ```tsx
   import { moderateScale } from 'react-native-size-matters';

   const styles = StyleSheet.create({
     title: { fontSize: moderateScale(28), fontWeight: '500' },
     body: { fontSize: moderateScale(14), lineHeight: moderateScale(20) },
   });
   ```

2. **Inline `fontSize` props on `<Text>`** also use `moderateScale`:
   ```tsx
   <Text style={{ fontSize: moderateScale(16), color: '#fff' }}>G</Text>
   ```
3. **Icon glyph sizes** rendered as text (e.g. emoji, chevrons) should also use `moderateScale` so they track the surrounding text.
4. Prefer the **named imports** (`scale`, `verticalScale`, `moderateScale`) over the shorthand aliases (`s`, `vs`, `ms`) for readability.
5. When converting an existing style sheet, only wrap the **numeric pixel value** — leave string values, percentages, and `lineHeight` ratios alone unless they're also pixel-based.
6. Avoid `ScaledSheet` in this repo — stick with `StyleSheet.create` plus explicit `moderateScale(...)` calls so the scaling is visible at the call site.

### Use-case quick reference

| Use case                          | Helper                          |
| --------------------------------- | ------------------------------- |
| `fontSize` on body/heading/labels | `moderateScale(n)`              |
| Padding / margin / gap            | `moderateScale(n)`              |
| Border radius                     | `moderateScale(n)`              |
| Icon size prop (vector icons)     | `moderateScale(n)`              |
| Avatar / button square size       | `moderateScale(n)`              |
| Card width (screen-relative)      | `scale(n)`                      |
| Hero/banner height                | `verticalScale(n)`              |
| Modal max height                  | `moderateVerticalScale(n, 0.3)` |

### When _not_ to scale

- `lineHeight` expressed as a unitless multiplier (e.g. `lineHeight: 1.4`) — leave as-is.
- `letterSpacing` values below ~1 — scaling them creates uneven kerning.
- `borderWidth: 1` (hairlines) — leave at 1 to preserve crisp edges.
- Flex values, opacity, z-index, and any non-pixel numeric props.
