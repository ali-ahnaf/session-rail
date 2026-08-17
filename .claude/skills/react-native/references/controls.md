# Controls And Reusable Components

This file documents the reusable control surface in `packages/app-ui/src/components`.
Prefer these components over one-off screen-local UI when building `app-ui`.

## Reusable Component Rules

- Import app components from `@/components/...`.
- Use `GSIcon` for icons so iOS gets SF Symbols and other platforms get Ionicons.
- Use `DateTimeField` for date and time input; do not use `@react-native-community/datetimepicker` directly in screens.
- Use `BottomSheetModal` for bottom-sheet flows that need app theming, gestures, safe-area padding, and toast support.
- Use `FormShell`, `Field`, `SelectField`, `JobItemsEditor`, and `TotalsCard` for create/edit screens that mirror `packages/ui`.
- Use the details helpers from `details-shell.tsx` for entity detail screens instead of recreating headers, hero cards, info rows, stats, and footer actions.

## Core UI Components

| Component          | Import                               | Purpose                                                                                                                                                                                                 |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`           | `@/components/ui/button`             | Clay primary pressable button. Accepts string children, custom children, `disabled`, `style`, and `textStyle`.                                                                                          |
| `IconButton`       | `@/components/ui/icon-button`        | A square, tappable icon tile with built-in press feedback. Defaults to a 44x44 bordered surface tile.                                                                                                   |
| `Card`             | `@/components/ui/card`               | Themed surface container with padding, gap, rounded corners, and shadow. `accent` exists in props but is not currently styled.                                                                          |
| `Badge`            | `@/components/ui/badge`              | Status pill with optional dot. Tones: `success`, `warn`, `danger`, `info`, `clay`, `gold`, `ink`.                                                                                                       |
| `Avatar`           | `@/components/ui/avatar`             | Initials avatar with configurable `size`, `color`, and optional `online` / `offline` status dot.                                                                                                        |
| `Chip`             | `@/components/ui/chip`               | Small selectable pill. Use for compact filters, tags, or option chips.                                                                                                                                  |
| `GSIcon`           | `@/components/ui/gs-icon`            | Cross-platform icon wrapper. Uses `expo-symbols` on iOS and `@expo/vector-icons/Ionicons` elsewhere. Pass both `name` and `ionicon` when possible.                                                      |
| `AppBar`           | `@/components/ui/app-bar`            | Absolute safe-area top bar with optional back button. Used by auth/onboarding-style screens.                                                                                                            |
| `BottomSheetModal` | `@/components/ui/bottom-sheet-modal` | Reanimated bottom sheet modal with backdrop close, pan-to-dismiss, safe-area padding, optional handle, and nested toast config.                                                                         |
| `DropdownMenu`     | `@/components/ui/dropdown-menu`      | Anchored modal dropdown. Measures trigger position and opens above or below based on available screen space.                                                                                            |
| `FabMenu`          | `@/components/ui/fab-menu`           | Floating create menu that links to new enquiry, quote, job, and invoice routes. Intended for the main app tab layout.                                                                                   |
| `PhoneInput`       | `@/components/ui/phone-input`        | Phone-number `TextInput` with digit limiting, US-style formatting by default, focus/invalid styling, and `phone-pad` keyboard.                                                                          |
| `Slider`           | `@/components/ui/slider`             | Themed controlled slider (gesture-handler + reanimated, no native module). Props: `value`, `onValueChange`, `minimumValue`, `maximumValue`, `step`. Use for numeric range input (e.g. geofence radius). |
| `Collapsible`      | `@/components/ui/collapsible`        | Simple expandable section with themed header, chevron, and fade-in body.                                                                                                                                |
| `AccordionSection` | `@/components/ui/accordion-section`  | Form-style expandable section with an animated chevron, bold title, and bordered card styling.                                                                                                          |
| `toastConfig`      | `@/components/ui/toast-config`       | `react-native-toast-message` config for success, error, and info toasts with app icons and dark toast styling.                                                                                          |
| `Banner`           | `@/components/ui/banner`             | Dismissible info banner with `title`, `description`, optional `badge`. Pass `storageKey` to persist dismissal across sessions.                                                                          |
| `CalendarCancelIcon` | `@/components/ui/calendar-cancel-icon` | Composite calendar-with-X icon. Props: `size`, `color`, `badgeColor`, `ringColor` (set to the background surface color so the badge knockout reads correctly).                                        |

## Form And Creation Components

| Component           | Import                                    | Purpose                                                                                                                                                                                  |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FormShell`         | `@/components/create/form-shell`          | Full-screen create/edit shell with safe-area header, keyboard-aware scroll body, cancel button, submit button, loading state, and disabled state.                                        |
| `Field`             | `@/components/create/form-field`          | Labeled text input with required marker, helper text, multiline support, theme colors, and standard spacing.                                                                             |
| `SelectField`       | `@/components/create/form-field`          | Labeled pressable select row with value/placeholder, required marker, helper text, and chevron. Pair with a picker component.                                                            |
| `SectionTitle`      | `@/components/create/form-field`          | Compact section heading for create/edit forms.                                                                                                                                           |
| `OptionsPicker`     | `@/components/create/options-picker`      | Generic bottom-sheet picker for `{ value, label, subtitle }` options with selected checkmark and empty state.                                                                            |
| `CustomerPicker`    | `@/components/create/customer-picker`     | Full-screen searchable customer picker. Loads customers through `customerApi.getCustomers` when visible and returns a `CustomerOption`.                                                  |
| `AssigneePicker`    | `@/components/create/assignee-picker`     | Full-screen searchable multi-select team-member picker. Loads active members through `userApi.getTeamMembers` and returns selected ids.                                                  |
| `AttachmentPicker`  | `@/components/create/attachment-picker`   | Attachment control for camera, photo library, and document picker. Maintains `PendingAttachment[]`, shows thumbnails/document rows, handles permissions, and supports removal callbacks. |
| `CustomerAddSheet`  | `@/components/create/customer-add-sheet`  | Bottom-sheet customer creation form. Uses shared `CreateCustomerRequest`, duplicate handling, country/phone-code selection, and returns a `CustomerOption`.                              |
| `SiteAddSheet`      | `@/components/create/site-add-sheet`      | Bottom-sheet service-site creation form for a selected customer. Uses shared `CreateSiteRequest` and returns a `SiteOption`.                                                             |
| `JobItemsEditor`    | `@/components/create/job-items-editor`    | Editable line-item list with add/remove rows, name, description, quantity, unit price, and computed row total.                                                                           |
| `makeEmptyItem`     | `@/components/create/job-items-editor`    | Helper that creates a new empty `LineItem` with a stable generated id.                                                                                                                   |
| `TotalsCard`        | `@/components/create/totals-card`         | Quote/job/invoice totals panel. Shows subtotal, editable discount, editable GST/tax percent, tax amount, and computed total.                                                             |
| `VisitDetailsSheet` | `@/components/create/visit-details-sheet` | Bottom-sheet visit summary with customer/contact context, status, quick call/directions/email actions, info/notes tabs, instructions, assignments, and services.                         |
| `VisitEditSheet`    | `@/components/create/visit-edit-sheet`    | Bottom-sheet create/edit visit workflow for enquiries. Handles date/time, assignees, status, product/service line items, confirmation email flag, and save callbacks.                    |
| `ServiceItemsEdit`  | `@/components/service-items-edit`         | Editable service line-item section: header, `LineItem[]` rows (change/remove callbacks), add button, and totals inputs (subtotal, discount, GST percent).                                |
| `ServiceItemsView`  | `@/components/service-items-view`         | Read-only service line-item summary with subtotal, discount, GST, and total.                                                                                                             |
| `MapLocationPicker` | `@/components/map-location-picker`        | Full-screen map modal for picking coordinates. Returns a `PickedLocation` via `onConfirm`; pass `geofenceRadius` + `onGeofenceRadiusChange` to show a radius circle overlay and slider.  |

