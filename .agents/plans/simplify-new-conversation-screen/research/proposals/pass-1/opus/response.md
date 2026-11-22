# Simplify the new-conversation screen: proposal

## Central idea

Make the conversation panel only a transcript and a composer. Everything else follows one of three rules:

1. **Shown only when actionable.** Permissions, tool failures, observation notices and decisions render only when there is something to do.
2. **Folded into a compact composer control.** Attach image becomes a "+" icon plus drag-and-drop. Custom tools become a "Tools" chip that opens a popover, and only exists when tools exist.
3. **Moved to the one ambient strip that already exists.** The agent disclosure goes to the shell footer, replacing the build label it duplicates.

When the conversation has no messages, CSS centres a greeting and the composer. Once a message exists, the same composer DOM node pins to the bottom. The textarea is never remounted, so focus, caret and draft are preserved.

## Ownership of data and state

| State | Owner | Change |
|---|---|---|
| Draft text, pending image (`view.image`: uploading, ready, failed, interrupted) | `active.store` (client store) | none |
| Intake errors (wrong type, too big, several files, blocked) | `ConversationView` `imageError` (already keyed by store) | reused for drop errors |
| Drag-over state (`idle` or `over` with a verdict) | new `useImageDrop` hook, local and ephemeral | new |
| Tools popover open/closed | new `ComposerTools`, local | new |
| Whether tools exist | `BrowserApplication`, derived from `custom.namespaces` | new derived value |
| Whether permissions are visible | pure predicate on `PermissionState` | new derived value |
| Text and authority for tool configuration, enablement and failure | Extensions view (row states) and View options › Restore default view | unchanged |

## Types, interfaces and module boundaries

### New file: `apps/desktop/src/application/image-intake.ts`

```ts
export const IMAGE_TYPES = ['image/png', 'image/jpeg'] as const;
export type DropVerdict = { readonly kind: 'accept' } | { readonly kind: 'reject'; readonly reason: string };

/** During dragover: only item kinds and types are readable, not sizes. */
export function dragVerdict(items: DataTransferItemList, blocked: string | null): DropVerdict;
// Rules: not a file drag → treated as "not ours" (no overlay); blocked → reject(blocked);
// more than one file → 'Drop one image at a time.'; type not in IMAGE_TYPES → 'Drop a PNG or JPEG image.'

/** On drop or file-input change: full check including size. */
export function intakeFile(files: FileList | readonly File[]): { readonly kind: 'file'; readonly file: File } | DropVerdict & { kind: 'reject' };
// Size check reuses the existing copy: 'Choose an image of at most 4 MB.' (IMAGE_MAX_BYTES)
```

This client-side type check is for the user's benefit only. I am assuming the store or host stays the authority on content. The picker path also goes through `intakeFile`, because the macOS file dialog can bypass `accept`.

### New file: `apps/desktop/src/application/ComposerImageDrop.tsx`

```ts
export type DropState = { readonly kind: 'idle' } | { readonly kind: 'over'; readonly verdict: DropVerdict };
export function useImageDrop(options: {
  readonly blocked: string | null;            // computed by ConversationView, see below
  readonly onFile: (file: File) => void;      // → ConversationView.attach
  readonly onReject: (reason: string) => void;// → setImageError({ store, message })
}): { readonly state: DropState; readonly handlers: Pick<DOMAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'> };
export function ComposerImageChip(props: { image; enabled; storageFailure; onRetry; onRemove }): JSX.Element;
```

How the hook works:

- **Ignoring non-file drags.** It only reacts when `dataTransfer.types` includes `'Files'`, so dragging text selections does nothing.
- **Tracking enter and leave.** It counts depth: `dragenter` adds one, `dragleave` subtracts one, and `drop` or `dragend` resets to zero. This avoids relying on `relatedTarget`, which WebKit fills unreliably during drags.
- **Cursor feedback.** It always calls `preventDefault` on file drags over the panel. It sets `dropEffect` to `'copy'` for accept and `'none'` for reject.

### New file: `apps/desktop/src/application/ComposerTools.tsx`

