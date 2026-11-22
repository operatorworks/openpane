The central idea is a quiet conversation canvas: one composer, one combined agent/model picker, and controls that appear when needed. Keep OpenPane’s existing colors, rounded composer, typography, and Send button. Leave both left navigation panes unchanged.

This proposal changes presentation and placement. Conversation state, commands, permissions, and image uploads remain owned by their existing stores and controller.

**Proposed appearance**

A new, active conversation with no messages has a vertically centered composer. The placeholder provides the invitation to start; there is no visible page header, permissions card, empty-state sentence, or Custom tools panel.

```text
┌──────┬───────────────────┬────────────────────────────────────────────┐
│ Icon │ Chats             │                                            │
│ rail │ sidebar           │                                            │
│      │                   │                                            │
│      │    unchanged      │   ╭────────────────────────────────────╮   │
│      │                   │   │ Write to Codex…                    │   │
│      │                   │   │                                    │   │
│      │                   │   │ +    Codex · GPT-6.2 Sol ⌄  …  Send │   │
│      │                   │   ╰────────────────────────────────────╯   │
│      │                   │                                            │
│      │                   │                                            │
│      │                   ├────────────────────────────────────────────┤
│      │                   │ ● Conversation connected  Local Codex host │
└──────┴───────────────────┴────────────────────────────────────────────┘
```

After activity begins, the transcript occupies the flexible scrolling area and the same composer sits at the bottom. A pending image adds one compact attachment row.

```text
┌──────┬───────────────────┬────────────────────────────────────────────┐
│ Icon │ Chats             │                                  You       │
│ rail │ sidebar           │                  Explain this diagram.     │
│      │                   │                                            │
│      │    unchanged      │ Codex                                      │
│      │                   │ Here is what the diagram shows…            │
│      │                   │                                            │
│      │                   │                  [scrolling transcript]    │
│      │                   │                                            │
│      │                   │   ╭────────────────────────────────────╮   │
│      │                   │   │ Compare it with this version.      │   │
│      │                   │   │                                    │   │
│      │                   │   │ chart.png · 70 B · Ready   Remove  │   │
│      │                   │   │ +    Codex · GPT-6.2 Sol ⌄  …  Send │   │
│      │                   │   ╰────────────────────────────────────╯   │
│      │                   ├────────────────────────────────────────────┤
│      │                   │ ● Conversation connected  Local Codex host │
└──────┴───────────────────┴────────────────────────────────────────────┘
```

The image row also represents Uploading, Failed, and Interrupted states. Retry appears for the latter two. Stop retains its current conditional placement beside Send.

**Where the existing elements go**

| Element | Proposed treatment |
|---|---|
| Header | Remove the visible header and border. Put agent identity, conversation ID, and recorded-conversation identification in the `…` conversation-details panel. Preserve an accessible conversation heading. |
| Permissions card | Move its contents into conversation details. Suppress the unsupported-provider section. Automatically reveal details when actionable grants first appear, so Crew revocation remains visible and reachable. |
| “Send a message to begin.” | Remove it. Keep the agent-specific textarea placeholder. Preserve recorded-playback identification in details. |
| Custom tools | Move default-layout module controls to a conversation-scoped section in the existing Extensions view. Extension setup remains in existing extension workspaces. Claimed content layouts retain their `modules` slot. |
| Add image | Replace the text button with a compact `+`, with accessible name “Add image” or “Replace image.” Make the composer a file-drop target. Keep the hidden “Image file” input for keyboard and file-picker access. |
| Effort chip | Remove the permanently disabled chip. Put “Effort is managed by the host” inside the picker. Add no effort-setting behavior. |
| Composer disclosure | Move the exact `presentation.footer` text into conversation details. |
| Shell footer status | Keep the existing muted strip and live status unchanged. This avoids changing other views or duplicating connection indicators. |

The combined picker button displays `Codex · GPT-6.2 Sol`. It opens the existing model picker, which gains a “Change harness” action leading to the existing harness choices. Preserve the warning that choosing another harness starts a new conversation and retains the current draft.

Conversation details opens as a bounded panel in normal flow immediately above the composer. It should not cover the textarea or transcript. Its trigger has `aria-expanded` and `aria-controls`; closing with Escape restores focus to the trigger.

**Ownership, types, and boundaries**

Keep durable state where it already lives:

- `active.store`: draft, pending image, upload status, messages, commands, and recovery state.
- Controller: active conversation, agent creation, permissions, observation, and continuation.
- `ConversationView`: existing draft editor state, command guards, and details visibility.
- Image-input hook: transient drag state, file-reading guard, input reference, and selection errors.
- `ComposerAgentControls`: picker state and focus restoration.
- `BrowserApplication`: the single placement decision for conversation modules.

Proposed additions:

