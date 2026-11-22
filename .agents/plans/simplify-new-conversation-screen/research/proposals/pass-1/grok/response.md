The new-conversation column should be a transcript and one composer. Chrome that only says “nothing to configure” comes off this screen; the image control becomes a “+” that also accepts a drop; typing shows the caret and no ring.

The icon rail (`.view-rail`) and the Chats sidebar (`.application-controls`) stay as they are. This pass only changes `ConversationView`, the composer and the pieces it renders, the empty-workspace composer that reuses those pieces, and the shell footer only by leaving it alone.

## Central idea

On an empty conversation the main column centres one raised composer: placeholder, a “+”, harness and model chips, and Send. After the first message, the transcript scrolls and the composer sits on the bottom edge. The OpenPane composer (raised surface, 22px radius, accent Send pill, existing tokens) stays.

A control remains on this screen only when it can do something for this conversation. A provider that does not report permissions does not get a Permissions card. A namespace whose `modules` array is empty does not get a Custom tools fieldset. Non-empty conversation modules move to the Extensions screen, which already lists those namespaces. A claimed content layout still receives the modules slot and may place it.

## Where each current element goes

| Element | Placement |
|---|---|
| Header (“Your conversation”, agent label, border) | Removed. The section keeps `aria-label="Conversation"`. The model chip already shows the agent label (the screenshot repeats “GPT-6.2 Sol” in the header and the chip). Eyebrow and scope label are already `display: none`. |
| Permissions card | Unmounted when `PermissionState` has no listing. Codex “does not report permissions” matches that (the empty-listing sentence in `ConversationPermissions` is different: “No active work-item permissions were found.”). When a listing is present, the same `region` named Permissions, including “Refresh permissions”, stays between the transcript and the composer. |
| “Send a message to begin.” | Removed, including the recorded-demonstration variant. The textarea placeholder remains the prompt (`Write to Codex…`, and the existing recorded placeholder). |
| Custom tools fieldsets | Ready and `modules.length === 0`: render nothing (this is the crew and coworkers case: both return `modules: []`). Loading and failed: stay in the conversation column as the current status line and the alert “Custom tools could not load.” Ready and non-empty: Extensions panel, not this column. A claimed `contentLayout` still receives the modules slot. |
| Add image | A “+” at the start of the composer footer. Accessible name stays “Add image”, or “Replace image” when `view.image` is set. The hidden file input keeps `aria-label="Image file"`. The composer is also the drop target. |
| Effort chip (“Default”, disabled) | Removed. No replacement. The host still has no effort setting. |
| Composer disclosure (“Local Codex · Approvals required for changes”) | Removed from view. The same `presentation.footer` string stays in a `visually-hidden` paragraph in the composer so the policy sentence remains in the accessibility tree. The host name stays visible as the shell footer build label. |
| Shell footer (“● Conversation connected”, “Local Codex host”) | Unchanged, in `DesktopShell`. `Shell.tsx` is not edited. |
| Composer focus ring (`.composer:focus-within`) | Removed. Button `:focus-visible` outlines stay. |
| Textarea resize grip | Removed (`resize: none`). `rows={3}`, `min-height: 54px`, and `max-height: 160px` stay; extra text scrolls inside the field. |

## Wireframes

Rail and Chats sidebar are unchanged and omitted. Width stays `min(100%, 820px)`.

Empty new conversation (no messages, Codex, no listing, no modules):

```
┌──────────────────────────────────────────────┐
│                                              │
│                                              │
│           ╭────────────────────────────╮     │
│           │ Write to Codex…            │     │
│           │                            │     │
│           │ +    Codex ▾   GPT-6.2 ▾   │     │
│           │                      Send  │     │
│           ╰────────────────────────────╯     │
│                                              │
│ ● Conversation connected    Local Codex host │
└──────────────────────────────────────────────┘
```

The caret is the only focus indicator inside the field. There is no header, permissions card, empty-state line, Custom tools box, effort chip, disclosure line, or resize grip.

Active conversation, one pending image (composer pinned; image not sent yet):

