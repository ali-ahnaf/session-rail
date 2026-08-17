# Icons (GSIcon)

All icons in `app-ui` must use the `GSIcon` component, which provides a unified interface for displaying platform-specific icons: SF Symbols on iOS and Ionicons on Android.

Never use `SymbolView` or `Ionicons` directly.

## Basic Usage

```tsx
import { GSIcon } from '@/components/ui/gs-icon';
import { PlatformColor } from 'react-native';

// Basic usage where the SF Symbol and Ionicon share the same name (or you're okay with the default mapping)
<GSIcon name="star" size={24} color={PlatformColor('label')} />;

// Providing a specific fallback for Android
<GSIcon name="square.and.arrow.down" ionicon="download-outline" size={24} color="#000000" />;
```

## Props

```tsx
<GSIcon
  name="star.fill" // SF Symbol name for iOS (required)
  ionicon="star" // Ionicon name for Android (optional, defaults to `name`)
  size={24} // Size for both width and height (default: 20)
  color="#000000" // Icon color (maps to tintColor on iOS, color on Android)
  weight="regular" // iOS only: thin | ultraLight | light | regular | medium | semibold | bold | heavy | black
  style={{ opacity: 0.8 }} // Standard style props
/>
```

## Platform Differences

`GSIcon` handles platform differences automatically:

- **iOS:** Uses `SymbolView` with `scaleAspectFit` and maps `color` to `tintColor`.
- **Android:** Uses `Ionicons` and maps `color` to `color`.

If an SF Symbol name does not exist as an Ionicon, you must provide the `ionicon` prop with a valid Ionicons name so it renders correctly on Android.

## Finding Symbol & Icon Names

- **iOS (SF Symbols):**
  1. Use the SF Symbols app on macOS (free from Apple).
  2. Search at https://developer.apple.com/sf-symbols/
  3. Symbol names use dot notation: `square.and.arrow.up`

- **Android (Ionicons):**
  1. Search at https://ionic.io/ionicons
  2. Usually kebab-case: `download-outline`, `star`, `star-half`

## Best Practices

- Always use `GSIcon` over generic vector icon libraries or direct imports.
- Match symbol weight to nearby text weight on iOS.
- Use `.fill` (iOS) or `-sharp`/without `-outline` (Android) variants for selected/active states.
- Use `PlatformColor` or theme colors for tint to support dark mode automatically.
- Keep icons at consistent sizes (16, 20, 24, 32).