```ts
export function ComposerTools({ children, enabled }: { readonly children: ReactNode; readonly enabled: boolean }): JSX.Element;
```

- **Trigger.** A chip button labelled "Tools" with a wrench icon, `aria-haspopup="dialog"` and `aria-expanded`.
- **Popover.** `role="dialog"`, `aria-label="Custom tools"`, styled like `.composer-picker`. It follows the same focus, Escape, outside-pointer and focus-restore pattern as `ComposerAgentControls.tsx:66-85`.
- **Always mounted.** The popover content stays mounted and uses `hidden` when closed. This means a pending `ConversationModuleAction` keeps its status across close and reopen, and the `CustomizationBoundary` keys do not remount the extension's components.

### Changed: `ConversationView` props

Two optional props are added; the rest are unchanged:

```ts
readonly hasTools?: boolean;          // default false
readonly notices?: ReactNode;         // customization failure alerts
```

Routing of `modules`:

- When `contentLayout.kind === 'claimed'`, `modules` goes to `CustomizationContent` as today. The extension's `ConversationContentLayoutProps.modules` contract is honoured and there is no Tools chip.
- Otherwise `CustomizationContent` receives `modules={null}`, and `modules` renders inside `<ComposerTools>` when `hasTools` is true.

`CustomizationContent.tsx` needs no change, because its default and conflict fallback is already `transcript + modules`.

### Changed: `CustomizationModules.tsx`

- `ConversationModules` returns `null` when `modules.length === 0`. This alone removes the two empty "Custom tools" fieldsets for crew and coworkers.
- The legend becomes visually hidden inside the popover.
- The failed alert is split out:

```ts
export function CustomizationFailure({ owner }: { readonly owner: Extract<NamespaceActivation, { kind: 'failed' }> }): JSX.Element;
// renders the existing text verbatim: <p role="alert">Custom tools could not load. {message} Use Restore default view to continue without them.</p>
```

### Changed: `ConversationPermissions.tsx`

```ts
export function permissionsShown(state: PermissionState): boolean;
// false when state.kind === 'unsupported' (ASSUMPTION, see uncertainties)
// false when state.kind === 'loading' and there is no listing (avoids a flash before support is known)
// true otherwise
```

The component's markup, roles and texts are unchanged. It is only restyled more compactly and moved in the DOM (see below).

### Changed: `ComposerAgentControls.tsx`

Delete the effort button (line 97). The harness and model chips and the picker are unchanged.

## Control and data flow

```
BrowserApplication
  custom.namespaces ──┬─ ready & modules.length>0 ─→ hasTools
                      ├─ all → modules (CustomizationModules; ready-empty renders null)
                      └─ failed → notices (CustomizationFailure)
  footer buildLabel ← selectedView==='chats' ? presentation.footer : presentation.buildLabel
        │
        ▼
ConversationView  (section.conversation-panel, data-empty, …drop handlers)
  hidden header (h1 "Your conversation", agent label)
  existing status/observation notices
  {empty && greeting}
  CustomizationContent(modules = claimed ? modules : null)
  decision cards
  {notices}
  {permissionsShown && ConversationPermissions}
  form.composer[data-drop]
     ComposerImageChip (view.image) + imageError alert
     textarea (auto-grow, no resize)
     footer: [+][Tools?]  ………  [Harness⌄][Model⌄] [Stop?][↑ Send]
  CommandRecovery
```

Image intake has a single path: `attach(file)` calls `imageAction(async () => { const r = intakeFile([file]); if (r.kind==='reject') throw new Error(r.reason); await active.store.selectImage({ name, bytes }) })`. The file input's `onChange` and the panel's `onDrop` both call it. `retryImage` and `removeImage` are unchanged.

The `blocked` reason passed to the drop hook is computed in this order:

1. `!acceptsImages` → the agent's unsupported reason, or "This agent cannot receive images."
2. `storageFailure` → "Images can't be attached while drafts can't be saved."
3. `!enabled` → "Connect to your host to attach an image."
4. `image?.status === 'uploading'` → "Wait for the current upload to finish."

This mirrors the existing disabled conditions on the Add image button.

