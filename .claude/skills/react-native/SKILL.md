---
name: react-native
description: react-native skill builds and updates the UI in `packages/app-ui` using this repo's module layout, shared DTOs, response envelope.
---

Use this skill whenever user asks to make changes in the `app-ui` or any react native related modules. This project is a react-native app that also contains Expo code and components.

Consult these resources as needed:

| File                                | Purpose                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `references/animations.md`          | Reanimated: entering, exiting, layout, scroll-driven, gestures                                           |
| `references/app-routing.md`         | App routing architecture, auth gate, route groups, auth context                                          |
| `references/controls.md`            | Reusable UI components                                                                                   |
| `references/design-system.md`       | Colors, spacing, typography, theme hook, stylesheets, responsiveness, behavior                           |
| `references/file-uploads.md`        | File uploads and attachments handling                                                                    |
| `references/form-sheet.md`          | Form sheets in `expo-router`: configuration, footers, background interaction                             |
| `references/gradients.md`           | CSS gradients via `experimental_backgroundImage` (New Architecture only)                                 |
| `references/icons.md`               | Use it whenever the work requires usage to icons                                                         |
| `references/keyboard-avoidance.md`  | Use the **KAV Pattern** with Reanimated instead of `KeyboardAvoidingView` for keyboard avoidance screens |
| `references/navigation-patterns.md` | Navigation, link, stack, context menus, bottom sheet modal, link previews, modal, sheet, components      |
| `references/responsive-sizing.md`   | Responsive sizing conventions with `react-native-size-matters`                                           |
| `references/route-structure.md`     | Route conventions, dynamic routes, groups, folder organization                                           |
| `references/storage.md`             | SQLite, `AsyncStorage`, `SecureStore`                                                                    |
| `references/styling-rules.md`       | Styling rules, text styling, shadows                                                                     |

## Important

- Always use the existing components from `@/components` when possible.
- Always use the GS color palette from `@/constants/gs-colors.ts`.
- Always use icons from `GSIcon` component.
- DO NOT IMPLEMENT ANY web components as we won't support web with react native. We have a seperate project for that.
- file structure: Always put `makeStyles()` at the bottom of the file. Add remaining components starting from the top. And the main component before `makeStyles()`.
- Never inline lambda functions in props. Always write an external function and wire it. For example:

  ```js
  // never do this
  onEdit={() => {
      setVisitDetailsOpen(false);
      setVisitSheetOpen(true);
  }}

  // always do this
  const onEdit = () => {
      setVisitDetailsOpen(false);
      setVisitSheetOpen(true);
  };

  onEdit={onEdit}
  ```

- **Component splitting via `_sections/`**: When a page grows beyond a single screen's worth of logic or JSX, split it into a co-located `_sections/` subfolder. Rules:
  - **Trigger**: Split when it contains multiple logical "tabs" or "sections" of the UI.
  - **Folder**: Create `_sections/` as a sibling of the page file (e.g. `quotes/_sections/` next to `quotes/new.tsx`).
  - **Tab components**: Each tab or major section becomes its own file: `primary-details-tab.tsx`, `quote-items-tab.tsx`. Name files in `kebab-case`, components in `PascalCase`.
  - **Custom hook**: Extract ALL form state, API calls, derived values, and handlers into a dedicated `use-<page>-form.ts` hook in `_sections/` (e.g. `use-quotes-form.ts`). The hook returns a single `form` object. Tab components receive `form` as a single prop (`form={form}`), never raw state or individual handlers.
  - **Main page file stays thin**: It only: imports the hook, renders the tab bar UI, conditionally renders tab components, and renders global sheets/modals (e.g. `CustomerAddSheet`, `SiteAddSheet`). No business logic or heavy JSX lives in the main file.
  - **Sheets and modals**: Any bottom-sheet, modal, or overlay that is triggered from multiple tabs stays in the main page file, not inside a tab. It reads its open-state and callbacks from the `form` object.
  - **`makeStyles`**: Always at the bottom of every file in the split (main page and each `_sections/` file).
  - **`RouteFallback` default export**: Expo Router scans **every** file under `src/app/` as a route, including co-located `_sections/` files, and logs `Route "..." is missing the required default export` for any without one. Every non-route file inside `src/app/` (all `_sections/` components, cards, sheets, pickers, etc.) MUST end with a no-op default export so Expo Router stops warning. Place it as the very last thing in the file, after `makeStyles`:

    ```tsx
    export default function RouteFallback() {
      return null;
    }
    ```

    Note: custom hook files like `use-<page>-form.ts` don't need it (`.ts`, not a route candidate). Only `.tsx`/`.jsx` files under `src/app/` trigger the warning.

## Library Preferences

- Never use modules removed from React Native such as Picker, WebView, SafeAreaView, or AsyncStorage
- Never use legacy expo-permissions
- `expo-audio` not `expo-av`
- `expo-video` not `expo-av`
- `expo-image` with `source="sf:name"` for SF Symbols, not `expo-symbols` or `@expo/vector-icons`
- `react-native-safe-area-context` not react-native SafeAreaView
- `process.env.EXPO_OS` not `Platform.OS`
- `React.use` not `React.useContext`
- `expo-image` Image component instead of intrinsic element `img`
- `expo-glass-effect` for liquid glass backdrops
