# Form Sheets in Expo Router

This skill covers implementing form sheets with footers using Expo Router's Stack navigator and react-native-screens.

## Overview

Form sheets are modal presentations that appear as a card sliding up from the bottom of the screen. They're ideal for:

- Quick actions and confirmations
- Settings panels
- Login/signup flows
- Action sheets with custom content

**Requirements:**

- Expo Router Stack navigator

## Forms with Input Fields (FormShell)

**CRITICAL:** Whenever asked to design forms with input fields, you MUST use the `FormShell` component (`@/components/create/form-shell`).
`FormShell` provides a standardized, theme-aware layout that includes:

- A header with a back button and title
- A `KeyboardAwareScrollView` to handle keyboard interactions automatically
- A sticky footer with "Cancel" and dynamic primary submit buttons

### Usage with FormShell

```tsx
import React, { useState } from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { FormShell } from '@/components/create/form-shell';

export default function CreateItemSheet() {
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');

  const handleSubmit = async () => {
    setSubmitting(true);
    // ... submit logic ...
    setSubmitting(false);
  };

  return (
    <FormShell title="Create Item" submitLabel="Save" onSubmit={handleSubmit} submitting={submitting} disabled={!name.trim()}>
      <View style={styles.fieldContainer}>
        <TextInput value={name} onChangeText={setName} placeholder="Item Name" />
      </View>
    </FormShell>
  );
}

const styles = StyleSheet.create({
  fieldContainer: {
    // your field styles
  },
});
```