Empty mode is defined as: `messages.length === 0 && !continuation && no decisions && transcript.kind !== 'claimed' && contentLayout.kind !== 'claimed'`. Its only effect is `data-empty="true"` on the panel plus the greeting element.

## Wireframes

### (a1) Empty new conversation (Codex)

```
┌rail┬ Chats (unchanged) ┬──────────────────────────────────────────────────┐
│    │                   │                                                  │
│    │                   │                                                  │
│    │                   │                       ( a )                      │
│    │                   │          A conversation that stays with you.     │
│    │                   │                                                  │
│    │                   │  ╭────────────────────────────────────────────╮  │
│    │                   │  │ Write to Codex…▍                           │  │
│    │                   │  │                                            │  │
│    │                   │  │ (+)               Codex ⌄  GPT-6.2 Sol ⌄ (↑)│  │
│    │                   │  ╰────────────────────────────────────────────╯  │
│    │                   │                                                  │
│    │                   │                                                  │
│    │                   │ ● Conversation connected   Local Codex · Approvals required for changes │
└────┴───────────────────┴──────────────────────────────────────────────────┘
```

The empty workspace in `BrowserApplication.tsx:72-77` uses the same frame:

- The eyebrow is removed and the h1 stays.
- The explanatory paragraph shows only when the host is not ready or no agents exist.
- The rounded box holds the muted line "Choose a harness to start." and the chips. There is no fake textarea, because creation still happens through choosing a harness.

### (a2) Active conversation with one pending image

```
│  [visually hidden h1: Your conversation · GPT-6.2 Sol]                  │
│                                        ╭──────────────────────────╮    │
│                                        │ Fix the chart axis labels │    │
│                                        ╰──────────────────────────╯    │
│  Codex                                                                  │
│  I updated the x-axis labels in chart.ts …                              │
│                                                                         │
│  ╭───────────────────────────────────────────────────────────────╮     │
│  │ ╭─────────────────────────────────╮                            │     │
│  │ │ ▣ chart.png · 70 B · Ready    × │   ← aria-label "Attached image"│
│  │ ╰─────────────────────────────────╯                            │     │
│  │ Now label the y axis too▍                                      │     │
│  │ (+)                         Codex ⌄  GPT-6.2 Sol ⌄        (↑)  │     │
│  ╰───────────────────────────────────────────────────────────────╯     │
│ ● Conversation connected        Local Codex · Approvals required for changes │
```

In this state the "+" button's accessible name is "Replace image". The "×" button keeps the accessible name "Remove".

## (b) Where each element goes

| Element | Destination |
|---|---|
| Header (h1 "Your conversation", agent label) | Visually hidden, so the heading structure and screen-reader context stay. The model chip already shows the agent. The bottom border is removed. |
| Permissions card | Hidden when the provider reports `unsupported` (Codex, Claude, Pi), or while loading with no listing. When the provider reports permissions (Crew), it renders in compact form directly above the composer, with the same `region "Permissions"`, buttons and texts. |
| "Send a message to begin." | Replaced by the greeting in empty mode. The recorded-demo nuance is carried by the footer disclosure ("Recorded playback · No live model"). |
| Custom tools fieldsets | Empty namespaces render nothing. Non-empty namespaces appear behind a "Tools" composer chip, shown only when a ready namespace contributes modules and no layout is claimed. Claimed layouts still receive `modules`. Load failures appear as one inline alert above the composer (exceptional and actionable). Configuration status stays in the Extensions view rows. "Loading custom tools…" appears only inside the popover. |
| Add image | Becomes a "+" icon button (`aria-label` "Add image" or "Replace image", with `title` "Add image — or drop a PNG/JPEG") plus a drop zone covering the whole conversation panel. The button stays because drag-and-drop alone is not keyboard accessible. |
| Effort chip | Removed. It is hard-wired disabled and carries no information. Reintroduce it as an enabled chip when a host offers effort settings. |
| Composer disclosure line | Moved to the right side of the shell footer on the Chats view, replacing `buildLabel`, which duplicates it (for example "Local Codex host"). |
| Shell footer status | Stays on the left with the text unchanged ("Conversation connected"). On the Chats view it is the single ambient status strip. Other views are unchanged and keep `buildLabel`. |
| Focus ring and resize grip | Deleted. The textarea auto-grows up to about 40vh, then scrolls. |