```
┌──────────────────────────────────────────────┐
│ You                                          │
│ ╭────────────────────────╮                   │
│ │ Look at this diagram.  │                   │
│ ╰────────────────────────╯                   │
│                                              │
│ Codex                                        │
│ I see a box and an arrow.                    │
│                                              │
│ ╭──────────────────────────────────────────╮ │
│ │ Write to Codex…                          │ │
│ │ ┌ chart.png · 70 B          Ready     ┐  │ │
│ │ │                              Remove  │  │ │
│ │ └──────────────────────────────────────┘  │ │
│ │ +    Codex ▾   GPT-6.2 ▾           Send  │ │
│ ╰──────────────────────────────────────────╯ │
│ ● Conversation connected    Local Codex host │
└──────────────────────────────────────────────┘
```

“+” is named “Replace image” while a pending image exists. Send stays on the existing `canSend` rule (image `ready`, or non-empty draft). After send, the chip leaves the composer and the message uses the current `ImageAttachmentCard`.

When Crew has a listing, the empty centred layout is not used. The Permissions region sits under the transcript and above the composer, with the same headings and buttons as today, including “Refresh permissions”.

## Drag-and-drop states

Drop chrome is local UI state on the composer form. The pending image remains `view.image` from `useConversation(active.store)`. Invalid drops never call the store.

| State | What the user sees | Data |
|---|---|---|
| Idle | No drop outline. “+” enabled when `acceptsImages`, `enabled`, no `storageFailure`, and status is not `uploading`. | Store unchanged. |
| Drag-over | `data-drop="over"`: dashed accent outline only while a file is over the composer, plus “Drop PNG or JPEG” (or “Drop to replace” if a chip is already there). This outline is not the typing ring. | Store unchanged. `dropEffect = "copy"`. |
| Invalid type or size | Outline clears. Alert: “Choose a PNG or JPEG image.” or the existing “Choose an image of at most 4 MB.” Draft and current image stay. | No `selectImage`. |
| Uploading | Existing chip status “Uploading…”. “+” and further drops disabled. | `selectImage({ name, bytes })` in flight, via the current `imageAction` error path. |
| Ready | Chip status “Ready”, Remove available. Send follows `canSend`. | `view.image.status === 'ready'`. |
| Failed | Status is `image.reason` or “Upload interrupted”, with Retry and Remove. | Existing `retryImage` / `removeImage`. `imageError` still uses `role="alert"`. |

Pointer flow on the composer `<form>`:

1. `dragenter` / `dragover` call `preventDefault` only when a drop is allowed, and a counter ignores enters and leaves of child nodes.
2. If `dataTransfer.items` already shows every item is a non-image type, the state is invalid before the drop. If the type is unavailable until drop, the state stays drag-over, then validation runs on drop.
3. Drop uses `files[0]` only (one pending image). MIME must be `image/png` or `image/jpeg`, then `file.size > IMAGE_MAX_BYTES` (4 MB), then the same `selectImage` call the file input uses. The input’s value is still cleared after pick.
4. A drop elsewhere on the conversation section is cancelled so the webview does not navigate, and it does not attach the file.
5. Keyboard users use “+”, which clicks the hidden input. Drag-and-drop is not a keyboard path. Tab order is Message, Add image, Harness, Model, Send. Each button keeps the existing `:focus-visible` outline.

Desktop drops need the native Tauri handler off. It is on by default, and on macOS it consumes the drop so the page never sees a `File`. Set `"dragDropEnabled": false` on the window in `apps/desktop/src-tauri/tauri.conf.json`, and call `.disable_drag_drop_handler()` on the `WebviewWindowBuilder` chain in `main.rs` before `.build()`. The browser build (`vite --mode browser`) already receives HTML5 drops. The “+” picker still works if a drop does not.

Assumption: an empty `file.type` is rejected unless the name ends in `.png`, `.jpg`, or `.jpeg`. The packet’s picker path checks size only and relies on `accept`.

## Ownership