## Dropdown Components

| Component          | Import                             | Purpose                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustomerDropdown` | `@/components/customer-dropdown`   | Inline accordion-style customer search/select control for forms. Parent owns loading, search, options, open state, selection, and create-new behavior.                                                                                                                                                                                                                     |
| `SiteDropdown`     | `@/components/site-dropdown`       | Inline accordion-style service-site selector for a selected customer. Parent owns loading, options, open state, selection, and create-new behavior.                                                                                                                                                                                                                        |
| `OptionsDropdown`  | `@/components/ui/options-dropdown` | Labeled select row (icon + selected label + chevron) that opens an `OptionsPicker` bottom sheet. Takes `options: Option[]`, `value`, `onChange`; optional `label`, `title`, `placeholder`, `icon`/`ionicon`, `emptyText`, `disabled`. Open state is internal unless `open`/`onOpenChange` are passed. Use this instead of hand-rolling a Pressable + `OptionsPicker` pair. |
| `SupplierDropdown` | `@/components/supplier-dropdown`   | Inline accordion-style supplier search/select control. Parent owns loading, search, options, open state, selection, and create-new behavior (mirrors `CustomerDropdown`).                                                                                                                                                                                                   |

## Details Components

All detail-page helpers are exported from `@/components/details/details-shell`.

| Component        | Purpose                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DetailsShell`   | Full detail-screen shell with safe-area header, back button, optional edit action, loading state, error/retry state, scroll content, and optional sticky footer. |
| `DetailsHero`    | Hero summary row with icon, title, optional subtitle, and optional status `Badge`.                                                                               |
| `DetailsSection` | Section block with uppercase heading, optional action, and card body.                                                                                            |
| `InfoRow`        | Label/value row with optional icon and monospace value styling. Empty values render as `-`.                                                                      |
| `StatTile`       | Small stat tile with label and value.                                                                                                                            |
| `StatRow`        | Horizontal wrapper for stat tiles.                                                                                                                               |
| `FooterAction`   | Footer button for detail actions. Variants: `primary`, `secondary`, `danger`; supports icon-only mode.                                                           |