## (c) Drag-and-drop interaction states

| State | Trigger | Visual | Effect |
|---|---|---|---|
| Idle | — | none; "+" tooltip mentions drop | — |
| Drag-over, valid | single PNG or JPEG file drag, not blocked | composer gets a 2px dashed accent outline (`data-drop="accept"`) and a centred overlay "Drop to attach image" (or "Drop to replace chart.png") | `dropEffect` set to copy |
| Drag-over, invalid | wrong MIME type, several files, or blocked reason | dashed outline in the muted colour (`data-drop="reject"`); overlay shows the reason | `dropEffect` set to none; a drop is swallowed and the pending image is untouched |
| Invalid after drop | size over 4 MB, or type misreported during drag | outline cleared; `<p role="alert">` under the chip with the reason | `selectImage` is not called; the alert clears on the next attempt |
| Uploading | `view.image.status === 'uploading'` | chip shows "Uploading…"; "+" disabled; Send disabled | new drags show the invalid state with "Wait for the current upload to finish." |
| Ready | `status === 'ready'` | chip shows "Ready" and "×" | Send is enabled even if the text is empty (`canSend` unchanged) |
| Failed or interrupted | upload error | chip shows the reason or "Upload interrupted", plus "Retry" and "×" | Retry calls `retryImage`; a new drop replaces the image through `selectImage` |

## Change points

| File | Change |
|---|---|
| `apps/desktop/src/application/ConversationView.tsx` | **Line 137:** remove the empty-state paragraph. **Line 156:** header gets `className="visually-hidden"`. **Line 155:** the section gets `data-empty` and the drop handlers. **Line 172:** permissions move below the decisions, gated by `permissionsShown`. **Lines 173-174:** modules routing as described above. **Lines 186-217:** composer restructured: chip and alert first, then the textarea with `rows={2}` and an auto-grow `useLayoutEffect` capped at 40vh; the footer gets leading/trailing groups. The Send button becomes `className="composer-send" aria-label="Send"` with an arrow icon. Stop keeps visible text. Line 215 (the disclosure paragraph) is deleted. **Lines 200-207:** `onChange` routes through `attach`. The hidden input keeps `aria-label="Image file"` and its `acceptsImages` gating. |
| `apps/desktop/src/application/ConversationPermissions.tsx` | Add the `permissionsShown` export. |
| `apps/desktop/src/application/CustomizationModules.tsx` | Empty modules render `null`. Add the `CustomizationFailure` export. The `failed` branch is removed from `CustomizationModules`. |
| `apps/desktop/src/application/ComposerAgentControls.tsx:97` | Delete the effort chip. |
| `apps/desktop/src/shell/BrowserApplication.tsx` | **Lines 54-55:** compute `hasTools` and `notices`. **Line 65:** pass `hasTools` and `notices`. **Lines 72-77:** restyle the empty workspace. **Line 136:** `{!app.active && notices}` instead of `modules`; with no conversation, modules could not run anyway. **Line 178:** `buildLabel={selectedView === 'chats' ? presentation.footer : presentation.buildLabel}`. |
| `apps/desktop/src/application/application.css` | Listed below. |
| `apps/desktop/src-tauri/tauri.conf.json` | Add `"dragDropEnabled": false` to `windows[0]`. `main.rs` builds from config, so no Rust change is needed. |

CSS changes in `application.css`:

- **Line 6:** drop `.composer textarea:focus-visible` from the outline list.
- **Line 92:** drop the header border rule.
- **Line 119:** `resize: none; overflow-y: auto; max-height: 40vh`.
- **Line 121:** delete the `.composer:focus-within` ring.
- **Lines 133, 237, 239:** delete the effort and disclosure rules. Scope the accent fill to `.composer-send`, so the "+" and Tools buttons are not filled with the accent colour.
- **Line 240:** anchor `.composer-picker` on the right, because the chips now sit at the right.
- **Line 134:** compact `.permissions-panel`: lighter padding and no heavy border.
- **Line 214:** `.customization-modules` loses its border inside the popover.
- **Additions:** `[data-empty="true"]` centring (greeting `margin-top: auto`; composer `margin-bottom: auto`; `.conversation-content` `flex: none`), `.composer[data-drop]`, `.composer-drop-hint`, `.composer-image` chip, `.composer-icon`, `.composer-send`, and `.conversation-greeting`.
- **Focus outlines:** buttons keep their `:focus-visible` outlines (lines 6 and 252), so keyboard focus stays discoverable everywhere except the textarea, where the caret is the indicator, as the user requested.

