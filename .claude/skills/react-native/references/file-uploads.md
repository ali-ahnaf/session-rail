# File Uploads & Attachments

## Rule For app-ui Attachment Inputs

When building or updating an attachment upload field in `packages/app-ui`, use the shared `AttachmentPicker` component. Do not create a screen-local camera picker, document picker, image preview list, or remove-row UI unless the existing component cannot support the workflow.

```tsx
import { AttachmentCategory } from '@taskmate/shared';
import { attachmentApi } from '@/api';
import { AttachmentPicker, type PendingAttachment } from '@/components/create/attachment-picker';
```

`AttachmentPicker` is a controlled component. The screen owns `PendingAttachment[]`; the picker handles:

- taking a photo with the camera
- selecting one or more images from the photo library
- selecting one or more documents
- permission prompts and permission-error toasts
- image thumbnails, document rows, file names, file sizes, and removal UI

```tsx
const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

<AttachmentPicker files={attachments} onChange={setAttachments} />;
```

## Upload Before Submit

The picker only collects local files. Before calling the create/update API for the business entity, upload new files with `attachmentApi.uploadFile()` and pass the returned S3 keys in the entity DTO.

```ts
const attachmentKeys = await Promise.all(
  attachments.map(async (file) => {
    if (file.key) return file.key;
    const uploaded = await attachmentApi.uploadFile(file, AttachmentCategory.Attachment);
    return uploaded.key;
  }),
);

const dto = {
  // other fields...
  attachments: attachmentKeys.length > 0 ? attachmentKeys : undefined,
};
```

Use the category expected by the backend for the entity. Generic entity attachments should use `AttachmentCategory.Attachment`; profile images or other specialized uploads may use a more specific `AttachmentCategory`.

## Edit Flows

For edit screens, convert existing server attachments to `PendingAttachment` and keep their `key`. Files with a `key` are already uploaded, so the submit handler should reuse the key instead of uploading them again.

```ts
const toPendingAttachment = (attachment: Attachment): PendingAttachment => ({
  uri: attachment.url || '',
  name: decodeURIComponent((attachment.key || attachment.url || '').split('/').pop() || 'Attachment'),
  type: 'application/octet-stream',
  key: attachment.key,
});

setAttachments(entity.attachments.map(toPendingAttachment));
```

If the API provides enough metadata, set a more specific `type` such as `image/jpeg` so `AttachmentPicker` can render an image thumbnail. If metadata is unavailable, `application/octet-stream` is acceptable and the picker will render a document row.

Use `onRemove` when removing an already-uploaded file should immediately delete it from storage:

```tsx
<AttachmentPicker
  files={attachments}
  onChange={setAttachments}
  onRemove={(file) => {
    if (file.key) {
      attachmentApi.deleteAttachment(file.key).catch((error) => {
        console.error('Failed to delete attachment', error);
      });
    }
  }}
/>;
```

Only call `deleteAttachment` immediately if that matches the screen's save semantics. If removals should apply only after the user submits the form, track removed keys separately and delete them after a successful update.