## Navigation And App Shell Components

| Component               | Import                       | Purpose                                                                                                              |
| ----------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AppTabs`               | `@/components/app-tabs`      | Expo Router tab layout with custom floating tab bar and raised center home tab. Used by `src/app/(app)/_layout.tsx`. |
| `AnimatedSplashOverlay` | `@/components/animated-icon` | Reanimated splash overlay that hides itself after its entering animation completes.                                  |
| `ExternalLink`          | `@/components/external-link` | Expo Router `Link` wrapper that opens native links in an in-app browser outside web.                                 |
| `NotificationDrawer`    | `@/components/notification-drawer` | Slide-in notification panel. Props: `visible`, `notifications: NotificationDto[]`, `loading`, `unreadCount`, `onClose`, `onMarkAllRead`, `onMarkAsRead(id)`. Renders per-`NotificationType` icon tiles. |
| `SectionHeader`         | `@/components/section-header` | Uppercase mini section heading (extrabold, letter-spaced). Pass the heading text as children.                       |

## Themed And Scaffold Helpers

| Component    | Import                     | Purpose                                                                                                                               |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ThemedText` | `@/components/themed-text` | Theme-aware text primitive with variants: `default`, `title`, `small`, `smallBold`, `subtitle`, `link`, `linkPrimary`, `code`.        |
| `ThemedView` | `@/components/themed-view` | Theme-aware view primitive using a `ThemeColor` key for background color.                                                             |
| `HintRow`    | `@/components/hint-row`    | Small helper row for scaffold/tutorial-style content. Avoid in production workflows unless the screen intentionally needs a hint row. |
| `WebBadge`   | `@/components/web-badge`   | Expo web/version badge helper. Avoid for native-only production screens.                                                              |

