# Design System

## Intro

**Frame & chrome:** iOS-style phone mock, 435×869, dark bezel (#05070d), 52px corner radius, pill notch, light status bar icons in #0e1c33. Screens live inside a rounded 42px inner frame.

**Type:** Plus Jakarta Sans (400–800) for all UI text. Headers run 22–34px bold/extrabold with tight letter-spacing; body/labels 13–16px, 500–700 weight; small caps-style eyebrow labels (e.g. "TODAY'S SHIFTS") use 11–12px, 800 weight, letter-spacing .06em, ~50% opacity ink.

**Components:** Cards are large-radius (18–26px) with soft colored shadows, not hard borders — subtle 1px tint borders instead. Buttons/pills are fully rounded (999px) or 16–22px squircle for primary/FAB. Status badges are pill-shaped with a small dot + colored text. Icons are minimal 1.7–2px stroke line icons (no fills except pins/badges), built inline as SVG strings swapped by color rather than icon fonts. Bottom nav has 4–5 icons; active state = white circular pill + drop shadow, inactive = translucent white icon on dark bar.

### Theme Mode

The app's color scheme honors a user-selected appearance (`light` / `dark` / `auto`) on top of the OS scheme. The preference is persisted to `AsyncStorage` and applied app-wide via `ThemeModeProvider` (wraps the tree in `app/_layout.tsx`). `useColorScheme()` already resolves the override, so `useGSTheme()` needs no changes.

Import: `import { useThemeMode } from '@/context/theme-mode';`

```tsx
import { ThemeMode } from '@taskmate/shared';

const { themeMode, setThemeMode } = useThemeMode();

// Apply + persist a new appearance (takes effect immediately, survives restarts)
setThemeMode(ThemeMode.DARK); // force dark
setThemeMode(ThemeMode.AUTO); // follow the OS
```

### Colors

Two files define the palette:

- `src/constants/gs-colors.ts` — GoShift brand tokens
- `src/constants/theme.ts` — spacing + font families + border radii

**Brand tokens (gs-colors.ts)**

| Token     | Value        | Meaning                 |
| --------- | ------------ | ----------------------- |
| `clay`    | `#1E5FD9`    | Primary blue            |
| `blue*`   | blue scale   | Various blue shades     |
| `ink`     | navy scale   | Dark text/UI            |
| `danger`  | red scale    | Errors                  |
| `success` | green scale  | Confirmations           |
| `info`    | blue scale   | Informational           |
| `warn`    | orange scale | Warnings                |
| `gold`    | yellow scale | Accents                 |
| `paper`   | light colors | Background light colors |

Each brand color may have shade variants (e.g., `50, 100, 200, 600, 700`).

### Typography

Plus Jakarta Sans, always addressed through `GSFont` (`src/constants/gs-fonts.ts`). Android does not synthesize weights, so `fontWeight` on its own renders regular — **set `fontFamily: GSFont.*` on every text style**, and keep the matching `fontWeight` so iOS stay consistent.

`ThemedText` (`src/components/themed-text.tsx`) covers generic body copy and accepts a `type` prop:
`default` | `title` | `small` | `smallBold` | `subtitle` | `link` | `linkPrimary` | `code`
Color is picked from the active theme automatically.

Screens built in the house style (see **Screen Anatomy**) use plain `<Text>` with explicit styles from `makeStyles(theme)` instead — the type scale there is deliberate (34 / 19 / 14 / 13) and does not map onto `ThemedText`'s presets. Both are correct; match whichever the surrounding screen already uses.

### Theme Hook

```ts
import { useTheme } from '@/hooks/use-theme';
const colors = useTheme(); // { text, background, tint, ... }
```

### Stylesheets

- Define StyleSheet objects using the `const StyleSheet` constant and should be placed at the bottom of the file.
- Use `ms()` to scale all measurements.

## Screen Anatomy (the house style)

`app/(app)/explore.tsx` and `app/(app)/settings.tsx` are the reference screens. **Copy their anatomy when building or redesigning any screen.** The look is: floating cards on a plain background, big extrabold headings, generous radii, soft colored shadows instead of borders.

### The rules

1. **No global chrome.** Root is a plain `<View style={{flex:1, backgroundColor: theme.background}}>`. No header bars, no card wrapping the whole screen.
2. **Cards float individually.** A list of things = a stack of separate cards with a 12px gap. Never a single grouped card with hairline dividers between rows — that reads dated.
3. **Every card row leads with a 56×56 icon tile.** Rounded square (`ms(18)` radius), `theme.iconTile` fill, its own drop shadow, accent-colored icon inside. This is the strongest signature of the style.
4. **Depth via shadow + tint, not borders.** `theme.cardTint` fill + 1px `theme.cardBorder` + `boxShadow: 0 18px 40px ${theme.cardShadow}`.
5. **Press feedback is `opacity: 0.7`.** Not a background swap, not a ripple.
6. **Always set `fontFamily` from `GSFont`.** Android does not synthesize weights — `fontWeight` alone renders regular. Keep the matching `fontWeight` too so iOS/web agree.

### Screen header

Sits above the content, padded `insets.top + ms(8)`. Big title + one quiet line of subtext. Optional round 44px action button (bell, filter) on the right.

```tsx
heading:    { fontFamily: GSFont.extrabold, fontSize: ms(34), letterSpacing: -0.7, lineHeight: ms(34), color: theme.textPrimary }
subheading: { fontFamily: GSFont.medium,    fontSize: ms(14), color: theme.textTertiary }
```

### The card row (the core unit)

Used for list items in Explore, menu items in Settings, and anything tappable that carries an icon + title + subtitle + trailing affordance.

```
┌──────────────────────────────────────────────┐
│  ┌────────┐                                  │
│  │ 56×56  │  Title              19px bold    │  ← Badge / chevron
│  │ icon   │  Subtitle           14px medium  │     / accept+decline
│  │ tile   │  meta line          13px semi    │
│  └────────┘                                  │
└──────────────────────────────────────────────┘
```

```tsx
card: {
  borderRadius: ms(26),
  backgroundColor: theme.cardTint,
  borderWidth: 1,
  borderColor: theme.cardBorder,
  boxShadow: `0 18px 40px ${theme.cardShadow}`,
} as any,          // `boxShadow` is not in RN's ViewStyle type yet — cast the block
row:      { flexDirection: 'row', alignItems: 'center', gap: ms(16), padding: ms(18) },
iconTile: {
  width: ms(56), height: ms(56), borderRadius: ms(18),
  backgroundColor: theme.iconTile,
  alignItems: 'center', justifyContent: 'center',
  boxShadow: `0 8px 18px ${theme.cardShadow}`,
} as any,
rowTitle:    { fontFamily: GSFont.bold,   fontSize: ms(19), letterSpacing: -0.2, color: theme.textPrimary },
rowSubtitle: { fontFamily: GSFont.medium, fontSize: ms(14), color: theme.textSecondary },
rowMeta:     { fontFamily: GSFont.semibold, fontSize: ms(13), color: theme.textTertiary },
pressed:     { opacity: 0.7 },
```

Trailing slot rules: a status `Badge` (with `dot`) when the row has state; a `chevron.right` when it navigates; inline circular action buttons (36px, `theme.accentMuted` / `theme.dangerSurface`) when the row is actionable in place.

### Section eyebrow

Groups get an uppercase micro-label, **not** a `SectionHeader` component and not a card title.

```tsx
eyebrow: { fontFamily: GSFont.extrabold, fontSize: ms(11.5), letterSpacing: 0.7, color: theme.textTertiary, paddingLeft: ms(4) }
```

### Filter chips (Explore)

Horizontal `ScrollView` of pills. Resting = `theme.chipSurface` + `theme.chipBorder`. Selected = `theme.accent` fill, no border, colored glow `boxShadow: 0 1px 5px ${theme.chipActiveShadow}`, label in `theme.textOnAccent`. Counts ride in a small pill inside the chip.

### Stat tiles

A row of small facts (Plan / Status / Renews). Flat `chipSurface` pills — **quieter than cards**, so they never compete with the tappable rows. `ms(18)` radius, uppercase 10.5px extrabold label above a 14px bold value.

### Destructive rows

Same card + row anatomy, but the icon tile is `theme.dangerSurface` and the label is `GS.danger`. It stays a full card — don't shrink it into a text link.

### Theme tokens for this style

`useGSTheme()` carries the tokens purpose-built for it. Prefer these over raw `GS.*` values:

| Token              | Use                                                   |
| ------------------ | ----------------------------------------------------- |
| `cardTint`         | Fill of a floating card (a step above `background`)   |
| `cardBorder`       | Hairline outline of that card                         |
| `cardShadow`       | Soft blue-cast shadow under cards and icon tiles      |
| `iconTile`         | Fill of the 56×56 leading icon tile                   |
| `chipSurface`      | Resting fill of pills, chips, stat tiles, search bars |
| `chipBorder`       | Hairline outline of a resting chip                    |
| `chipActiveShadow` | Glow cast by a selected accent chip                   |
| `accentMuted`      | Tinted fill for positive/neutral inline actions       |
| `dangerSurface`    | Tinted fill for destructive affordances               |
| `textOnAccent`     | Text/icon color sitting on an accent fill             |

### Screen skeleton

```tsx
<View style={styles.root}>                     {/* flex 1, theme.background */}
  <View style={[styles.header, { paddingTop: insets.top + ms(8) }]}>…</View>
  <ScrollView                                   {/* or FlatList for long lists */}
    contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + ms(96) }]}
    showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl … tintColor={theme.accent} />}
  >
    …cards…
  </ScrollView>
  <FabMenu />                                   {/* when the screen creates things */}
</View>
```

Horizontal padding is `ms(20)`. Bottom padding must clear the tab bar (`insets.bottom + ~ms(96)`). Long lists use `FlatList` with a `ms(12)` spacer as `ItemSeparatorComponent`, plus an end-of-list block (dashed "+" tile + a line of copy) rather than stopping abruptly.

## Shared Components

| Component                     | Purpose                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ThemedText`                  | Text with automatic light/dark color                                                                                                                                                                                                              |
| `ThemedView`                  | View with automatic light/dark background                                                                                                                                                                                                         |
| `AppTabs` / `AppTabs.android` | Bottom tab bar (platform variants)                                                                                                                                                                                                                |
| `AnimatedIcon` / `.android`   | Animated logo used in splash                                                                                                                                                                                                                      |
| `ExternalLink`                | Opens URL in system browser                                                                                                                                                                                                                       |
| `HintRow`                     | Displays a hint or code snippet                                                                                                                                                                                                                   |
| `SiteDropdown`                | Accordion picker for selecting a customer's site (with create-new affordance). Use whenever a screen needs to pick a `SiteOption` for a chosen customer — do not re-implement the inline site accordion.                                          |
| `CustomerDropdown`            | Accordion picker for searching and selecting a `CustomerOption` (with avatar rows, debounced search input, and create-new affordance). Use whenever a screen needs to pick a customer — do not re-implement the inline customer search/accordion. |

Platform-specific variants use the `.android.tsx` / `.ios.tsx` suffix; Expo Router picks the right file automatically.
Always check for new components in this folder and ensure they are used throughout the app. Don't create new components unless necessary.

## Responsiveness

- Always wrap root component in a scroll view for responsiveness
- Use `<ScrollView contentInsetAdjustmentBehavior="automatic" />` instead of `<SafeAreaView>` for smarter safe area insets
- `contentInsetAdjustmentBehavior="automatic"` should be applied to FlatList and SectionList as well
- Use flexbox instead of Dimensions API
- ALWAYS prefer `useWindowDimensions` over `Dimensions.get()` to measure screen size

## Behavior

- Use expo-haptics conditionally on iOS to make more delightful experiences
- Use views with built-in haptics like `<Switch />` from React Native and `@react-native-community/datetimepicker`
- When a route belongs to a Stack, its first child should almost always be a ScrollView with `contentInsetAdjustmentBehavior="automatic"` set
- When adding a `ScrollView` to the page it should almost always be the first component inside the route component
- For screens with input fields or forms, use `KeyboardAwareScrollView` (from `react-native-keyboard-aware-scroll-view`) instead of `ScrollView`. Ensure you set `enableOnAndroid={true}` and configure `extraScrollHeight` (e.g. `ms(120)`) to account for fixed bottom navigation or footer CTA buttons so the focused input is not overlapped by them.
- Prefer `headerSearchBarOptions` in Stack.Screen options to add a search bar
- Use the `<Text selectable />` prop on text containing data that could be copied
- Consider formatting large numbers like 1.4M or 38k
- Never use intrinsic elements like 'img' or 'div' unless in a webview or Expo DOM component