- Draft, connection, image, send, retry, and remove stay in `active.store`. `ConversationView` still mirrors the draft with `DraftEditor`.
- `imageError` and the new drop state (`'idle' | 'over' | 'invalid'`) stay in `ConversationView`. They reset per store the same way `imageError` already does.
- `PermissionState` stays in the controller. The view only decides whether to mount `ConversationPermissions`.
- Module trees stay in `NamespaceActivation`. `BrowserApplication` chooses the parent: conversation column, Extensions, or the claimed layout’s slot.
- Shell status stays `ConversationStatus` plus `presentation.buildLabel`.
- No new persisted state, flag, or pairing/attestation surface. `backward_compatibility_required=false` and `feature_flags=not-applicable`, so this is a straight UI cutover.

## Types, boundaries, and flow

```ts
type ComposerDrop = 'idle' | 'over' | 'invalid';

function permissionsPanelVisible(state: PermissionState): boolean;

type ModuleSurface = 'status' | 'tools' | 'all';
```

`permissionsPanelVisible` is true only when `'listing' in state` and `state.listing` is non-null. Assumption: Codex unsupported has a reason and no listing. The Crew browser test still finds the region after “Provider permissions unavailable” because the revoke button is still in the listing and only becomes disabled. Evidence gap: the `PermissionState` union in `application-controller.ts` is not in the packet. If unsupported carries a listing object, key the predicate off that kind instead of listing presence.

`CustomizationModules` gains `mode: ModuleSurface`.

- `status`: loading text and the failed alert only.
- `tools`: the fieldset only when `kind === 'ready'` and `modules.length > 0`.
- `all`: today’s behaviour, except a ready empty list returns `null`.

`ConversationModules` returns `null` when `modules.length === 0`, so an empty `<fieldset>` and the “Custom tools” legend are not rendered.

Control flow for one drop:

1. Composer checks `acceptsImages` (supported image input and a `send` command), `enabled`, no storage failure, and image status not `uploading`.
2. `ingestImage(file)` checks type and `IMAGE_MAX_BYTES`, then `active.store.selectImage({ name, bytes })`.
3. `imageAction` clears `imageError` and records a rejection.
4. `view.image.status` drives Uploading, Ready, and Failed. Send, Stop, and draft saving are unchanged.

Module flow:

1. `BrowserApplication` builds two element lists from `custom.namespaces`, one `mode="status"` and one `mode="tools"`.
2. If `slots.contentLayout.kind === 'claimed'`, the layout receives one `mode="all"` list and Extensions receives no tools.
3. Otherwise `CustomizationContent`’s default and conflict fallback render the transcript only (plus the existing conflict alert). Status elements stay in the conversation slot. Tool elements go to `ExtensionsList`.
4. Remove `{!app.active && modules}` from `.chat-view`, so the no-conversation screen does not host tool fieldsets either.
5. A React node list is passed to one parent only.

`ConversationModuleProps` is unchanged (`conversation`, `activity`, `commands`, `permissions`). Assumption: `app.active` remains set when `selectedView` is `extensions`, because those are separate pieces of state and the store lives on the controller. The Extensions tree can call `useConversation(active.store)` while the chat view is hidden.

## Change points and new symbols

Existing:

