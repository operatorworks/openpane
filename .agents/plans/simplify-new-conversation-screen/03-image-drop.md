# 03 — Image attach: "+" and drag and drop

## Goal

You can attach an image to a conversation by dropping it anywhere on the conversation panel. A compact "+" button stays in the composer as the keyboard path. The upload contract does not change.

## Evidence

- `ConversationView.tsx:124-133`: `image = view.image`, `acceptsImages`, `canSend`, and `imageAction`. `imageAction` clears `imageError`, then sets it from a rejection and keys it by store.
- `ConversationView.tsx:190-212`: the attachment UI.
  - The chip shows name and size, a status, Retry for failed or interrupted uploads, and Remove.
  - When the agent cannot take images, a notice says so.
  - The hidden `<input type="file" accept="image/png,image/jpeg" aria-label="Image file">` checks `IMAGE_MAX_BYTES` and then calls `active.store.selectImage({ name, bytes })`.
  - The button reads "Add image" or "Replace image". It is disabled when `!enabled`, when `storageFailure` is set, or while an upload is in progress.
- `tests/application/composer-image.browser.test.mjs:60-140` uses the label "Image file", the button names "Add image" and "Replace image", the region "Attached image", and the statuses "Ready" and "Retry".
- `tauri.conf.json:14` has no `dragDropEnabled` key, so the native handler is on. On macOS that handler consumes OS file drops. `main.rs:137` builds the window `from_config`.

## Changes

### New file: `apps/desktop/src/application/image-intake.ts`

This file holds two pure functions and has no React code.

- `dragVerdict(types: readonly string[], items: DataTransferItemList | null, blocked: string | null): 'ignore' | { kind: 'accept' } | { kind: 'reject'; reason: string }`

  The checks run in this order. The first match decides.

  | Condition | Result |
  |---|---|
  | `types` does not include `'Files'` | `ignore` (text drags are left alone) |
  | `blocked` is set | reject with the `blocked` reason |
  | more than one file item | reject: "Drop one image at a time." |
  | an item type that starts with `image/` and is not `image/png` or `image/jpeg` | reject: "Drop a PNG or JPEG image." |
  | anything else, including an empty type and `application/octet-stream` | accept. `intakeFile` decides on drop, so the filename-extension fallback still runs |

- `intakeFile(files: readonly File[]): { kind: 'file'; file: File } | { kind: 'reject'; reason: string }`

  It checks three things:
  - **Count.** Exactly one file.
  - **Type.** `file.type` must be `image/png` or `image/jpeg`. If `file.type` is empty, the name must end in `.png`, `.jpg` or `.jpeg`.
  - **Size.** At most `IMAGE_MAX_BYTES`, using the existing message "Choose an image of at most 4 MB."

  The host remains the authority on content.

### `ConversationView.tsx`

1. **One attach path.** Add `attach(files)`, which every attach goes through. The file input's `onChange` and the drop handler both call it. It runs these steps in order:
   1. Read the current `blocked` reason (below). If one is set, put it in `imageError` and stop.
   2. If a ref-held `intake` guard is already set, put "Wait for the current image to finish." in `imageError` and stop. The guard closes the gap between the start of `arrayBuffer()` and `view.image` switching to `uploading`.
   3. Run `intakeFile(files)`. If it rejects, put the reason in `imageError` and stop.
   4. Set the guard, then call `imageAction(async () => { …; await active.store.selectImage({ name, bytes: new Uint8Array(await file.arrayBuffer()) }); })`. Clear the guard in `finally`.

   The guard is keyed to the store, the same way `imageError` is. Removing the image while a read is pending makes the read result be ignored: compare a generation counter that Remove increments.
