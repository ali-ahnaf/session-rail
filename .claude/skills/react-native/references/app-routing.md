# Routing Architecture

Expo Router uses the filesystem as the route tree. Route groups `(name)` create logical separation without affecting the URL.

### Auth Gate

`src/app/index.tsx` is the entry point. It reads `AuthContext` and redirects:

```
isAuthenticated === false  →  /(auth)/splash
isNewUser === true         →  /(onboarding)/profile
else                       →  /(app)
```

### Route Groups

#### `(auth)/` — Unauthenticated flow

| File         | Screen                   |
| ------------ | ------------------------ |
| `splash.tsx` | Welcome screen with logo |
| `phone.tsx`  | Phone number input       |
| `otp.tsx`    | 6-digit OTP verification |

Stack navigator, `slide_from_right` animation, no headers.

#### `(onboarding)/` — New-user wizard (6 steps)

| File               | Step                   |
| ------------------ | ---------------------- |
| `profile.tsx`      | Name & profile photo   |
| `employer.tsx`     | 6-char team code       |
| `role.tsx`         | Role selection (radio) |
| `permissions.tsx`  | OS permissions request |
| `availability.tsx` | Shift availability     |
| `tour.tsx`         | App tour / tutorial    |

Each screen shows a progress header with step count and a Skip button. Stack navigator, `slide_from_right`.

#### `(app)/` — Authenticated app

| File          | Tab     |
| ------------- | ------- |
| `index.tsx`   | Home    |
| `explore.tsx` | Explore |

Layout wraps content in `AnimatedSplashOverlay` (entry animation) + `AppTabs` (bottom tab bar via `NativeTabs` from Expo Router).

---

## Layout Files

Every route group has a `_layout.tsx` that wraps its screens.

| Layout                     | Responsibility                               |
| -------------------------- | -------------------------------------------- |
| `src/app/_layout.tsx`      | `ThemeProvider` + `AuthProvider`, root Stack |
| `(auth)/_layout.tsx`       | Stack with slide animation                   |
| `(onboarding)/_layout.tsx` | Stack with slide animation                   |
| `(app)/_layout.tsx`        | `AnimatedSplashOverlay` + `AppTabs`          |

---

## Auth Context

`src/context/auth.tsx` — wraps the entire app.

```ts
interface AuthContextType {
  isAuthenticated: boolean;
  isNewUser: boolean;
  phoneNumber: string;
  setPhoneNumber: (phone: string) => void;
  verifyOtp: (code: string) => boolean; // stub: checks length === 6
  completeOnboarding: () => void;
  logout: () => void;
}
```

Use `useAuth()` (exported hook) to read or update auth state in any screen.