The `.view-rail` and `.application-controls` rules are not touched.

## Implementation units (in dependency order)

1. **Tauri drop delivery.** Add `dragDropEnabled: false` to the window config. First, search for `drag-drop` and `onDragDropEvent` to confirm nothing listens for native drop events (evidence gap).
2. **`image-intake.ts`.** Pure functions with no dependencies.
3. **`ComposerImageDrop.tsx`.** The hook and the chip. Depends on unit 2.
4. **Small independent edits.** `permissionsShown`, the effort chip removal, and the `CustomizationModules` split.
5. **`ComposerTools.tsx`.**
6. **`ConversationView` restructure.** Depends on units 3, 4 and 5.
7. **`BrowserApplication` wiring.** `hasTools`, `notices`, the footer label and the empty workspace. Depends on units 4 and 6.
8. **CSS.**
9. **Tests.** Update the existing ones and add new ones (see verification).

## Compatibility, migration, failure and recovery

**Compatibility.** No users and no backward-compatibility requirement (confirmed context). The only internal prop additions are the optional `hasTools` and `notices` on `ConversationView`. The SDK contract does not change: `ConversationModuleProps` is the same, and claimed layouts still receive the `modules` slot. Draft and image persistence are untouched.

**Tauri.** Turning the native handler off means OS file drops reach the page as HTML5 events with `File` objects. Drops outside the panel inside the desktop app would try to navigate to `file://`, which `on_navigation` already refuses (`bundled(url) || browser_url`). In the browser build, a file dropped on the sidebar still navigates away; that behaviour exists today and I leave it, because the sidebar is out of scope.

**Failures:**

| Failure | Behaviour |
|---|---|
| Rejected drop | Alert shown; the pending image is unchanged. |
| Upload failure | Retry and Remove as today. |
| Storage failure or disconnected | Drop is refused with the reason, mirroring the button's disabled state. |
| Customization failure | Inline alert with "Use Restore default view…" as today, and the Extensions row shows Failed. |
| Tool error while the popover is closed | Still caught by `CustomizationBoundary` (the content stays mounted), so the failure surfaces. |

## Acceptance checks (user-visible)

1. **Empty new Codex conversation shows only** the greeting, the composer and the footer. None of these appear: a visible header, a Permissions region, "Send a message to begin.", "Custom tools", an effort button, or a disclosure line inside the composer.
2. **No focus ring.** Clicking the textarea shows no ring (computed `box-shadow` on `.composer` is `none`) and the caret blinks. Tabbing to "+", the chips or Send shows the 2px outline.
3. **No resize grip.** Computed `resize` is `none`. Typing ten lines grows the box, then it scrolls.
4. **Valid drop.** Dragging a PNG over the panel shows the dashed outline and "Drop to attach image". Dropping it moves the chip from "Uploading…" to "Ready", and Send becomes enabled.
5. **Invalid drops.** A GIF drag shows the rejection overlay. A file over 4 MB triggers the alert "Choose an image of at most 4 MB.". Dropping two files triggers the alert "Drop one image at a time.".
6. **Keyboard attach.** Focusing "+" and pressing Enter opens the file chooser.
7. **Crew permissions.** A Crew conversation with grants shows the Permissions region above the composer with its revoke buttons. The Crew provider test passes unchanged.
8. **Footer.** It reads "● Conversation connected" on the left and "Local Codex · Approvals required for changes" on the right.
9. **Tools fixture.** With the module-actions fixture, the Tools chip appears, opening it runs an action, and the action status survives closing and reopening the popover.
10. **Rail and sidebar untouched.** The diff shows no changes to the rail or Chats sidebar markup, or to the `.view-rail` and `.application-controls` CSS.