2. **Block reason** (proposed `blocked: string | null`). It mirrors the existing disabled conditions. The first match wins:

   | Condition | Reason |
   |---|---|
   | `!acceptsImages` | the agent's `imageInput.reason`, or "This agent cannot receive images." |
   | `storageFailure` | "Images can't be attached while drafts can't be saved." |
   | `!enabled` | "Connect to your host to attach an image." |
   | `image?.status === 'uploading'` | "Wait for the current upload to finish." |

3. **Drop zone.** Add `onDragEnter`, `onDragOver`, `onDragLeave` and `onDrop` to the `<section className="conversation-panel">`.
   - A depth counter in a ref tracks enter and leave. `drop` resets the counter and the state to idle. A `dragend` listener on `document` does the same, because `dragend` fires on the drag source, not on the panel.
   - In `onDrop`, copy `dataTransfer.files` into an array synchronously before any `await`.
   - All errors are written as `setImageError({ store: active.store, message })`, or thrown inside `imageAction`, which does the same.
   - For any file drag (not `ignore`), call `preventDefault` and set `dropEffect = 'copy'`, whatever the verdict. A `none` effect would stop browsers from firing `drop`, and the rejection would never be announced. The verdict only drives the outline colour and the hint.
   - On drop, call `attach([...dataTransfer.files])`. It re-decides from the real files and the current `blocked` state; it never reuses the hover verdict.
   - Store the local state as `drop: { kind: 'idle' } | { kind: 'over'; verdict }`.
4. **Composer feedback.**
   - Set `data-drop="accept"` or `data-drop="reject"` on `form.composer` while a drag is over the panel.
   - Show `<p className="composer-drop-hint" aria-hidden="true">` inside the composer. It reads "Drop to attach image", "Drop to replace {name}" when an image is already attached, or the reject reason.
   - Screen readers get nothing new during the drag. The outcome is announced by the existing status and alert.
   - **The alert is always reachable.** Render `{imageError?.store === active.store && <p role="alert">…</p>}` inside the composer, outside the `image || acceptsImages` gate (`ConversationView.tsx:190, 211`). Otherwise a drop on an agent that cannot receive images sets an error that never renders.
5. **"+" button.**
   - It is the first item in `.composer-footer`, before `composerControls`.
   - It renders only when `acceptsImages`.
   - Markup: `<button type="button" className="composer-setting composer-add" aria-label={image ? 'Replace image' : 'Add image'} title="Add image, or drop a PNG or JPEG" onClick={() => imageInput.current?.click()}>` with a plus SVG.
   - The input's `onChange` copies `files[0]`, sets `event.target.value = ''` (as today, so the same file can be chosen twice), then calls `attach([file])`.
   - Its disabled conditions are unchanged.
   - The hidden input keeps `aria-label="Image file"` and its `acceptsImages` gating.
   - Delete the old text button.
6. **Chip placement.**
   - The pending-image chip (`aria-label="Attached image"`) moves above the textarea, inside the composer.
   - The unsupported notice and the `imageError` alert stay directly under the chip.
   - The chip's content stays the same: name, size, status, Retry and Remove. Restyle Remove as an "×" icon button that keeps `aria-label="Remove"` and its existing visible text for screen readers.

   Implementation step: confirm the test queries `getByRole('button', { name: 'Remove' })`.

### `application.css`

- `.composer[data-drop="accept"]`: `outline: 2px dashed var(--aui-color-accent); outline-offset: 2px`.
- `[data-drop="reject"]`: the same, using `var(--aui-color-muted)`.
- `.composer-drop-hint`: a small muted line above the textarea, shown only while `data-drop` is set.
- `.composer-image`: a compact chip with radius 10px and a 12px font, laid out on one line.
- `.composer-add`: a transparent icon button, 28px, matching `.composer-setting`.
- Re-home the chip's button rule as `.conversation-panel .composer-image button` (small, transparent), so Retry and Remove keep compact styling. Then delete the unused `.composer-attachments` row styling.

### Window-level drop guard: `BrowserApplication.tsx`

Disabling Tauri's handler means a file dropped outside the panel (rail, sidebar, gutters) would make the webview navigate to the file.