- `ConversationView` in `apps/desktop/src/application/ConversationView.tsx`. Delete the `<header>` (h1, agent label, eyebrow, scope). Delete the empty-state `<p>`. Mount `ConversationPermissions` only when `permissionsPanelVisible`. Add `conversation-empty` when there are no messages, no observation banner, and the permissions panel is not mounted. On `<form className="composer">`, add the drop handlers and `data-drop`. Replace the “Add image” / “Replace image” button’s visible text with “+” and keep those accessible names. Move that button to the start of `.composer-footer`. Keep the hidden file input. Put `presentation.footer` in a `<p className="visually-hidden">`. Add a local `ingestImage`. Set the textarea to `resize: none` in CSS. Leave decisions, observation notices, `CommandRecovery`, Stop, and send submission as they are.
- `ComposerAgentControls` in `apps/desktop/src/application/ComposerAgentControls.tsx`. Delete the disabled effort `<button>` (`composer-effort`, “Default”). Harness and model popovers stay.
- `ConversationPermissions` in `apps/desktop/src/application/ConversationPermissions.tsx`. Add `permissionsPanelVisible`. Do not change the region, refresh button, or revoke copy.
- `CustomizationModules` / `ConversationModules` in `apps/desktop/src/application/CustomizationModules.tsx`. Add `mode`. Return `null` for a ready empty module list.
- `CustomizationContent` in `apps/desktop/src/application/CustomizationContent.tsx`. Default and conflict fallback render `{transcript}` and, on conflict, the existing alert. Claimed layouts still get `<Layout transcript={transcript} modules={modules} />`.
- `BrowserApplication` in `apps/desktop/src/shell/BrowserApplication.tsx`. Split module elements by `slots.contentLayout.kind`. Pass tools into the extensions view. Delete the `{!app.active && modules}` mount. The empty-workspace block (eyebrow, h1, “Choose your chat settings.”) stays; it loses the effort chip because it shares `ComposerAgentControls`, and it never had a textarea ring.
- `ExtensionsList` in `apps/desktop/src/application/ExtensionsView.tsx`. Add optional `tools?: ReactNode`, rendered after the list with no extra heading. Empty tool output adds no boxes. Evidence gap: the JSX that renders `ExtensionsList` is not in the packet; it is in this file or in `BrowserApplication`. Thread `tools` through that call.
- `application.css`. Delete `.composer:focus-within`. Set `.composer textarea { resize: none }`. Add `.composer[data-drop="over"]` and `.composer[data-drop="invalid"]`, `.composer-add` (transparent, not the accent Send rule), and `.conversation-empty` (`justify-content: center`, transcript `min-height: 0` and no padding). Add `.extensions-panel .customization-panel { max-height: none }`. Do not edit `.view-rail` or `.application-controls`.
- `apps/desktop/src-tauri/tauri.conf.json` window object: `"dragDropEnabled": false`.
- `apps/desktop/src-tauri/src/main.rs`: `.disable_drag_drop_handler()` on the existing `WebviewWindowBuilder::from_config` chain.

Unchanged files: `Shell.tsx`, `agent-presentation.ts` (footer strings stay; only their visibility changes), `ImageAttachmentCard`, image store methods.

Evidence gap: `CommandActivity` and `FileActivity` are always mounted, and their empty output is not in the packet. If they return null when the domain has no activity, centering works. If they render headings on an empty conversation, skip mounting `nativeActivity` in that empty case. Do not redesign those components.

No auto-grow script. Removing the grip leaves the current three-row field with internal scroll.

## Implementation order

1. **Composer chrome.** CSS ring and resize, header, empty-state paragraph, effort button, hidden disclosure, `conversation-empty`. After this, an empty Codex column is headerless and the composer no longer rings or shows a grip.
2. **Permissions gate.** `permissionsPanelVisible` and the conditional mount. Centering depends on this so a Crew listing does not centre over the region.
3. **Custom tools.** `mode`, null empty fieldsets, `CustomizationContent` fallback, `BrowserApplication` split, `ExtensionsList` `tools`, removal of modules under the empty workspace.
4. **Attach.** `ingestImage`, “+”, drop states, section-level `dragover`/`drop` cancellation, then the Tauri flag and `disable_drag_drop_handler()`.
5. **Tests the moves affect.** Update queries that looked for a visible effort control, the composer ring, the empty-state sentence, or a “Custom tools” legend on an empty Codex conversation. Point module-action queries at the Extensions panel when `mode="tools"`. Leave Crew’s `getByRole('region', { name: 'Permissions' })` and “Refresh permissions” locators as they are. Leave `getByLabel('Image file')`, “Add image”, “Replace image”, “Retry”, and “Attached image” as accessible names.

## Compatibility and failure

There is no data migration. Drafts, sent images, and permission commands are untouched.