## Verification

**Audit before deleting any text.** Run from the repo root:

```
grep -rnE "Send a message to begin|Custom tools|Loading custom tools|Effort, Default|composer-disclosure|Local Codex host|Recorded host|Your conversation|customization-namespace" tests extensions apps/desktop/src
```

Every hit is either kept, by leaving the text visually hidden, or updated in the same change.

**Expected test updates:**

- `module-actions.browser.test.mjs`: open the Tools chip first.
- Tests that assert `buildLabel` strings on the Chats view.
- Tests that assert "Loading custom tools…" inline.

These should still pass unchanged:

- `composer-image`: the "Add image" and "Replace image" names, `getByLabel('Image file')`, "Retry", "Attached image" and "Ready" are all preserved.
- `crew/provider.test.mjs`.
- The failure alert texts in frontend-tools, journey and transcript-overrides.

I expect visually hidden header text to still count as visible to Playwright, since it has a non-empty 1×1 box. That is an assumption to confirm when the tests run.

**New browser tests** (extend the harness in `tests/application/composer-image.browser.test.mjs`):

- Synthetic `DataTransfer` drops via `locator.dispatchEvent('drop', { dataTransfer })` covering: valid PNG, GIF, a file of 4 MB + 1 byte, two files, and a drop while uploading. Each asserts the chip or alert and `data-drop` during `dragover`.
- Computed style checks for `resize: none` and `.composer` `box-shadow: none` while the textarea is focused.
- An assertion that no `button[name=/Effort/]` exists.

**Commands.** Use the repo's scripts: `npm run check`, `npm run lint`, `npm test`, `npm run build`, then root `npm run verify`.

For focused runs:

```
node --test tests/application/composer-image.browser.test.mjs
node --test extensions/crew/tests/provider.test.mjs
```

I am assuming these run from the package that owns `tests/application`. The packet does not show which directory that is.

**Manual desktop check.** Drop from Finder onto the composer in the Tauri app. The packet does not include the command to launch the desktop app; this is an evidence gap.

## Why this approach fits

- It removes clutter mostly by **gating on relevance** rather than by deleting capabilities. Every removed element had either nothing to say (unsupported permissions, empty tool sets, a disabled effort chip) or a duplicate (header vs model chip, build label vs disclosure).
- The constraints hold:
  - Crew revocation and test selectors are preserved.
  - The image contract (types, 4 MB, a single pending image, `selectImage`/`retryImage`/`removeImage`) is unchanged.
  - The SDK layout contract is unchanged.
  - The rail and sidebar are untouched.
- It reads like the comparators: no header, no panels, a single "+", compact chips, no ring and no grip. It stays OpenPane through the existing brand mark, tagline, raised rounded composer and footer strip.

**Main tradeoff.** Less is discoverable at a glance. Tools sit behind a chip, the approval disclosure moves to small footer text, and providers without permission support no longer say so. There is also moderate test churn.

## Rejected alternative

Moving Custom tools into the Extensions view, which would be literally "configured elsewhere". Modules need live conversation context (`ConversationModuleProps`: scope, activity, commands and permissions) to run actions. Hosting them in Extensions would mean actions target a conversation that is not on screen. It would also duplicate connection and responding gating outside `ConversationView`. Extensions remains the place for configuration status, and the composer chip is where tools run.

## Uncertainties that would change the recommendation

- **Most decisive:** whether HTML5 file drops actually deliver `File` objects in the Tauri macOS WKWebView once `dragDropEnabled` is false. If they do not, or if something depends on the native `tauri://drag-drop` events, drag-and-drop would instead need the native drop event plus a host-mediated read of the dropped path. That is a privileged file-read surface, and I would scope it separately rather than fold it into this redesign.
- **Secondary:** whether `PermissionState` has a distinct `unsupported` kind. The brief says Codex "returns `unsupported`". If that is only conveyed in `reason`, `permissionsShown` must key on whatever discriminant `application-controller.ts` actually uses.