## Native Controls

Native iOS controls provide built-in haptics, accessibility, and platform-appropriate styling.

## Switch

Use for binary on/off settings. Has built-in haptics.

```tsx
import { Switch } from 'react-native';
import { useState } from 'react';

const [enabled, setEnabled] = useState(false);

<Switch value={enabled} onValueChange={setEnabled} />;
```

### Customization

```tsx
<Switch value={enabled} onValueChange={setEnabled} trackColor={{ false: '#767577', true: '#81b0ff' }} thumbColor={enabled ? '#f5dd4b' : '#f4f3f4'} ios_backgroundColor="#3e3e3e" />
```

## Segmented Control

Use for non-navigational tabs or mode selection. Avoid changing default colors.

```tsx
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { useState } from 'react';

const [index, setIndex] = useState(0);

<SegmentedControl values={['All', 'Active', 'Done']} selectedIndex={index} onChange={({ nativeEvent }) => setIndex(nativeEvent.selectedSegmentIndex)} />;
```

### Rules

- Maximum 4 options — use a picker for more
- Keep labels short (1-2 words)
- Avoid custom colors — native styling adapts to dark mode

### With Icons (iOS 14+)

```tsx
<SegmentedControl
  values={[
    { label: 'List', icon: 'list.bullet' },
    { label: 'Grid', icon: 'square.grid.2x2' },
  ]}
  selectedIndex={index}
  onChange={({ nativeEvent }) => setIndex(nativeEvent.selectedSegmentIndex)}
/>
```

## Slider

Continuous value selection.

```tsx
import Slider from '@react-native-community/slider';
import { useState } from 'react';

const [value, setValue] = useState(0.5);

<Slider value={value} onValueChange={setValue} minimumValue={0} maximumValue={1} />;
```

### Customization

```tsx
<Slider value={value} onValueChange={setValue} minimumValue={0} maximumValue={100} step={1} minimumTrackTintColor="#007AFF" maximumTrackTintColor="#E5E5EA" thumbTintColor="#007AFF" />
```

### Discrete Steps

```tsx
<Slider value={value} onValueChange={setValue} minimumValue={0} maximumValue={10} step={1} />
```

## Date/Time Picker

**IMPORTANT**: Always use the custom `DateTimeField` component for date and time input fields. It provides a unified cross-platform experience, handling Android dialogs and iOS bottom sheet spinners automatically, while applying the app's standard theming.

Do not use `@react-native-community/datetimepicker` directly in your forms or screens.

```tsx
import { DateTimeField } from "@/components/ui/date-time-field";
import { useState } from "react";

// The component accepts Date | null
const [date, setDate] = useState<Date | null>(new Date());
const [time, setTime] = useState<Date | null>(null);

// Date mode
<DateTimeField
  value={date}
  onChange={setDate}
  mode="date"
  placeholder="Select date"
/>

// Time mode
<DateTimeField
  value={time}
  onChange={setTime}
  mode="time"
  placeholder="Pick time"
  disabled={false}
/>
```

### Min/Max Dates

```tsx
<DateTimeField
  value={date}
  onChange={setDate}
  mode="date"
  minimumDate={new Date()} // Prevents selecting past dates
/>
```

## Stepper

Increment/decrement numeric values.

```tsx
import { Stepper } from 'react-native';
import { useState } from 'react';

const [count, setCount] = useState(0);

<Stepper value={count} onValueChange={setCount} minimumValue={0} maximumValue={10} />;
```

## Typography

Plus Jakarta Sans is the app typeface, loaded once in `src/app/_layout.tsx`. Android does not
synthesise weights, so each weight is a separate family — always set `fontFamily` from `GSFont`
(`@/constants/gs-fonts`) alongside the matching `fontWeight`. Never hardcode a family name or
rely on `fontWeight` alone.