| File / symbol | Responsibility |
|---|---|
| `apps/desktop/src/application/ConversationDetails.tsx` — `ConversationDetails` | Present relocated metadata and disclosure; render the existing permission component when applicable. |
| `apps/desktop/src/application/useComposerImageInput.ts` — `useComposerImageInput` | Unify file-picker and drop handling, validation, transient feedback, and guarded asynchronous selection. |
| `apps/desktop/src/application/composer-image-input.ts` — `validateImageSelection`, `readImageSelection` | Pure selection checks and PNG/JPEG byte identification. No persistence or upload implementation. |

The hook’s proposed interface accepts the current store, image capability, and existing enabled/storage restrictions. It returns input/drop handlers, an input ref, a transient selection state, and wrappers for retry/remove.

Use a discriminated transient state:

```ts
type ImageSelectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'drag-over' }
  | { readonly kind: 'reading'; readonly name: string }
  | { readonly kind: 'invalid' | 'failed'; readonly message: string };
```

Upload readiness continues to come from `view.image`; do not copy it into this union. A local synchronous guard prevents overlapping file reads before React or the store updates.

Details visibility is local UI state. A small projection of permission state determines whether permissions are unsupported, informational, or require attention. **Evidence gap:** the complete `PermissionState` union is absent. Map its actual typed unsupported result during implementation; do not infer support from provider names or reason strings.

**Control and data flow**

For images:

```text
file picker / composer drop
          ↓
one shared validation and reading path
          ↓
captured conversation store.selectImage({ name, bytes })
          ↓
view.image → attachment row → existing send eligibility
          ↓
existing store.send(), retryImage(), removeImage()
```

Validate exactly one file and `IMAGE_MAX_BYTES` before reading. Reject advertised unsupported MIME types; for empty MIME types, identify PNG/JPEG from bytes. Verify signatures after reading as well. Signature identification is not full image decoding; existing downstream rejection must remain visible.

Capture the target store before asynchronous work. Associate errors with that store, as the current code does. Ignore completed local reads after unmount or cancellation. Removing an attachment invalidates any unfinished local read, preventing it from reattaching afterward. Disable Send during local replacement reading, so it cannot accidentally send the previous ready image.

For modules, preserve context and single ownership:

1. `BrowserApplication` builds module elements using the active conversation and its actions.
2. If the effective content layout is claimed, its `modules` slot remains the sole destination.
3. For default or conflicting layouts, the existing Extensions list gains a “Conversation tools” section containing those elements and the active conversation identity.
4. Without an active conversation, do not mount runnable module controls.
5. A ready namespace with `modules: []` renders nothing.

`CustomizationContent` therefore stops appending modules in its default fallback. Its claimed-layout path still passes `modules` unchanged. Keep its conflict alert and current loading/error fallbacks.

These modules are conversation actions, not a newly invented settings system. The packet supplies no generic module-configuration API. Existing extension workspaces remain the destination for extension setup.

Loading and failure notices must remain discoverable. Keep “Custom tools could not load.” alerts in the conversation when default-layout modules are relocated, while putting actionable module content in Extensions. Separate notice rendering from module rendering so this does not mount actions twice.

**Drag-and-drop behavior**

| State | Behavior |
|---|---|
| Idle | Ordinary composer; no persistent drop-zone border or attachment instructions. `+` remains available when image input is supported. |
| Drag-over | For file drags, show a temporary dashed boundary and “Drop one PNG or JPEG · up to 4 MB.” Nested drag events must not flicker the state. Text dragging remains ordinary text editing. |
| Invalid type/size | Announce an inline alert with the rejection reason. Reject multiple files explicitly. Preserve the draft and existing attachment. |
| Uploading | Show filename and “Uploading…” from `view.image`. Disable replacement and Send. Preserve existing removal behavior. The brief local file-read phase says “Preparing image…”. |
| Ready | Show filename, size, Ready, and Remove. `+` becomes accessible as “Replace image.” Preserve image-only sending. |
| Failed | Show the selection error or existing upload failure reason. Upload failures retain Retry and Remove; a local read failure can be retried through `+` or another drop. |

For unsupported or temporarily disabled image input, file drops show a concise explanation and perform no upload. Capability loss must retain the existing pending image, Retry, Remove, and “Remove the image to send” guidance.

Prevent file drops within the conversation panel from navigating the webview, including drops outside the composer. Only the composer accepts them. Do not install a shell-wide drop handler.

Set `"dragDropEnabled": false` on the existing window in `apps/desktop/src-tauri/tauri.conf.json`. The packet establishes that the default native handler otherwise consumes macOS drops. This enables the same HTML5 `File` path in browser and desktop, without a native file-path bridge or filesystem permissions.

**Exact existing change points**

- **`ConversationView.tsx`**
  - Remove the visible header at line 156 and empty-state paragraph at line 137.
  - Replace the always-visible permissions placement at line 172 with conversation details.
  - Replace image-input handling at lines 190–212 with the shared hook.
  - Add drop handlers to the form at line 186.
  - Relocate disclosure at line 215.
  - Preserve decisions, observation notices, continuation, command recovery, and send/stop guards.

- **`ConversationPermissions.tsx`**
  - Retain the named “Permissions” region, refresh button, stale-state handling, confirmation flow, and revocation semantics.
  - Remove card-specific presentation. Keep it mounted within the details container so closing details does not discard refresh behavior or confirmation state.