An invalid drop sets `imageError` and leaves `view.image` and the draft. A failed or interrupted upload still uses Retry and Remove. `storageFailure` still makes the textarea read-only and blocks “+” and drops. Send is still disabled until the image is `ready` or the image is removed and the draft is non-empty.

Unmounting Permissions on Codex also removes its window-focus refresh. That refresh only matters for a provider that reports permissions; the component mounts again when a listing exists.

Disabling Tauri’s native drop handler is the compatibility risk. The packet shows no `tauri://drag-drop` listener. Assumption: nothing else handles OS file drops. If the handler stays enabled, desktop drag-and-drop never reaches `ingestImage`, and the “+” picker remains the working path.

Claimed content layouts still receive modules. Default and conflict layouts no longer paint them in the column. `has_active_users=false`, so there is no compatibility shim and no flag.

The empty-workspace screen is not the redesign target. It keeps its heading and copy, and it shares the effort-chip removal.

## Acceptance and verification

Visible checks:

- Empty Codex conversation: no “Your conversation”, no Permissions region, no “Send a message to begin.”, no “Custom tools”, no “Default” effort chip, no disclosure line, no resize grip. Placeholder “Write to Codex…”. Typing shows a caret and no accent ring around the composer.
- Tab reaches Message, Add image, Harness, Model, and Send, and each button shows a focus outline.
- “+” opens a picker. A PNG or JPEG at or under 4 MB runs Uploading then Ready. Send submits and the chip detaches. GIF or a file over 4 MB shows an alert and does not call `selectImage`. A second file replaces the pending one. Retry and Remove still work. A model that loses image support still shows the existing “cannot read images” line and hides the file input and Replace.
- Crew conversation with grants: region “Permissions”, “Refresh permissions”, and both revoke paths still work.
- Extensions: crew and coworkers rows unchanged when they contribute no modules. A fixture with a non-empty module shows its actions there, and the conversation column does not show that fieldset. A failed load still shows “Custom tools could not load.” on the conversation.
- Rail and Chats sidebar look and behave as before. Footer still shows connection on the left and the host label on the right.

From the repository root, in this order:

```
npm run check
npm run lint
npm test
npm run build
npm run verify
```

`npm test` is `node --test` and includes the Playwright tests under `tests/application/*.browser.test.mjs`. These are the ones that cover this change: `composer-image.browser.test.mjs`, `content-layout-image.browser.test.mjs`, `selective-activity.browser.test.mjs`, `module-actions.browser.test.mjs`, `frontend-tools.browser.test.mjs`, `journey.browser.test.mjs`, `transcript-overrides.browser.test.mjs`, `content-layout.browser.test.mjs`, `extensions-view.browser.test.mjs`, `extensions/coworkers/tests/desktop.browser.test.mjs`, and `extensions/crew/tests/provider.test.mjs`.

## Why this approach, and what would change it

It deletes the empty chrome from the screenshot and leaves the contracts those tests already name: Message, Image file, Add image, Replace image, the Permissions region, and Refresh permissions. Comparators only set the tone: no page header, no empty cards, one attach control, chips for settings, no focus ring, no grip. OpenPane’s composer and footer stay recognisable. Extensions is already the configuration screen, so custom tools do not need a new page.

The main tradeoff is discoverability. An empty Codex chat is quiet because permissions and tools appear only when they have content, and non-empty tools are on Extensions rather than beside the composer. Revocation and module actions remain available, just not as permanent cards on a blank chat.

I rejected a single composer “…” menu that would hold Add image, Permissions, Custom tools, and Effort. The menu would keep those concerns on this screen, Crew’s region would not be present until the menu opened, and a menu does not make attach a drop.

The fact that would change the recommendation is an existing listener on `tauri://drag-drop`, or any other use of the native drop handler. The packet does not show one. If one exists, leave the handler enabled and add a desktop path that reads dropped paths into the same `ingestImage` checks. The “+” control and the browser HTML5 path would stay. A lesser gap is the `PermissionState` shape: if “does not report permissions” includes a listing, change the predicate, not the layout.