| `GSFont` key | Weight | Use for                             |
| ------------ | ------ | ----------------------------------- |
| `regular`    | 400    | Body copy                           |
| `medium`     | 500    | Subtitles, secondary text, inputs   |
| `semibold`   | 600    | Meta lines, captions                |
| `bold`       | 700    | Card titles, chips, buttons, badges |
| `extrabold`  | 800    | Screen headings, counters           |

```tsx
import { GSFont } from '@/constants/gs-fonts';

title: { fontFamily: GSFont.bold, fontWeight: '500', fontSize: ms(19) },
```

## TextInput

Native text input with various keyboard types.

```tsx
import { TextInput } from 'react-native';

<TextInput
  placeholder="Enter text..."
  placeholderTextColor="#999"
  style={{
    padding: 12,
    fontSize: 16,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  }}
/>;
```

### Keyboard Types

```tsx
// Email
<TextInput keyboardType="email-address" autoCapitalize="none" />

// Phone
<TextInput keyboardType="phone-pad" />

// Number
<TextInput keyboardType="numeric" />

// Password
<TextInput secureTextEntry />

// Search
<TextInput
  returnKeyType="search"
  enablesReturnKeyAutomatically
/>
```

### Multiline

```tsx
<TextInput multiline numberOfLines={4} textAlignVertical="top" style={{ minHeight: 100 }} />
```

## OtpInput

Segmented one-time-code input. Renders `length` boxes driven by a hidden `TextInput`, with a blinking cursor on the active box and error/success border states. Controlled via `value`/`onChangeText` (digits only).

```tsx
import { OtpInput, type OtpState } from '@/components/ui/otp-input';

const [code, setCode] = useState('');
const [state, setState] = useState<OtpState>('idle');

<OtpInput value={code} onChangeText={setCode} length={6} state={state} autoFocus onSubmitEditing={handleVerify} />;
```

Props: `value` / `onChangeText` (required); `length` (default `6`); `state` (`'idle' | 'error' | 'success'`, default `'idle'`); `autoFocus`; `onSubmitEditing`. Use for phone/email OTP verification flows (e.g. the inline code step in `SignInForm`).

## Picker (Wheel)

For selection from many options (5+ items).

```tsx
import { Picker } from '@react-native-picker/picker';
import { useState } from 'react';

const [selected, setSelected] = useState('js');

<Picker selectedValue={selected} onValueChange={setSelected}>
  <Picker.Item label="JavaScript" value="js" />
  <Picker.Item label="TypeScript" value="ts" />
  <Picker.Item label="Python" value="py" />
  <Picker.Item label="Go" value="go" />
</Picker>;
```

## Toolbar

Every screen in `packages/app-ui` should use the shared `Toolbar` for its top header instead of hand-rolling a back button + title row. It handles the safe-area inset, back navigation, title, and the right-side slot consistently.

Import: `import { Toolbar } from '@/components/ui/toolbar';`

```tsx
// Plain header (back chevron + title, empty right slot)
<Toolbar title="Catalog" />

// Edit action on the right (pencil button)
<Toolbar title="Job #1024" onEdit={handleEdit} />

// Overflow (•••) menu — takes precedence over onEdit
<Toolbar
  title="Quote"
  menuActions={[
    { label: 'Duplicate', icon: 'doc.on.doc', ionicon: 'copy-outline', onPress: duplicate },
    { label: 'Delete', ionicon: 'trash-outline', destructive: true, onPress: remove },
  ]}
/>

// Custom right-side content (e.g. an add button) — takes precedence over menuActions/onEdit
<Toolbar
  title="Procurements"
  right={
    <Pressable onPress={handleNew} style={styles.newBtn}>
      <GSIcon name="plus" ionicon="add" size={ms(20)} color={GS.white} />
    </Pressable>
  }
/>
```

