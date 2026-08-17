# Storage

## Key-Value Storage

Use the localStorage polyfill for key-value storage. **Never use AsyncStorage**

```tsx
import 'expo-sqlite/localStorage/install';

// Simple get/set
localStorage.setItem('key', 'value');
localStorage.getItem('key');

// Store objects as JSON
localStorage.setItem('user', JSON.stringify({ name: 'John', id: 1 }));
const user = JSON.parse(localStorage.getItem('user') ?? '{}');
```

## When to Use What

| Use Case                                             | Solution                |
| ---------------------------------------------------- | ----------------------- |
| Simple key-value (settings, preferences, small data) | `localStorage` polyfill |
| Sensitive data (tokens, passwords)                   | `expo-secure-store`     |

## React Hook for Storage

```tsx
// hooks/use-storage.ts
import { useSyncExternalStore } from 'react';
import { storage } from '@/utils/storage';

export function useStorage<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    (cb) => storage.subscribe(key, cb),
    () => storage.get(key, defaultValue),
  );

  return [value, (newValue: T) => storage.set(key, newValue)];
}
```

Usage:

```tsx
function Settings() {
  const [theme, setTheme] = useStorage('theme', 'light');

  return <Switch value={theme === 'dark'} onValueChange={(dark) => setTheme(dark ? 'dark' : 'light')} />;
}
```