- **`ComposerAgentControls.tsx`**
  - Replace the two exterior picker triggers with one combined trigger.
  - Remove the disabled effort button at line 97.
  - Add internal harness navigation and host-managed effort information.

- **`CustomizationModules.tsx`**
  - Suppress ready empty module collections.
  - Separate namespace notices from runnable module content.
  - Preserve scoped context, availability gating, Suspense, boundaries, and action outcomes.

- **`CustomizationContent.tsx`**
  - Change the default fallback at line 12 to transcript only.
  - Preserve claimed-layout module delivery at line 20.

- **`ExtensionsView.tsx` / `BrowserApplication.tsx`**
  - Add an optional conversation-tools section to `ExtensionsList`.
  - Route modules once, after `conversationSlots(...)` resolves the effective layout.
  - Remove the no-conversation module placement at lines 134–136.
  - Simplify the empty-workspace markup at lines 72–76 using the same composer surface and combined picker.

- **`application.css`**
  - Remove `.composer:focus-within` at line 121.
  - Change textarea resizing to `resize: none`; retain bounded internal scrolling.
  - Keep the textarea’s accessible name and caret. Preserve visible keyboard focus on buttons, including new controls.
  - Add empty-conversation centering, details, drag-state, and compact attachment styles.
  - Scope changes to conversation/components; do not alter rail or sidebar rules.

- **`tauri.conf.json`**
  - Disable the native drag-drop handler for the existing window.

`Shell.tsx` and `agent-presentation.ts` need no behavioral changes.

The no-active-conversation workspace remains a settings/start surface. **Evidence:** its current composer contains no editable draft. Do not add a synthetic pre-conversation textarea or promise file attachment before a conversation exists.

**Dependency-ordered implementation units**

1. **Quiet composer and picker.** Remove the ring, resize grip, redundant text, and effort chip; combine picker triggers. Preserve current picker and conversation-creation behavior.
2. **Conversation details and permissions.** Relocate metadata/disclosure and permissions. Automatically open for newly appearing grants, retained revocation uncertainty, or new permission failures. Respect a user closing the panel until another attention event occurs.
3. **Module placement.** Implement the Extensions section, notice separation, empty-module suppression, and claimed-layout routing together.
4. **Image interaction.** Add shared validation and guarded selection, then connect picker and drag handlers and change Tauri configuration.
5. **Layout integration and verification.** Center pristine native conversations; use the bottom composer for active conversations. Adapt the empty workspace and verify all recovery/customization states.

Centering must never suppress content. Claimed layouts retain their content area; observation notices, decisions, continuation, and recovery controls remain rendered. **Evidence gap:** the complete activity projection is absent, so the precise “pristine conversation” predicate must account for native command/file activity rather than relying only on message count.

No storage migration, compatibility layer, feature flag, pairing, or attestation work is needed under the supplied application context.

**Acceptance and verification**

User-visible checks should establish that:

- Both left navigation panes retain their appearance and behavior.
- Empty Codex conversations show the quiet composer without unsupported permissions or empty Custom tools panels.
- Typing produces no composer highlight or resize handle.
- Keyboard users can reach `+`, picker, details, Send, and conditional Stop with visible button focus.
- Long drafts remain editable through textarea scrolling.
- Crew grants automatically reveal the named Permissions region; both revocation scopes, confirmation, refresh failure, and recovery still work.
- Default-layout module actions run in Extensions against the displayed active conversation. Claimed layouts still receive their module slot, with no duplicate action mounts.
- Valid PNG/JPEG drops and picker selections use identical upload behavior; invalid input leaves the draft and existing attachment intact.
- Retry, removal, image-only send, capability loss, interrupted uploads, and conversation switching retain correct behavior.
- Browser and packaged macOS desktop both receive real file drops.

Extend the named browser tests rather than replacing their behavioral coverage. Keep “Image file,” “Add image,” and “Replace image” accessible names, so existing selectors remain useful. Add drop, keyboard, focus-style, permissions-disclosure, and module-routing assertions. Update tests that intentionally assert the removed effort chip or old module placement.

Run these evidenced commands from the repository root:

```sh
npm run check
npm run lint
npm test
npm run build
npm run verify
```

The packet does not establish whether root tests include every extension suite, nor provide a native desktop launch command. Confirm that coverage during implementation and perform the real macOS drop check; Playwright drops alone cannot prove OS-to-webview delivery.

This approach fits because it removes persistent decoration while preserving OpenPane’s existing visual language and operational controls. Its main tradeoff is that module actions require opening Extensions, and detailed runtime information requires opening conversation details.

I rejected moving all custom tools into global Settings: module actions require an active conversation context, and that placement would obscure their target. The uncertain fact most likely to change this recommendation is whether an installed customization depends on the default layout displaying modules continuously beside the transcript. The packet shows no bundled example; such a dependency would favor a collapsed conversation-tools drawer instead of relocating those actions entirely.