Props: `title` (required); `showBack` / `onBack` to toggle or override back navigation (defaults to `router.back()`); `onEdit`, `menuActions`, and `right` for the right slot (precedence: `right` > `menuActions` > `onEdit`).

`DetailsShell` and `PlaceholderScreen` already render `Toolbar` internally — pass `title`/`onEdit`/`menuActions` through them rather than adding a second header.

## ShiftDetailsSheet

Read-only bottom sheet showing one shift's timing, quick facts (break / recurring / manual clock), assigned workers, and notes. Built on `BottomSheetModal`. Open it by holding the selected `ShiftDto` in state; pass `null` to keep it closed.

```tsx
const [selectedShift, setSelectedShift] = useState<ShiftDto | null>(null);

// tapping a shift card
<Pressable onPress={() => setSelectedShift(shift)}>...</Pressable>

<ShiftDetailsSheet visible={!!selectedShift} onClose={() => setSelectedShift(null)} shift={selectedShift} />
```

Props: `visible` (required), `onClose` (required), `shift?: ShiftDto | null`, `onEdit?: () => void`. Display-only — the optional `onEdit` renders an "Edit" pill in the header that hands off to `ShiftDetailsEditSheet`.

## ShiftDetailsEditSheet

Editable bottom sheet for a SINGLE shift (title, date, start/end time, type, status, assignees, break, notes, manual clock). Built on `BottomSheetModal`; seeds its form from the `shift` prop each time it opens and PATCHes via `jobApiV2.updateShift(id, dto)` (`POST /api/jobs/shift/update`) — only that shift changes, siblings are untouched. Pair it with `ShiftDetailsSheet`: on Edit, close the details sheet, then open this one on the next tick so the two modals never overlap.

```tsx
const [selectedShift, setSelectedShift] = useState<ShiftDto | null>(null);
const [editShift, setEditShift] = useState<ShiftDto | null>(null);

const handleEditShift = () => {
  const shift = selectedShift;
  setSelectedShift(null);
  setTimeout(() => setEditShift(shift), 0);
};

<ShiftDetailsSheet visible={!!selectedShift} onClose={closeShiftDetails} shift={selectedShift} onEdit={handleEditShift} />
<ShiftDetailsEditSheet visible={!!editShift} onClose={closeShiftEdit} shift={editShift} onSaved={handleShiftSaved} />
```

Props: `visible` (required), `onClose` (required), `shift?: ShiftDto | null`, `onSaved?: () => void` (fired after a successful save — reload the job there).

## ShiftDeclineSheet

Bottom sheet that collects the **mandatory** reason before a user declines a shift invite. Built on `BottomSheetModal`; the submit button stays disabled until the reason is non-empty (trimmed, max 500 chars) and the sheet resets its input each time it opens. It does not call the API itself — the parent owns the request (`jobApiV2.respondToShiftInvite`) and the busy state.

```tsx
const [declineRow, setDeclineRow] = useState<ListRow | null>(null);

<ShiftDeclineSheet
  visible={!!declineRow}
  shiftTitle={declineRow?.title}
  submitting={respondingId === declineRow?.shift?.assignment.id}
  onClose={() => setDeclineRow(null)}
  onSubmit={(reason) => respond(declineRow!, ShiftAssignmentStatus.DECLINED, reason)}
/>;
```

Props: `visible` (required), `onClose` (required), `onSubmit: (reason: string) => void` (required — always receives a trimmed, non-empty reason), `shiftTitle?: string`, `submitting?: boolean`.

## Best Practices

- **Haptics**: Switch and DateTimePicker have built-in haptics — don't add extra
- **Accessibility**: Native controls have proper accessibility labels by default
- **Dark Mode**: Avoid custom colors — native styling adapts automatically
- **Spacing**: Use consistent padding around controls (12-16pt)
- **Labels**: Place labels above or to the left of controls
- **Grouping**: Group related controls in sections with headers