- Add a `useEffect` in `BrowserApplication` that registers `dragover` and `drop` listeners on `window`.
- When `event.dataTransfer?.types` includes `'Files'` and `!event.defaultPrevented`, the listeners call `preventDefault()`. On `dragover` they also set `dropEffect = 'none'`. They never touch `data-drop`; only the panel sets the outline.
- The effect removes the listeners on cleanup.
- This changes no rail or sidebar markup or CSS. The panel handlers run first (bubbling) and mark the event handled.

### `apps/desktop/src-tauri/tauri.conf.json`

Add `"dragDropEnabled": false` to `app.windows[0]`. `main.rs` needs no change, because `WebviewWindowBuilder::from_config` reads this key.

## Drop states

| State | Trigger | Visual | Effect |
|---|---|---|---|
| Idle | none | none | none |
| Over, accept | One PNG/JPEG (or unknown type) and not blocked | A dashed accent outline on the composer, plus a hint | `dropEffect` is `copy` |
| Over, reject | A blocked reason, several files, or the wrong type | A dashed muted outline, plus the reason | `dropEffect` stays `copy` so `drop` fires; the drop sets the alert |
| Rejected after drop | Too large, or the wrong type that was unknown during the drag | The outline clears and `role="alert"` shows the reason | `selectImage` is not called; the draft and the existing image are unchanged |
| Uploading | `view.image.status === 'uploading'` | The chip shows "Uploading…" and "+" is disabled | New drags are rejected with "Wait for the current upload to finish." |
| Ready | `status === 'ready'` | The chip shows "Ready" and ×, and Send is enabled even with no text | Send works as before |
| Failed or interrupted | Upload error | The chip shows the reason and Retry, plus × | `retryImage` / `removeImage` work as before; a new drop replaces the image |

## Tests

Extend `tests/application/composer-image.browser.test.mjs`. In the page, build a `DataTransfer` with `new DataTransfer()` and `items.add(file)` through `page.evaluateHandle`. Then dispatch `dragenter`, `dragover` and `drop` on `.conversation-panel` with `{ bubbles: true, cancelable: true }`, because React listens at the root. Cover these cases:

- A valid PNG reaches "Ready". During `dragover`, `data-drop` is `accept`.
- A GIF gives `data-drop="reject"`. After the drop, the alert reads "Drop a PNG or JPEG image." and no chip appears.
- A file of 4 MB + 1 byte gives the alert "Choose an image of at most 4 MB."
- Two files give the alert "Drop one image at a time."
- A drop during an upload gives the alert "Wait for the current upload to finish." Before writing this case, find or add a hook in the test host that holds an upload in `uploading`, and name it in the test.
- A text drag (`text/plain` only) leaves `data-drop` unset.
- An agent without image input: a drop shows that agent's reason in an alert.
- Each rejection leaves the draft text and any existing chip unchanged.
- A `drop` dispatched on `.view-rail` has `defaultPrevented === true` and attaches nothing.

These tests should pass unchanged:

- the existing picker tests (`Image file`, "Add image", "Replace image");
- `content-layout-image.browser.test.mjs:67`;
- `selective-activity.browser.test.mjs:207`.

## Acceptance

1. Each of the six cases above passes in the browser build.
2. **This is a required completion gate.** In `npm run desktop:dev` on macOS:
   - dragging a PNG from Finder onto the transcript area attaches it;
   - dragging a GIF shows the rejection alert;
   - dropping a file on the sidebar or rail neither navigates nor attaches.

   If Finder drops do not reach the page, the work is not done. Record the evidence and reopen the plan to choose the native-path approach. The "+" picker does not satisfy this requirement.
3. Tab reaches "Add image", and Enter opens the file chooser.

## Exclusions

- No native path-based drop.
- No multiple pending images.
- No paste-from-clipboard (it could be a follow-up).
