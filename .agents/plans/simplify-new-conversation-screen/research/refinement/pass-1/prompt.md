Improve this selected implementation design while preserving the user's outcome and constraints. Trace it as a coding agent would. Identify concrete corrections to ownership, interfaces, sequencing, compatibility, error/recovery, observability, or verification. Prefer a smaller coherent correction. Propose another architecture only if evidence shows this one cannot satisfy a hard constraint. Do not implement, use tools, delegate, invoke skills, or edit files. All evidence is in this packet; identify gaps instead of inventing facts.

Map every explicit requirement to a plan location and acceptance criterion; flag missing coverage. Then return findings with priority (blocking/improvement), plan location, supporting source evidence or evidence gap, implementing-agent failure mode, and proposed correction. Omit style-only preferences. If no material findings exist, say `No material findings` after the coverage map.

Additional verified facts (not in the brief):
- `PermissionState` (apps/desktop/src/application/application-controller.ts:41-44): `{kind:'fresh'; listing}` | `{kind:'loading'|'stale'; listing: AvailablePermissions|null; reason}` | `{kind:'unsupported'; reason}`. Initial value (line 148): `{kind:'stale', listing:null, reason:'Open a conversation to read permissions.'}`.
- `ProviderObservationStatus` (packages/contracts/src/observation.ts:19-22): `not-applicable|recovering|observing` | `stopped` | `concluded`; controller adds `{kind:'unknown'}`.
- `CommandActivity`/`FileActivity` return null when empty.
- Tests: journey.browser.test.mjs:238 waits for heading 'Your conversation'; module-actions.browser.test.mjs:27 finds `complementary 'Customization fixture'`, :43/:73 read textbox 'Message' value, :85 reads `.scope-label` textContent; agent-routing.test.mjs:146-147 assert chips ['Codex','Select model','Default'] and the disabled effort button; tests/host/extensions/extension-only.test.mjs:152,159 assert body text lacks /Recorded playback|Recorded host/.
- agent-presentation.ts: codex footer 'Local Codex · Approvals required for changes', buildLabel 'Local Codex host'; recorded footer 'Recorded playback · No live model', buildLabel 'Browser development · Recorded host'.
- BrowserApplication.tsx keeps `app.active` while `selectedView` is 'extensions'; the chat view is hidden via `hidden` on `.shell-view`, not unmounted.

## Selected design rationale (summary)
Base design: "show only what can act" — gate chrome on relevance, move non-empty custom tool modules to the Extensions view, "+" and panel-wide drop for images. Grafted: visually-hidden header (tests/a11y), kind-based permission gate, auto-grow textarea, disclosure moved to shell footer, panel-wide drop target, Extensions tools section names its conversation. Rejected: composer Tools popover (keeps tools on this screen), combined harness/model picker and details drawer (scope), byte sniffing (host is authority), greeting line (calmer without).

## Plan files

### 00-overview.md
# Simplify the new-conversation screen

Status: Ready (pending refinement pass). Implementation has not started.

Base commit: `10a4d08` on `main`.

## Application context

The context was confirmed for this repository on 2026-11-18 in `.agents/plans/extensions-nav-crew-coworkers/00-overview.md` and is reused here. OpenPane has one user, on a private overlay network.

```json
{
  "application_context": {
    "has_active_users": false,
    "backward_compatibility_required": false,
    "feature_flags": "not-applicable",
    "confirmation_digest": "34b9a519ecefc94d75efe4ffa2fc7671cf5c90bb1936dde430a6049a2beb93b4",
    "confirmed_at": "2026-11-18T04:10:00Z"
  }
}
```

The change is a direct UI cutover. It needs no flag and no compatibility shim.

## Change type and affected areas

This is a UI redesign of the desktop conversation panel. It touches these files:

- `apps/desktop/src/application/ConversationView.tsx`
- `ConversationPermissions.tsx`
- `CustomizationModules.tsx`
- `CustomizationContent.tsx`
- `ComposerAgentControls.tsx`
- `ExtensionsView.tsx`
- `application.css`
- `apps/desktop/src/shell/BrowserApplication.tsx`
- `apps/desktop/src-tauri/tauri.conf.json`
- the browser tests under `tests/application/`

## Requested outcome

An empty conversation shows a calm canvas with one composer, and it still looks like OpenPane.

Success criteria. Each is observable in the browser build:

1. An empty Codex conversation shows only the composer: the placeholder, "+", the harness chip, the model chip and Send. The page also shows the shell footer. It does not show a visible header, a Permissions card, "Send a message to begin.", "Custom tools", the disabled effort chip or the in-composer disclosure line.
2. Typing in the composer shows only the caret. The computed `box-shadow` of `.composer` is `none` while the textarea has focus.
3. The textarea has no resize grip (`resize: none`). It grows with its content up to a cap, then scrolls.
4. Dropping a PNG or JPEG anywhere on the conversation panel attaches it. Invalid drops explain why and change nothing.
5. Custom tool modules no longer render on the conversation screen. Non-empty modules appear in the Extensions view. Empty module sets render nothing anywhere.
6. The icon rail and the Chats sidebar are unchanged, in both markup and CSS.

## Scope and non-goals

In scope:

- the conversation panel and its composer;
- the components the panel renders;
- the effort chip in the empty-workspace screen, which shares `ComposerAgentControls`;
- the shell footer's right-hand label while the Chats view is shown.

Not in scope:

- `.view-rail`, `.application-controls` and the Chats list;
- the harness and model picker behaviour;
- a new settings page for tools;
- native (Tauri) file-path drop handling;
- the iOS app;
- pairing or attestation (AGENTS.md).

## Findings that drive the design

- The two empty "Custom tools" boxes come from the crew and coworkers namespaces. Both contribute `modules: []` (`extensions/crew/src/desktop/index.tsx:11`, `extensions/coworkers/src/desktop/index.tsx:11`). `ConversationModules` renders a fieldset regardless (`CustomizationModules.tsx:70-74`).
- The Permissions card renders whenever `permissionState` is set (`ConversationView.tsx:172`). Codex returns `{ kind: 'unsupported' }` (`application-controller.ts:41-44, 272-274`).
- The focus ring is `.composer:focus-within` (`application.css:121`). The grip comes from `resize: vertical` (`application.css:119`).
- The effort chip is hard-wired disabled (`ComposerAgentControls.tsx:97`).
- "Add image" is a text button that opens a hidden input (`ConversationView.tsx:199-210`).
- Tauri's native drag-drop handler is on by default, and the window has no `dragDropEnabled` key (`tauri.conf.json:14`). `main.rs:137` builds the window from that config.
- Tests depend on hidden header parts: `journey.browser.test.mjs:238` waits for the heading "Your conversation", and `module-actions.browser.test.mjs:85` reads `.scope-label`. The effort chip is asserted at `agent-routing.test.mjs:146-147`.

## Selected design: "Show only what can act"

The design began as proposal C (Grok). It adds grafts from A (Opus) and B (Sol). See [research/decision.md](research/decision.md) for the three proposals, the scores and the reasons for each choice.

```text
Before (empty Codex chat)                After
┌───────────────────────────────┐        ┌───────────────────────────────┐
│ Your conversation             │        │                               │
│ GPT-6.2 Sol                   │        │                               │
│───────────────────────────────│        │                               │
│ ┌ Permissions ──────────────┐ │        │  ╭─────────────────────────╮  │
│ │ does not report… [Refresh]│ │        │  │ Write to Codex…▍        │  │
│ └───────────────────────────┘ │        │  │                         │  │
│ Send a message to begin.      │        │  │ +   Codex ⌄ GPT-6.2 ⌄ ↑ │  │
│ ┌ Custom tools ─────────────┐ │        │  ╰─────────────────────────╯  │
│ └───────────────────────────┘ │        │                               │
│ ┌ Custom tools ─────────────┐ │        │                               │
│ └───────────────────────────┘ │        │                               │
│ ╔═══════════════════════════╗ │ ring   │                               │
│ ║ Write to Codex…        ⟋  ║ │ grip   │                               │
│ ║ [Add image]               ║ │        │                               │
│ ║ Codex⌄ GPT⌄ Default⌄ Send ║ │        │                               │
│ ║ Local Codex · Approvals…  ║ │        │                               │
│ ╚═══════════════════════════╝ │        │                               │
│ ● Conversation connected  Local Codex host │ ● Conversation connected  Local Codex · Approvals required for changes │
└───────────────────────────────┘        └───────────────────────────────┘
```

Once the conversation has content, the transcript scrolls and the same composer sits at the bottom. A pending image is a compact chip inside the composer.

The table shows where each removed element goes:

| Element | Destination |
|---|---|
| Header (h1, agent label, scope) | Kept in the DOM but visually hidden. The model chip already shows the agent. |
| Permissions card | Rendered only when the provider supports permissions. Its region, labels and buttons are unchanged ([02](02-permissions-and-tools.md)). |
| "Send a message to begin." | Removed. The placeholder invites input. |
| Custom tools | Empty sets render nothing. Non-empty sets move to the Extensions view. Load and failure notices stay in the column ([02](02-permissions-and-tools.md)). |
| Add image | Replaced by a "+" icon button and drag and drop on the panel ([03](03-image-drop.md)). |
| Effort chip | Removed. |
| Composer disclosure | Moved to the shell footer's right side on the Chats view. |
| Ring and grip | Removed. The textarea auto-grows ([01](01-composer-chrome.md)). |

## Review coverage

| Stage | Result |
|---|---|
| Proposals | All three seats completed (`research/proposals/pass-1`). |
| Refinement | Recorded in `research/refinement/`. The reviewed packet's SHA-256 is recorded there. |

## Risks and assumptions

- **Assumption:** with `dragDropEnabled: false`, the macOS WKWebView delivers HTML5 `File` objects. If not, the "+" picker still works. The fallback is a native-path drop, which is a separate change. Gate: a manual Finder-to-composer drop in `npm run desktop:dev` ([04](04-execution-handoff.md) WP4).
- **Assumption:** nothing in the app listens for `tauri://drag-drop`. Gate: `grep -rn "drag-drop\|onDragDropEvent" apps/desktop` returns nothing.
- **Tradeoff (non-blocking):** module actions in Extensions run against the active conversation while it is off screen. The section names that conversation.
- **Product choice (non-blocking):** the empty canvas has no greeting line. Proposal A's greeting ("A conversation that stays with you.") can be added later as a single element.

## Document map

| File | Purpose |
|---|---|
| [01-composer-chrome.md](01-composer-chrome.md) | Ring, grip, auto-grow, hidden header, empty-state centring, effort chip, footer disclosure. |
| [02-permissions-and-tools.md](02-permissions-and-tools.md) | The permissions gate, and moving custom tools to the Extensions view. |
| [03-image-drop.md](03-image-drop.md) | The "+" button, drag and drop on the panel, validation, and the Tauri setting. |
| [04-execution-handoff.md](04-execution-handoff.md) | Ordered work packages, commands, and the definition of done. |
| [research/](research/) | The brief, the decision record, the three proposals and the refinement record. |

### 01-composer-chrome.md
# 01 — Composer and panel chrome

## Goal

The conversation panel shows a transcript and one quiet composer. While a conversation is empty, the composer sits in the vertical centre. When the conversation has content, the composer is pinned to the bottom.

## Evidence

- `ConversationView.tsx:155-156`: the `<section className="conversation-panel">` contains a `<header>` with the eyebrow, h1 "Your conversation", `.agent-label` and `.scope-label`. CSS already hides the eyebrow and scope (`application.css:93`).
- `ConversationView.tsx:137`: the paragraph "Send a message to begin." (with a recorded-demo variant).
- `ConversationView.tsx:188`: `<textarea rows={3}>`.
- `ConversationView.tsx:213-216`: `.composer-footer` holds the agent controls, the Send/Stop buttons and `<p className="composer-disclosure">{presentation.footer}</p>`.
- `ComposerAgentControls.tsx:97`: the disabled effort button. `agent-routing.test.mjs:146-147` asserts that it exists.
- `application.css:6`: the outline list includes `.composer textarea:focus-visible`. Line 120 then sets `outline: none` on the same selector.
- `application.css:119`: `resize: vertical; min-height: 54px; max-height: 160px`. Line 121: `.composer:focus-within { box-shadow: 0 0 0 2px var(--aui-color-accent); }`.
- `BrowserApplication.tsx:178`: `buildLabel={presentation.buildLabel}`. The shell renders it on the footer's right (`Shell.tsx:99`).
- `CommandActivity` and `FileActivity` return `null` when there is no activity (`CommandActivity.tsx:6`, `FileActivity.tsx:6`).

## Changes

### `ConversationView.tsx`

1. **Header.** Change `<header>` to `<header className="visually-hidden">`. Keep its children unchanged, so tests and the heading outline stay intact. Remove the `border-bottom` rule at `application.css:92`.
2. **Empty-state paragraph.** Delete the paragraph at line 137.
3. **Empty predicate** (proposed local `const empty`). The panel is empty only when all of these hold:
   - `view.document.domain.messages.length === 0`;
   - `!continuation`;
   - `Object.keys(view.document.decisions).length === 0`;
   - `observationStatus` is absent or its kind is `'not-applicable'` or `'observing'`. These are the kinds that render no notice. `ProviderObservationStatus` is defined at `packages/contracts/src/observation.ts:19-22`, and the controller adds `'unknown'` at `application-controller.ts:37`;
   - `active.agent.availability.kind === 'ready'`;
   - `transcript.kind !== 'claimed'` and `contentLayout.kind !== 'claimed'`;
   - the permissions panel is not shown (see [02](02-permissions-and-tools.md)).

   Set `data-empty={empty ? 'true' : undefined}` on the section. Leave everything else in the panel as it is.
4. **Composer disclosure.** Delete `<p className="composer-disclosure">`. Its text moves to the footer (see below).
5. **Textarea.**
   - Change it to `rows={1}`.
   - Add an auto-grow `useLayoutEffect` keyed on `editor.text`. It sets `style.height = 'auto'`, then `style.height = min(scrollHeight, cap)`. The cap comes from CSS `max-height`.
   - Keep `id="message"`, the `<label htmlFor="message">Message</label>`, `readOnly` and `placeholder`.
6. **Send button.**
   - Keep the `<button>` as the form submitter.
   - Add `className="composer-send"`, `aria-label="Send"` and an up-arrow SVG (`aria-hidden`). The visible text "Send" may become the icon.
   - Stop keeps its visible text.

   Implementation step: grep tests for `name: 'Send'`. Accessible-name queries keep working because of the `aria-label`.

### `ComposerAgentControls.tsx`

- Delete the effort `<button>` at line 97.
- Update `agent-routing.test.mjs:146-147` to expect `['Codex', 'Select model']` and no effort button.

### `BrowserApplication.tsx`

- At line 178, pass `buildLabel={selectedView === 'chats' && app.active ? presentation.footer : presentation.buildLabel}`.
- Other views, and the state with no conversation, keep `buildLabel`.
- Check `tests/host/extensions/extension-only.test.mjs:152,159`. They assert that the body has no "Recorded playback|Recorded host". In the extension-only host the presentation is a provider, so `presentation.footer` is a provider string. Confirm this when the test runs.

### `application.css`

Change only selectors scoped to `.conversation-panel` or `.composer`:

| Line | Change |
|---|---|
| 6 | Remove `.composer textarea:focus-visible` from the outline list. |
| 92 | `.conversation-panel > header` loses its padding and border. The `visually-hidden` class handles the rest. |
| 119 | Set `resize: none; overflow-y: auto; min-height: 24px; max-height: 40vh`. |
| 121 | Delete the `.composer:focus-within` rule. |
| 133 | Scope the accent fill to `.composer-send` (a round 32px button). Other footer buttons (the "+" in [03](03-image-drop.md), and Stop) use the transparent `.composer-setting` look. |
| 237 and 239 | Delete `.composer-effort` and `.composer-disclosure`. |

Add these rules:

- `.conversation-panel[data-empty="true"] { justify-content: center; }`
- `.conversation-panel[data-empty="true"] .conversation-content { flex: none; min-height: 0; }`
- `.conversation-panel[data-empty="true"] .transcript { padding: 0; min-height: 0; }`

Button `:focus-visible` outlines (lines 6 and 252) stay, so keyboard focus remains visible on every control except the textarea.

### Empty workspace (`BrowserApplication.tsx:72-77`)

No markup change. It loses the effort chip because it shares `ComposerAgentControls`. It has no textarea, so the ring and grip changes do not apply.

## Acceptance

1. An empty Codex conversation has `data-empty="true"`. The composer's vertical centre is within 10% of the panel's centre.
2. None of these are visible: the heading "Your conversation", "Send a message to begin.", the effort button, `.composer-disclosure`.
3. `getByRole('heading', { name: 'Your conversation' })` still exists. `journey.browser.test.mjs:238` passes with `waitFor({ state: 'attached' })`; change the call if the visible state fails.
4. With the textarea focused, `getComputedStyle(composer).boxShadow === 'none'`, and the textarea's `resize` is `'none'`.
5. When ten lines are typed, the textarea height grows, stops at `40vh`, and then scrolls.
6. When "Send" (the accessible name) is enabled, it submits as before.
7. The footer reads "Conversation connected" and "Local Codex · Approvals required for changes" while a Codex chat is open in the Chats view.
8. After the first message is sent, `data-empty` is removed and the composer is at the bottom.

## Exclusions

- No greeting line.
- No changes to the picker.
- No changes to `.view-rail` or `.application-controls`.

### 02-permissions-and-tools.md
# 02 — Permissions gate and custom tools relocation

## Goal

The conversation column shows permissions only when a provider supports them. Custom tool modules leave the conversation screen. Non-empty module sets move to the Extensions view, and empty sets render nothing.

## Evidence

- `PermissionState` (`application-controller.ts:41-44`) has four kinds:
  - `fresh` with a listing;
  - `loading` with a listing or null and a reason;
  - `stale` with a listing or null and a reason;
  - `unsupported` with a reason.

  The initial state is `stale` with a null listing and the reason "Open a conversation to read permissions." (line 148).
- `ConversationPermissions` adds a window-focus refresh listener while it is mounted (`ConversationPermissions.tsx:15-19`).
- The Crew browser test (`extensions/crew/tests/provider.test.mjs:915-950`) locates `region "Permissions"` and clicks "Refresh permissions".
- `CustomizationModules` renders loading and failure text plus `ConversationModules`, which renders `<fieldset><legend>Custom tools</legend>` for every module list, even an empty one (`CustomizationModules.tsx:63-91`).
- `CustomizationContent` places `modules` after the transcript in its default and conflict fallbacks (`CustomizationContent.tsx:12`). A claimed layout receives `modules` as a prop (line 20).
- `BrowserApplication.tsx`:
  - lines 54-55 build `modules` from `custom.namespaces`;
  - line 61 passes them through `conversationSlots`, which sets `modules: null` inside an extension workspace;
  - line 136 renders `{!app.active && modules}` under the empty workspace;
  - line 95 renders `<ExtensionsList rows enabled onOpen>`.
- These tests assert the alert "Custom tools could not load.":
  - `frontend-tools.browser.test.mjs:111,157`
  - `journey.browser.test.mjs:642,661`
  - `transcript-overrides.browser.test.mjs:181`
- `module-actions.browser.test.mjs:27-86` finds modules through `complementary "Customization fixture"` and runs actions while it reads the composer's `Message` value and `.scope-label`.

## Permissions

The permissions panel is shown only for these states:

| State | Shown? |
|---|---|
| `unsupported` | No |
| `loading` or `stale` with a null listing | No |
| `fresh` | Yes |
| `loading` or `stale` with a non-null listing | Yes |

Changes:

- Add a new export to `ConversationPermissions.tsx`: `permissionsShown(state: PermissionState): boolean`. It returns `state.kind !== 'unsupported' && 'listing' in state && state.listing !== null`.

  Design note: a `stale` state with a null listing hides the panel. The cause may be an error before the first listing was read (for example, "Revocation failed. Refresh permissions."). Implementation step: check whether the controller can reach `stale`/null after a failed first read. If it can, also show the panel when the reason differs from the initial placeholder reason. If that needs reason-string matching, show the panel for any `stale` state with a null listing once the first read has started. Refinement decides.
- In `ConversationView.tsx`, change line 172 to `{permissionState && permissionsShown(permissionState) && <ConversationPermissions …/>}`. Move it below the decision cards, directly above the composer.
- In `application.css`, make `.permissions-panel` compact:
  - padding `10px 12px`;
  - no `margin-top` beyond `8px`;
  - the border stays (it is an actionable card when shown).

Region names, button labels and the revoke flow do not change.

## Custom tools

### `CustomizationModules.tsx`

- `ConversationModules` returns `null` when `modules.length === 0`.
- Add a new prop to `CustomizationModules`: `surface: 'status' | 'tools'`.
  - `status` renders only the loading and failed text. The failed alert keeps the text "Custom tools could not load. … Use Restore default view to continue without them." The `<aside>` keeps its `aria-label` and `data-customization-*` attributes.
  - `tools` renders only the ready modules. It renders nothing when the namespace is not ready or has no modules.
- A claimed content layout still needs the full set. Add `surface: 'all'`, which keeps today's behaviour minus empty fieldsets.

### `CustomizationContent.tsx`

No signature change. `BrowserApplication` decides which nodes it receives as `modules`.

### `BrowserApplication.tsx`

Build three lists from `custom.namespaces`:

| List | Surface |
|---|---|
| `moduleStatus` | `surface="status"` |
| `moduleTools` | `surface="tools"` |
| `moduleAll` | `surface="all"` |

Then route them:

- **Claimed content layout.** When `slots.contentLayout.kind === 'claimed'`, pass `modules={moduleAll}`. The layout owns placement, as today.
- **Default or conflict layout.** Pass `modules={moduleStatus}`. Only notices stay in the column.
- **`conversationSlots`.** Pass the chosen list instead of `modules`. Inside a workspace it still returns `modules: null`.
- **Empty workspace (line 136).** Replace `{!app.active && modules}` with `{!app.active && moduleStatus}`. Modules cannot run without a conversation, but load failures stay visible.
- **Extensions list.** Pass `<ExtensionsList … tools={app.active && slots.contentLayout.kind !== 'claimed' ? moduleTools : null} conversation={app.active ? conversationLabel(…) : null} />`.

  Implementation step: get the label from the active catalog entry. If the active conversation is not in the catalog, fall back to `active.scope.conversationId`.

### `ExtensionsView.tsx`: `ExtensionsList`

- Add new optional props: `tools?: ReactNode` and `conversation?: string | null`.
- Render `<section className="conversation-tools" aria-label="Conversation tools"><h2>Conversation tools</h2><p>Runs in {conversation}.</p>{tools}</section>` after the list. Render it only when at least one ready namespace has a non-empty `modules` array.

  Compute this as `hasTools` in `BrowserApplication` from `custom.namespaces` (`kind === 'ready' && presentation.modules.length > 0`) and pass it in. Testing for a truthy ReactNode is not enough: an array of null-rendering elements is truthy.

### `application.css`

- `.extensions-panel .customization-panel { max-height: none; overflow: visible; }`
- `.conversation-tools { margin-top: 24px; }`
- `.customization-modules` keeps its border inside Extensions.

## Test updates

- **`module-actions.browser.test.mjs`.**
  - Before locating `complementary "Customization fixture"`, click the rail button "Extensions".
  - Click "Chats" again before asserting the `Message` value. Hidden inputs still report `inputValue`, so this step is only needed for visibility checks.
  - `.scope-label` stays in the hidden header (see [01](01-composer-chrome.md)).
- **Alert tests.** `frontend-tools`, `journey` and `transcript-overrides` should pass unchanged, because the failed alert stays in the column.
- **Content-layout tests.** `content-layout.browser.test.mjs` and `content-layout-image.browser.test.mjs` should pass unchanged, because claimed layouts still get `moduleAll`.
- **Crew provider test.** It should pass unchanged. The region appears once the listing is fresh. If the test queries the region before the first read finishes, it already waits (line 927 onwards). Confirm when it runs.

## Acceptance

1. In a Codex conversation there is no `region "Permissions"`.
2. In a Crew conversation with grants there is a `region "Permissions"` above the composer, and both revoke paths and "Refresh permissions" work.
3. No `group`/`fieldset` with the legend "Custom tools" exists on the Chats view for crew or coworkers.
4. With the module-actions fixture:
   - Chats shows no module buttons.
   - Extensions shows "Conversation tools", "Runs in …", and the fixture's buttons.
   - Running an action there updates the conversation, which is visible after you return to Chats.
5. When a customization fails to load, the alert "Custom tools could not load." still appears in the conversation column.
6. A claimed content layout still renders the modules it receives.

### 03-image-drop.md
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
  | a known item type that is not PNG or JPEG | reject: "Drop a PNG or JPEG image." |
  | anything else | accept (an unknown type is checked on drop) |

- `intakeFile(files: readonly File[]): { kind: 'file'; file: File } | { kind: 'reject'; reason: string }`

  It checks three things:
  - **Count.** Exactly one file.
  - **Type.** `file.type` must be `image/png` or `image/jpeg`. If `file.type` is empty, the name must end in `.png`, `.jpg` or `.jpeg`.
  - **Size.** At most `IMAGE_MAX_BYTES`, using the existing message "Choose an image of at most 4 MB."

  The host remains the authority on content.

### `ConversationView.tsx`

1. **One attach path.** Add `attach(files)`, which calls `imageAction(async () => { const r = intakeFile(files); if (r.kind === 'reject') throw new Error(r.reason); await active.store.selectImage({ name: r.file.name, bytes: new Uint8Array(await r.file.arrayBuffer()) }); })`. Both the file input's `onChange` and the drop handler call it.
2. **Block reason** (proposed `blocked: string | null`). It mirrors the existing disabled conditions. The first match wins:

   | Condition | Reason |
   |---|---|
   | `!acceptsImages` | the agent's `imageInput.reason`, or "This agent cannot receive images." |
   | `storageFailure` | "Images can't be attached while drafts can't be saved." |
   | `!enabled` | "Connect to your host to attach an image." |
   | `image?.status === 'uploading'` | "Wait for the current upload to finish." |

3. **Drop zone.** Add `onDragEnter`, `onDragOver`, `onDragLeave` and `onDrop` to the `<section className="conversation-panel">`.
   - A depth counter in a ref tracks enter and leave. `drop` and `dragend` reset it to 0.
   - For a file drag, `preventDefault` is always called so the webview never navigates to the file. `dropEffect` is `'copy'` for accept and `'none'` for reject.
   - On drop, an accepted drag calls `attach([...dataTransfer.files])`. A rejected drag sets `imageError` with the reason.
   - Store the local state as `drop: { kind: 'idle' } | { kind: 'over'; verdict }`.
4. **Composer feedback.**
   - Set `data-drop="accept"` or `data-drop="reject"` on `form.composer` while a drag is over the panel.
   - Show `<p className="composer-drop-hint" aria-hidden="true">` inside the composer. It reads "Drop to attach image", "Drop to replace {name}" when an image is already attached, or the reject reason.
   - Screen readers get nothing new during the drag. The outcome is announced by the existing status and alert.
5. **"+" button.**
   - It is the first item in `.composer-footer`, before `composerControls`.
   - It renders only when `acceptsImages`.
   - Markup: `<button type="button" className="composer-setting composer-add" aria-label={image ? 'Replace image' : 'Add image'} title="Add image, or drop a PNG or JPEG">` with a plus SVG.
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
- Delete `.composer-attachments` row styling that is no longer used.

### `apps/desktop/src-tauri/tauri.conf.json`

Add `"dragDropEnabled": false` to `app.windows[0]`. `main.rs` needs no change, because `WebviewWindowBuilder::from_config` reads this key.

## Drop states

| State | Trigger | Visual | Effect |
|---|---|---|---|
| Idle | none | none | none |
| Over, accept | One PNG/JPEG (or unknown type) and not blocked | A dashed accent outline on the composer, plus a hint | `dropEffect` is `copy` |
| Over, reject | A blocked reason, several files, or the wrong type | A dashed muted outline, plus the reason | `dropEffect` is `none`; a drop sets the alert |
| Rejected after drop | Too large, or the wrong type that was unknown during the drag | The outline clears and `role="alert"` shows the reason | `selectImage` is not called; the draft and the existing image are unchanged |
| Uploading | `view.image.status === 'uploading'` | The chip shows "Uploading…" and "+" is disabled | New drags are rejected with "Wait for the current upload to finish." |
| Ready | `status === 'ready'` | The chip shows "Ready" and ×, and Send is enabled even with no text | Send works as before |
| Failed or interrupted | Upload error | The chip shows the reason and Retry, plus × | `retryImage` / `removeImage` work as before; a new drop replaces the image |

## Tests

Extend `tests/application/composer-image.browser.test.mjs`. Build a `DataTransfer` in the page through `page.evaluateHandle`, then dispatch `dragenter`, `dragover` and `drop` on `.conversation-panel`. Cover these cases:

- A valid PNG reaches "Ready". During `dragover`, `data-drop` is `accept`.
- A GIF gives `data-drop="reject"`. After the drop, the alert reads "Drop a PNG or JPEG image." and no chip appears.
- A file of 4 MB + 1 byte gives the alert "Choose an image of at most 4 MB."
- Two files give the alert "Drop one image at a time."
- A drop during an upload gives the alert "Wait for the current upload to finish."
- A text drag (`text/plain` only) leaves `data-drop` unset.

These tests should pass unchanged:

- the existing picker tests (`Image file`, "Add image", "Replace image");
- `content-layout-image.browser.test.mjs:67`;
- `selective-activity.browser.test.mjs:207`.

## Acceptance

1. Each of the six cases above passes in the browser build.
2. In `npm run desktop:dev` on macOS, dragging a PNG from Finder onto the transcript area attaches it. Dropping a file outside the panel does not navigate the window.
3. Tab reaches "Add image", and Enter opens the file chooser.

## Exclusions

- No native path-based drop.
- No multiple pending images.
- No paste-from-clipboard (it could be a follow-up).

### 04-execution-handoff.md
# 04 — Execution handoff

Work on a feature branch off `main`, for example `simplify-conversation-screen`. Do not edit `.view-rail` or `.application-controls` markup or CSS.

## Work packages

### WP1 — Composer chrome
**Prerequisites:** none.
**Spec:** [01](01-composer-chrome.md).

Files and symbols:
- `ConversationView.tsx`: hidden header, `data-empty`, removal of the empty-state line and the disclosure, auto-grow textarea, `composer-send`.
- `ComposerAgentControls.tsx:97`: remove the effort chip.
- `BrowserApplication.tsx:178`: `buildLabel`.
- `application.css`.
- `tests/application/agent-routing.test.mjs:146-147`.
- `journey.browser.test.mjs:238`, only if the visibility wait fails.

Verify:

```bash
npm run check
```

```bash
node --test tests/application/agent-routing.test.mjs tests/application/journey.browser.test.mjs tests/application/composer-image.browser.test.mjs
```

### WP2 — Permissions gate
**Prerequisites:** WP1, because both edit the same area of `ConversationView`.
**Spec:** [02](02-permissions-and-tools.md) § Permissions.

Files and symbols:
- `ConversationPermissions.tsx`: new `permissionsShown`.
- `ConversationView.tsx`: the line that mounts the panel and its position.
- CSS for `.permissions-panel`.

Verify:

```bash
node --test extensions/crew/tests/provider.test.mjs
```

### WP3 — Custom tools to Extensions
**Prerequisites:** WP1.
**Spec:** [02](02-permissions-and-tools.md) § Custom tools.

Files and symbols:
- `CustomizationModules.tsx`: `surface`, and a null result for empty sets.
- `BrowserApplication.tsx`: the three lists, their routing and `hasTools`.
- `ExtensionsView.tsx`: `ExtensionsList` gains `tools`, `conversation` and `hasTools`.
- CSS.
- `module-actions.browser.test.mjs`.

Verify:

```bash
node --test tests/application/module-actions.browser.test.mjs tests/application/frontend-tools.browser.test.mjs tests/application/content-layout.browser.test.mjs tests/application/extensions-view.browser.test.mjs extensions/coworkers/tests/desktop.browser.test.mjs
```

### WP4 — Image drop
**Prerequisites:** WP1, which owns the composer footer layout.
**Spec:** [03](03-image-drop.md).

Files and symbols:
- `image-intake.ts` (new).
- `ConversationView.tsx`: `attach`, `blocked`, the drop handlers, the "+" button, and the chip moved above the textarea.
- CSS.
- `tauri.conf.json`.
- `composer-image.browser.test.mjs`: the new drop cases.

Pre-check, which must print nothing:

```bash
grep -rn "drag-drop\|onDragDropEvent" apps/desktop
```

Verify:

```bash
node --test tests/application/composer-image.browser.test.mjs tests/application/content-layout-image.browser.test.mjs tests/application/selective-activity.browser.test.mjs
```

Manual check: run `npm run desktop:dev`, then drop a PNG from Finder onto the transcript. Then drop a file onto the sidebar and confirm the window does not navigate.

## Parallelism

WP2, WP3 and WP4 all edit `ConversationView.tsx` and `application.css`, so run them one after another after WP1. WP3 also touches `BrowserApplication.tsx` and `ExtensionsView.tsx`, and it can be developed alongside WP4 only in separate worktrees that are merged in order.

## Integration gate

Run from the repo root:

```bash
npm run verify
```

This runs build, check, lint and test.

Then compare against the screenshots in the request. Open the browser build with `npm run host:browser-dev` after `npm run build`, and open a Codex conversation in dark appearance. Capture these screenshots:
- the empty state;
- an active conversation with one pending image;
- a Crew conversation with grants.

Regression checks:
- the rail and sidebar are pixel-identical to before, compared by screenshot;
- light appearance still renders correctly;
- at 520px width the composer does not overflow.

## Definition of done

- Every acceptance item in 01, 02 and 03 passes.
- `npm run verify` is green.
- The manual Tauri drop check is done and reported. If it fails, report that the "+" fallback works, and file a follow-up for native path drops.
- `git diff main -- apps/desktop/src/application/application.css` shows no changed `.view-rail` or `.application-controls` rules.
- No untracked generated test artifacts are committed.

## Deferred and follow-ups

- Optional greeting line on the empty canvas (proposal A).
- Paste an image from the clipboard into the composer.
- A native-path drop fallback, if WKWebView does not deliver `File` objects.
- A per-host effort setting, which would reintroduce the effort chip once a host offers it.

---
# Research brief (source evidence, trimmed: removed rail CSS, picker/presentation/shell excerpts, test excerpts — their relevant facts are listed above)
## Request (user, 2026-11-21)
"Compared to these other platforms our new conversation screen is so busy. Please redesign it to make it simpler and remove this text box highlight when I start typing a prompt. The blinking cursor is sufficient UX. We also want to get rid of that resize handle. Add photo should be drag and drop. Custom tools should be configured elsewhere. Come up with some designs that still look like OpenPane but clean up some of the clutter on this screen. Leave the left two vertical navigation panes alone. Focus only on this new conversation screen and things that use its components."

### Current screen (screenshot, Codex conversation, dark appearance), top to bottom in the main column
1. Header: "Your conversation" (h1) and "GPT-6.2 Sol" (agent label), with a bottom border.
2. Bordered "Permissions" card: "This conversation does not report permissions." + "Refresh permissions" button (Codex returns `unsupported`).
3. "Send a message to begin." empty-state text.
4. Two empty bordered fieldsets each with legend "Custom tools" (one per bundled extension namespace: crew and coworkers, both of which contribute `modules: []`).
5. Composer (rounded, raised background) with a 2px accent ring while focused (`.composer:focus-within`), a textarea with a visible vertical resize grip, an "Add image" button row, a footer row: "Codex ⌄", "GPT-6.2 Sol ⌄", disabled "Default ⌄" (effort), "Send" pill, then disclosure "Local Codex · Approvals required for changes".
6. Shell footer strip: "● Conversation connected" (left) and "Local Codex host" (right).

### apps/desktop/src/application/ConversationView.tsx
```tsx
     1	import { canRetryObservation } from '@openpane/contracts';
     2	import type { ConversationClosure, ObservationStopReason } from '@openpane/contracts';
     3	import { IMAGE_MAX_BYTES } from '@openpane/contracts/image';
     4	import { useEffect, useRef, useState, type ReactNode } from 'react';
     5	import { useConversation } from '@openpane/client/react';
     6	import type { ConversationActions, ConversationContinuation, OpenConversation, ConversationObservation, PermissionState } from './application-controller.js';
     7	import { ContinuationChoices, ContinuationHistory } from './ContinuationNotice.js';
     8	import { ConversationPermissions } from './ConversationPermissions.js';
     9	import { CommandRecovery } from './CommandRecovery.js';
    10	import { recoveryModel } from './recovery.js';
    11	import { AGENT_PRESENTATION, agentPresentation } from './agent-presentation.js';
    12	import { conversationResponding } from './responding.js';
    13	import { FileActivity } from './FileActivity.js';
    14	import { CommandActivity } from './CommandActivity.js';
    15	import { AssistantReply } from './AssistantReply.js';
    16	import { CustomizationActivity, CustomizationTranscript, type ActivitySelection, type ContentLayoutSelection, type TranscriptSelection } from './DesktopCustomizations.js';
    17	import { CustomizationContent } from './CustomizationContent.js';
    18	import { ImageAttachmentCard, imageSize } from './ImageAttachmentCard.js';
    19	
    20	const OBSERVATION_NOTICE: Record<ObservationStopReason, string> = {
    21	  'unsupported': 'This provider does not support live updates.',
    22	  'snapshot-unavailable': 'The provider could not refresh this conversation.',
    23	  'invalid-projection': 'The provider’s saved state or updates could not be validated.',
    24	  'recovery-failed': 'The provider could not resume updates.',
    25	  'retry-exhausted': 'Updates stopped after repeated gaps without progress.',
    26	  'provider-disconnected': 'The provider stopped delivering updates.',
    27	  'original-provider-unavailable': 'Restore this conversation’s original provider configuration to resume updates.',
    28	  'original-credentials-unavailable': 'Restore this conversation’s original provider credentials to resume updates.',
    29	  'original-binding-unavailable': 'This conversation’s original provider binding is unavailable. Restore its original configuration.',
    30	  'cleanup-failed': 'The previous observer could not close safely. Restart the host before resuming updates.',
    31	};
    32	const CLOSURE_NOTICE: Record<ConversationClosure, string> = {
    33	  cancelled: 'it was stopped',
    34	  failed: 'the provider reported a failure',
    35	  exhausted: 'it reached its turn limit',
    36	};
    37	
    38	type DraftEditor =
    39	  | { readonly kind: 'saved' | 'saving'; readonly text: string }
    40	  | { readonly kind: 'failed'; readonly text: string; readonly message: string };
    41	
    42	export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
    43	  const view = useConversation(active.store);
    44	  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
    45	}
    46	
    47	export function ConversationView({ actions, active, enabled, storageFailure, observation = null, continuation = null, permissionState, agent = 'recorded', composerControls, transcript = { kind: 'default' }, activity = { kind: 'default' }, contentLayout = { kind: 'default' }, modules = null }: {
    48	  readonly actions: ConversationActions; readonly active: OpenConversation; readonly enabled: boolean; readonly storageFailure: string; readonly agent?: keyof typeof AGENT_PRESENTATION;
    49	  readonly permissionState?: PermissionState;
    50	  readonly observation?: ConversationObservation | null;
    51	  readonly continuation?: ConversationContinuation | null;
    52	  readonly transcript?: TranscriptSelection;
    53	  readonly activity?: ActivitySelection;
    54	  readonly contentLayout?: ContentLayoutSelection;
    55	  readonly modules?: ReactNode;
    56	  readonly composerControls?: (canSwitch: boolean) => ReactNode;
    57	}) {
    58	  const presentation = 'kind' in active.agent ? agentPresentation(active.agent).presentation : AGENT_PRESENTATION[agent];
    59	  const view = useConversation(active.store);
    60	  const [editor, setEditor] = useState<DraftEditor>({ kind: 'saved', text: view.draft });
    61	  const editVersion = useRef(0);
    62	  const stopGuard = useRef<{ readonly store: OpenConversation['store']; readonly runId: string } | null>(null);
    63	  const approvalGuards = useRef(new Map<OpenConversation['store'], Set<string>>());
    64	  const [approving, setApproving] = useState<ReadonlySet<string>>(new Set());
    65	  const [stopPending, setStopPending] = useState<typeof stopGuard.current>(null);
    66	  const imageInput = useRef<HTMLInputElement>(null);
    67	  const composer = useRef<HTMLTextAreaElement>(null);
    68	  const arrived = continuation?.arrived ?? null;
    69	  useEffect(() => {
    70	    // The click that led here removed its own control; focus the user moved elsewhere is left alone.
    71	    if (arrived && (document.activeElement === null || document.activeElement === document.body)) composer.current?.focus();
    72	  }, [arrived]);
    73	  const [imageError, setImageError] = useState<{ readonly store: OpenConversation['store']; readonly message: string } | null>(null);
    74	  useEffect(() => {
    75	    setEditor(previous => previous.kind === 'saved' && previous.text !== view.draft ? { kind: 'saved', text: view.draft } : previous);
    76	  }, [view.draft]);
    77	  async function edit(value: string): Promise<void> {
    78	    const version = ++editVersion.current;
    79	    setEditor({ kind: 'saving', text: value });
    80	    try {
    81	      await active.store.setDraft(value);
    82	      if (version === editVersion.current) setEditor({ kind: 'saved', text: active.store.getSnapshot().draft });
    83	    } catch (error) {
    84	      if (version === editVersion.current) setEditor({ kind: 'failed', text: value,
    85	        message: error instanceof Error ? error.message : 'Your draft could not be saved.' });
    86	    }
    87	  }
    88	  const observationStatus = observation?.status;
    89	  const paused = observationStatus?.kind === 'stopped';
    90	  const concluded = observationStatus?.kind === 'concluded';
    91	  const available = active.agent.availability.kind === 'ready';
    92	  const connected = enabled && available && view.connection.kind === 'connected';
    93	  const live = presentation.live;
    94	  const run = live ? view.document.domain.currentRun : null;
    95	  const responding = conversationResponding(agent, view.document.domain);
    96	  const retainedCancel = run && view.outbox.some(entry => entry.command.body.kind === 'cancel' && entry.command.body.runId === run.runId);
    97	  const stopping = run?.kind === 'stopping' || Boolean(retainedCancel) ||
    98	    (stopPending?.store === active.store && stopPending.runId === run?.runId);
    99	  function stop(): void {
   100	    if (!connected || !active.agent.commands.includes('cancel') || run?.kind !== 'running' || stopping ||
   101	      (stopGuard.current?.store === active.store && stopGuard.current.runId === run.runId)) return;
   102	    const target = { store: active.store, runId: run.runId };
   103	    stopGuard.current = target;
   104	    setStopPending(target);
   105	    void actions.submit(() => target.store.cancel(target.runId)).finally(() => {
   106	      if (stopGuard.current === target) {
   107	        stopGuard.current = null;
   108	        setStopPending(null);
   109	      }
   110	    });
   111	  }
   112	  function approve(pendingId: string, choiceId: string): void {
   113	    const store = active.store, decision = store.getSnapshot().document.decisions[pendingId];
   114	    const guards = approvalGuards.current.get(store) ?? new Set<string>();
   115	    if (!connected || !active.agent.commands.includes('approve') || !decision || decision.reserved || guards.has(pendingId)) return;
   116	    guards.add(pendingId);
   117	    approvalGuards.current.set(store, guards);
   118	    setApproving(new Set(guards));
   119	    void actions.submit(() => store.approve(pendingId, choiceId)).finally(() => {
   120	      guards.delete(pendingId);
   121	      setApproving(new Set(guards));
   122	    });
   123	  }
   124	  const image = view.image;
   125	  const acceptsImages = active.agent.imageInput.kind === 'supported' && active.agent.commands.includes('send');
   126	  const canSend = connected && !concluded && active.agent.commands.includes('send') && !responding && editor.kind === 'saved' &&
   127	    (image ? image.status === 'ready' && acceptsImages : Boolean(editor.text.trim()));
   128	  const sentImages = view.document.domain.messages.flatMap(message => message.image ? [{ messageId: message.messageId, image: message.image }] : []);
   129	  function imageAction(operation: () => Promise<void>): void {
   130	    const store = active.store;
   131	    setImageError(null);
   132	    void operation().catch((error: unknown) => setImageError({ store, message: error instanceof Error ? error.message : 'The image could not be changed.' }));
   133	  }
   134	  const conversationKey = `${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`;
   135	  const context = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
   136	  const nativeMessages = <>
   137	      {view.document.domain.messages.length === 0 && <p className="empty-state">{agent === 'recorded' ? 'Send a message to begin this recorded demonstration.' : 'Send a message to begin.'}</p>}
   138	      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
   139	        <strong>{message.role === 'user' ? 'You' : presentation.assistant}</strong>
   140	        {message.role === 'assistant' ? <AssistantReply text={message.text} /> : message.text && <p>{message.text}</p>}
   141	        {message.image && <ImageAttachmentCard attachment={message.image} read={actions.readImage} />}
   142	        {!message.complete && <span className="progress-label">{concluded ? 'Did not finish' : paused ? 'Updates paused' : agent === 'recorded' ? 'Recorded response in progress…' : 'Responding…'}</span>}
   143	      </article>)}
   144	    </>;
   145	  const nativeActivity = <>
   146	      <CommandActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
   147	      <FileActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
   148	    </>;
   149	  const nativeTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}{nativeActivity}</div>;
   150	  const selectiveTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}
   151	    <CustomizationActivity selection={activity} conversationKey={conversationKey} fallback={nativeActivity}
   152	      context={{ ...context, updates: paused ? 'paused' : view.connection.kind === 'connected' ? 'connected' : 'reconnecting' }} />
   153	  </div>;
   154	
   155	  return <section className="conversation-panel" aria-label="Conversation">
   156	    <header><p className="eyebrow">{agent === 'recorded' ? 'RECORDED CONVERSATION' : 'CONVERSATION'}</p><h1>Your conversation</h1><p className="agent-label">{active.agent.label}</p><p className="scope-label">{active.scope.conversationId}</p></header>
   157	    {active.agent.availability.kind === 'unavailable' && <p role="status">{active.agent.availability.reason} Saved history remains available.</p>}
   158	    {observationStatus?.kind === 'unknown' && <p role="status">Observation status unavailable. Reconnect to check for updates.</p>}
   159	    {observationStatus?.kind === 'recovering' && <p role="status">Resuming provider updates…</p>}
   160	    {observationStatus?.kind === 'stopped' && <div role="status" className="observation-notice">
   161	      <p>Updates paused. {OBSERVATION_NOTICE[observationStatus.reason]} Saved messages and your draft remain available.{run && run.kind !== 'ended' ? ' The provider may still be running.' : ''}</p>
   162	      {canRetryObservation(observationStatus) && <>
   163	        <p>Checking for updates does not restart this request or resend commands.</p>
   164	        <button type="button" disabled={!enabled || observation?.retrying}
   165	          onClick={() => void actions.retryObservation()}>{observation?.retrying ? 'Checking for updates…' : 'Check for updates'}</button>
   166	      </>}
   167	    </div>}
   168	    {observationStatus?.kind === 'concluded' && <div role="status" className="observation-notice">
   169	      <p>This conversation ended: {CLOSURE_NOTICE[observationStatus.cause]}. Earlier messages and your draft stay available.</p>
   170	      {continuation && <ContinuationChoices continuation={continuation} actions={actions} enabled={enabled && available} />}
   171	    </div>}
   172	    {permissionState && <ConversationPermissions retained={recoveryModel(view).retained} state={permissionState} actions={actions} enabled={connected} />}
   173	    <CustomizationContent before={continuation && <ContinuationHistory continuation={continuation} actions={actions} enabled={enabled} assistant={presentation.assistant} />}
   174	      selection={contentLayout} conversationKey={conversationKey} modules={modules} nativeTranscript={nativeTranscript}
   175	      transcript={<CustomizationTranscript selection={transcript} conversationKey={conversationKey}
   176	        context={context}
   177	        fallback={transcript.kind === 'claimed' ? nativeTranscript : selectiveTranscript}
   178	        appendix={sentImages.length > 0 && <section className="sent-images" aria-label="Sent images">
   179	          <h2>Sent images</h2>{sentImages.map(sent => <ImageAttachmentCard key={sent.messageId} attachment={sent.image} read={actions.readImage} />)}
   180	        </section>} />} />
   181	    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
   182	      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
   183	        {decision.choices.map(choice => <button key={choice} disabled={!connected || !active.agent.commands.includes('approve') || decision.reserved || approving.has(decision.pendingId)} onClick={() => approve(decision.pendingId, choice)}>{decision.choiceLabels?.[choice] ?? (agent === 'codex' && choice === 'accept' ? 'Allow' : agent === 'codex' && choice === 'decline' ? 'Deny' : choice)}</button>)}
   184	      </div>
   185	    </section>)}
   186	    <form className="composer" onSubmit={event => { event.preventDefault(); if (canSend) void actions.submit(() => active.store.send()); }}>
   187	      <label htmlFor="message">Message</label>
   188	      <textarea ref={composer} id="message" value={editor.text} onChange={event => void edit(event.target.value)} readOnly={Boolean(storageFailure)} placeholder={presentation.placeholder} rows={3} />
   189	      {editor.kind === 'failed' && <p role={storageFailure ? 'note' : 'alert'}>Draft not saved. {storageFailure ? 'Copy your text before reloading.' : editor.message}</p>}
   190	      {(image || acceptsImages) && <div className="composer-attachments">
   191	        {image && <div className="composer-image" aria-label="Attached image">
   192	          <span>{image.name} · {imageSize(image.byteLength)}</span>
   193	          <span role="status">{image.status === 'uploading' ? 'Uploading…' : image.status === 'ready' ? 'Ready' : image.status === 'interrupted' ? 'Upload interrupted' : image.reason}</span>
   194	          {(image.status === 'failed' || image.status === 'interrupted') && <button type="button" disabled={!enabled}
   195	            onClick={() => imageAction(() => active.store.retryImage())}>Retry</button>}
   196	          <button type="button" disabled={Boolean(storageFailure)} onClick={() => imageAction(() => active.store.removeImage())}>Remove</button>
   197	        </div>}
   198	        {image && !acceptsImages && <span>{active.agent.imageInput.kind === 'unsupported' ? active.agent.imageInput.reason : 'This agent cannot receive images.'} Remove the image to send.</span>}
   199	        {acceptsImages && <>
   200	          <input ref={imageInput} type="file" accept="image/png,image/jpeg" aria-label="Image file" hidden onChange={event => {
   201	            const file = event.target.files?.[0];
   202	            event.target.value = '';
   203	            if (file) imageAction(async () => {
   204	              if (file.size > IMAGE_MAX_BYTES) throw new Error('Choose an image of at most 4 MB.');
   205	              await active.store.selectImage({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
   206	            });
   207	          }} />
   208	          <button type="button" disabled={!enabled || Boolean(storageFailure) || image?.status === 'uploading'}
   209	            onClick={() => imageInput.current?.click()}>{image ? 'Replace image' : 'Add image'}</button>
   210	        </>}
   211	        {imageError?.store === active.store && <p role="alert">{imageError.message}</p>}
   212	      </div>}
   213	      <div className="composer-footer">{composerControls?.(enabled && editor.kind === 'saved' && !responding)}<div className="composer-send-actions"><button disabled={!canSend}>Send</button>
   214	        {run && run.kind !== 'ended' && !concluded && <button type="button" disabled={!connected || !active.agent.commands.includes('cancel') || stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</button>}</div>
   215	      <p className="composer-disclosure">{presentation.footer}</p>
   216	      </div>
   217	    </form>
   218	    <CommandRecovery view={view} actions={actions} enabled={enabled} canRetry={available} retry={id => active.store.retry(id)} />
   219	  </section>;
   220	}
```

### apps/desktop/src/application/ConversationPermissions.tsx
```tsx
     1	import { useEffect, useState } from 'react';
     2	import type { OutboxEntry } from '@openpane/client';
     3	import type { ConversationPermission } from '@openpane/contracts';
     4	import type { ConversationActions, PermissionState } from './application-controller.js';
     5	
     6	export function ConversationPermissions({ state, actions, enabled, retained }: {
     7	  readonly retained: readonly OutboxEntry[];
     8	  readonly state: PermissionState; readonly actions: ConversationActions; readonly enabled: boolean;
     9	}) {
    10	  const [confirming, setConfirming] = useState<ConversationPermission | null>(null);
    11	  const [error, setError] = useState('');
    12	  const listing = 'listing' in state ? state.listing : null;
    13	  const fresh = enabled && state.kind === 'fresh';
    14	  const unresolved = new Set(retained.flatMap(entry => entry.command.body.kind === 'revoke-permission' ? [entry.command.body.permissionId] : []));
    15	  useEffect(() => {
    16	    const refresh = () => { if (enabled) void actions.permissions.read().catch(() => {}); };
    17	    window.addEventListener('focus', refresh);
    18	    return () => window.removeEventListener('focus', refresh);
    19	  }, [actions, enabled]);
    20	  async function revoke(permission: ConversationPermission) {
    21	    setConfirming(null);
    22	    setError('');
    23	    try { await actions.commands.revokePermission(permission.permissionId, permission.scope); }
    24	    catch (cause) { setError(cause instanceof Error ? cause.message : 'Revocation failed. Refresh permissions.'); }
    25	  }
    26	  function refresh() {
    27	    setConfirming(null);
    28	    setError('');
    29	    void actions.permissions.read().catch(() => {});
    30	  }
    31	  return <section aria-label="Permissions" className="permissions-panel" onFocus={event => {
    32	    if (!event.currentTarget.contains(event.relatedTarget) && enabled && state.kind === 'stale') refresh();
    33	  }}>
    34	    <h2>Permissions</h2>
    35	    {state.kind !== 'fresh' && <p role="status">{state.reason}</p>}
    36	    {listing && <>
    37	      <p>Last checked <time dateTime={listing.observedAt}>{new Date(listing.observedAt).toLocaleString()}</time>{state.kind !== 'fresh' ? ' · Refresh required' : ''}</p>
    38	      {listing.permissions.length === 0 && <p>No active work-item permissions were found.</p>}
    39	      {listing.permissions.map(permission => <div key={permission.permissionId}>
    40	        <h3>{permission.actionLabel} · {permission.scope === 'agent' ? 'All conversations for this member' : 'This conversation'}</h3>
    41	        <p>{permission.detail}</p>
    42	        {unresolved.has(permission.permissionId) && <p>The earlier revoke acknowledgement is unknown. Revoke again sends a new command. Its result leaves the earlier acknowledgement unknown.</p>}
    43	        <button type="button" disabled={!fresh} onClick={() => permission.scope === 'agent' ? setConfirming(permission) : void revoke(permission)}>
    44	          {unresolved.has(permission.permissionId) ? 'Revoke again' : permission.scope === 'agent' ? 'Revoke for this member in all conversations' : 'Revoke for this conversation'}
    45	        </button>
    46	      </div>)}
    47	      {listing.permissions.length > 0 && <p>These permissions cover future owner-initiated work items, including different notes. Changing the model or profile keeps them. Revocation applies to later proposals. Already-approved work may finish. Any remaining member permission still applies across conversations.</p>}
    48	    </>}
    49	    {confirming && fresh && listing?.permissions.some(row => row.permissionId === confirming.permissionId && row.scope === 'agent') &&
    50	      <div role="group" aria-label="Confirm all-conversations revocation">
    51	        <p>Revoke this member’s work-item permission in all conversations? Already-approved work may finish.</p>
    52	        <button type="button" onClick={() => void revoke(confirming)}>Confirm revoke in all conversations</button>
    53	        <button type="button" onClick={() => setConfirming(null)}>Keep permission</button>
    54	      </div>}
    55	    {error && <p role="alert">{error}</p>}
    56	    <button type="button" disabled={!enabled || state.kind === 'loading'} onClick={refresh}>Refresh permissions</button>
    57	  </section>;
    58	}
```

### apps/desktop/src/application/CustomizationModules.tsx
```tsx
     1	import { Suspense, useEffect, useRef, useState } from 'react';
     2	import { useConversation } from '@openpane/client/react';
     3	import type { ConversationModule, ConversationModuleProps, ModuleAction } from '@openpane/sdk/react';
     4	import type { SubmitResult } from '@openpane/contracts';
     5	import { Button } from '@openpane/ui-primitives/desktop';
     6	import { refusalMessage } from './application-controller.js';
     7	import type { ConversationActions, OpenConversation } from './application-controller.js';
     8	import { conversationResponding } from './responding.js';
     9	import { CustomizationBoundary, customizationMessage as message, type NamespaceActivation } from './DesktopCustomizations.js';
    10	
    11	function actionOutcome(result: SubmitResult): string {
    12	  if (result.kind === 'rejected') return `Submission rejected. ${refusalMessage(result.reason)}`;
    13	  const state = result.receipt.state;
    14	  switch (state.kind) {
    15	    case 'pending': return 'Submission pending. Follow its progress in the conversation.';
    16	    case 'accepted': return 'Submitted. Follow the response in the conversation.';
    17	    case 'completed': return 'Command completed. Follow the response in the conversation.';
    18	    case 'rejected': return `Submission rejected. ${state.reason}`;
    19	    case 'not-dispatched': return `Not dispatched. ${state.reason}`;
    20	    case 'uncertain': return `Submission uncertain. ${state.reason} Use the conversation recovery controls before trying again.`;
    21	    case 'abandoned': return 'Stopped waiting. Whether this command ran is unknown.';
    22	    default: { const exhaustive: never = state; return exhaustive; }
    23	  }
    24	}
    25	
    26	function ConversationModuleAction({ action, context }: { readonly action: ModuleAction; readonly context: ConversationModuleProps }) {
    27	  const owner = useRef({ mounted: true, pending: false });
    28	  const [state, setState] = useState<{ readonly kind: 'idle' | 'pending' } | { readonly kind: 'settled'; readonly message: string }>({ kind: 'idle' });
    29	  useEffect(() => {
    30	    const current = owner.current;
    31	    current.mounted = true;
    32	    return () => { current.mounted = false; };
    33	  }, []);
    34	  async function run() {
    35	    const current = owner.current;
    36	    if (current.pending) return;
    37	    current.pending = true;
    38	    setState({ kind: 'pending' });
    39	    try {
    40	      const result = await action.run(context);
    41	      if (current.mounted) setState({ kind: 'settled', message: actionOutcome(result) });
    42	    } catch (error) {
    43	      if (current.mounted) setState({ kind: 'settled', message: `Action failed. ${message(error)} Check conversation recovery before trying again.` });
    44	    } finally {
    45	      current.pending = false;
    46	    }
    47	  }
    48	  return <div>
    49	    <Button disabled={state.kind === 'pending'} aria-busy={state.kind === 'pending'} onClick={() => void run()}>{action.label}</Button>
    50	    <p role="status" aria-label={`${action.label} status`}>{state.kind === 'pending' ? 'Submitting…' : state.kind === 'settled' ? state.message : ''}</p>
    51	  </div>;
    52	}
    53	
    54	function ConversationModuleView({ module, context }: { readonly module: ConversationModule; readonly context: ConversationModuleProps }) {
    55	  const View = module.component;
    56	  return <section aria-label={module.label}>
    57	    <View {...context} />
    58	    {module.actions?.map(action => <ConversationModuleAction key={action.id} action={action} context={context} />)}
    59	    {module.children?.map(child => <ConversationModuleView key={child.id} module={child} context={context} />)}
    60	  </section>;
    61	}
    62	
    63	function ConversationModules({ modules, active, actions, enabled, agent }: {
    64	  readonly modules: readonly ConversationModule[]; readonly active: OpenConversation; readonly actions: ConversationActions;
    65	  readonly enabled: boolean; readonly agent: string;
    66	}) {
    67	  const view = useConversation(active.store);
    68	  const context: ConversationModuleProps = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
    69	  const available = enabled && active.agent.availability.kind === 'ready' && active.agent.commands.includes('send') && view.connection.kind === 'connected' && !conversationResponding(agent, view.document.domain);
    70	  return <fieldset disabled={!available} className="customization-modules">
    71	    <legend>Custom tools</legend>
    72	    {!available && <p>Available when this conversation is connected and ready.</p>}
    73	    {modules.map(module => <ConversationModuleView key={module.id} module={module} context={context} />)}
    74	  </fieldset>;
    75	}
    76	
    77	export function CustomizationModules({ owner, active, actions, enabled, agent }: {
    78	  readonly owner: NamespaceActivation; readonly active: OpenConversation | null;
    79	  readonly actions: ConversationActions | null; readonly enabled: boolean; readonly agent: string;
    80	}) {
    81	  return <aside className="customization-panel" aria-label={`Customization ${owner.namespace}`}
    82	    data-customization-namespace={owner.namespace} data-customization-state={owner.kind}>
    83	    {owner.kind === 'loading' && <p role="status">Loading custom tools…</p>}
    84	    {owner.kind === 'failed' && <p role="alert">Custom tools could not load. {owner.message} Use Restore default view to continue without them.</p>}
    85	    {owner.kind === 'ready' && active && actions && <Suspense fallback={<p role="status">Loading custom tools…</p>}>
    86	      <CustomizationBoundary key={`${owner.lifetime}/${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`} fail={owner.fail} fallback={null}>
    87	        <ConversationModules modules={owner.presentation.modules} active={active} actions={actions} enabled={enabled} agent={agent} />
    88	      </CustomizationBoundary>
    89	    </Suspense>}
    90	  </aside>;
    91	}
```

### apps/desktop/src/application/CustomizationContent.tsx
```tsx
     1	import { Suspense, type ReactNode } from 'react';
     2	import type { ConversationContentLayoutProps } from '@openpane/sdk/react';
     3	import { CustomizationBoundary, type ContentLayoutSelection } from './DesktopCustomizations.js';
     4	
     5	export function CustomizationContent({ selection, conversationKey, transcript, nativeTranscript, modules, before = null }: ConversationContentLayoutProps & {
     6	  readonly selection: ContentLayoutSelection;
     7	  readonly conversationKey: string;
     8	  readonly nativeTranscript: ReactNode;
     9	  /** Shown first inside the same scroll area, outside any claimed layout. */
    10	  readonly before?: ReactNode;
    11	}) {
    12	  const fallback = <>{transcript}{modules}</>;
    13	  let content = fallback;
    14	  if (selection.kind === 'conflict') {
    15	    content = <><p role="alert">Content layout conflict. {selection.namespaces.join(', ')} claim the layout. The default arrangement remains active.</p>{fallback}</>;
    16	  } else if (selection.kind === 'claimed') {
    17	    const Layout = selection.owner.presentation.contentLayout;
    18	    content = <Suspense fallback={<><p role="status">Content layout is loading. Module actions will return when it is ready.</p>{nativeTranscript}</>}>
    19	      <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={nativeTranscript}>
    20	        <Layout transcript={transcript} modules={modules} />
    21	      </CustomizationBoundary>
    22	    </Suspense>;
    23	  }
    24	  return <div className="conversation-content">{before}{content}</div>;
    25	}
```

### apps/desktop/src/shell/BrowserApplication.tsx (lines 50-77, 134-137, 174-178)
```tsx
    50	  const displayedAgent = app.active?.agent ?? selected;
    51	  const runtime = displayedAgent ? ('runtime' in displayedAgent ? displayedAgent.runtime : displayedAgent) : metadata?.compatibility.nativeRuntime ?? null;
    52	  const { agent, presentation } = agentPresentation(runtime);
    53	  const activeActions = app.active ? controller.conversationActions(app.active) : null;
    54	  const modules = custom.namespaces.map(owner => <CustomizationModules key={owner.namespace} owner={owner}
    55	    active={app.active} actions={activeActions} enabled={enabled} agent={agent} />);
    56	  const customizationsOn = children === undefined && customizationEnabled;
    57	  const rows = extensionRows({ customizations: customization, activations: custom.namespaces, enabled: customizationsOn, metadata });
    58	  const workspaceRow = openableRow(rows.find(row => row.namespace === selectedExtension));
    59	  const workspaceOpen = selectedView === 'extensions' && workspaceRow !== null;
    60	  // One element, placed in one slot: the Chats view, or the open workspace of the active conversation's namespace.
    61	  const slots = conversationSlots({ row: workspaceOpen ? workspaceRow : null, active: app.active, metadata, custom, modules, agents: choices });
    62	  const activeConversation = app.active && activeActions
    63	    ? <ConversationView
    64	        key={`${app.active.viewId}/${app.active.scope.hostId}/${app.active.scope.conversationId}`}
    65	        transcript={slots.transcript} activity={custom.activity} contentLayout={slots.contentLayout} modules={slots.modules} permissionState={app.permissionState} observation={app.observation} continuation={app.continuation} actions={activeActions} active={app.active} enabled={enabled} storageFailure={app.storageFailure} agent={agent}
    66	        composerControls={canSwitch => <ComposerAgentControls agents={slots.composerAgents} agent={app.active?.agent ?? null} hasConversation enabled={canSwitch && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} onSetupPi={setupPi} />}
    67	      />
    68	    : null;
    69	  const workspaceConversation = slots.workspace ? activeConversation : null;
    70	  const conversation = !slots.workspace && activeConversation
    71	    ? activeConversation
    72	    : <section className="conversation-panel empty-workspace">
    73	        <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
    74	        <h1>A conversation that stays with you.</h1>
    75	        <p>{app.host.kind === 'ready' && !selected ? 'No agents are available to start a conversation.' : 'Connect to your local host, then start a conversation. Your chats and drafts stay here when you come back.'}</p>
    76	        <div className="composer empty-composer"><p>Choose your chat settings.</p><ComposerAgentControls agents={choices} agent={selected ?? null} hasConversation={false} enabled={enabled && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} onSetupPi={setupPi} /></div>
    77	      </section>;
   134	  const views = <div className="chat-view" inert={suspended}>
   135	      {conversation}
   136	      {!app.active && modules}
   137	    </div>;
   174	  return <DesktopShell navigation={rail} activeView={selectedView} protectedContent={controls} defaultView={views} settingsView={settings}
   175	    extensionsView={extensionsView} workspaceOpen={workspaceOpen} restoreMode={children === undefined ? 'managed' : 'remount'}
   176	    onRestore={() => { setCustomizationEnabled(false); setSelectedView('chats'); }}
   177	    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
   178	    buildLabel={presentation.buildLabel}>{children}</DesktopShell>;
```

### apps/desktop/src/application/ExtensionsView.tsx (lines 10-31, 94-114)
```tsx
    10	export type ExtensionRowState = 'Ready' | 'Not configured' | 'Unavailable' | 'No view' | 'Failed' | 'Disabled' | 'Loading';
    11	export interface ExtensionRow {
    12	  readonly namespace: string;
    13	  readonly label: string;
    14	  readonly state: ExtensionRowState;
    15	  readonly detail: string | null;
    16	  readonly owner: Extract<NamespaceActivation, { readonly kind: 'ready' }> | null;
    17	  readonly workspace: WorkspaceContribution | null;
    18	}
    19	/** A row whose workspace can open: its namespace is ready and contributes a workspace. */
    20	export type OpenableRow = ExtensionRow & { readonly owner: NonNullable<ExtensionRow['owner']>; readonly workspace: WorkspaceContribution };
    21	const CLOSED_STATES: ReadonlySet<ExtensionRowState> = new Set(['Disabled', 'Failed', 'Loading']);
    22	export function openableRow(row: ExtensionRow | undefined): OpenableRow | null {
    23	  return row?.owner && row.workspace && !CLOSED_STATES.has(row.state) ? { ...row, owner: row.owner, workspace: row.workspace } : null;
    24	}
    25	type ProviderAgent = Extract<AgentDescriptor, { readonly kind: 'provider' }>;
    26	const SERVER_FAILURE = 'The server extension failed to load. Check the extension configuration, then restart the host.';
    27	const UNAVAILABLE = 'The provider service is offline or unreachable. OpenPane checks again automatically.';
    28	
    29	export function namespaceAgents(metadata: ServiceMetadata | null, namespace: string): readonly ProviderAgent[] {
    30	  return (metadata?.agents ?? []).filter((agent): agent is ProviderAgent => 'kind' in agent && agent.namespace === namespace);
    31	}
    94	export function ExtensionsList({ rows, onOpen, enabled }: {
    95	  readonly rows: readonly ExtensionRow[]; readonly onOpen: (namespace: string) => void; readonly enabled: boolean;
    96	}) {
    97	  return <section className="extensions-panel" aria-label="Extensions">
    98	    <h1>Extensions</h1>
    99	    {rows.length === 0 ? <p className="empty-state">No extensions are installed in this build or configured on this host.</p>
   100	      : <ul className="extension-list">
   101	        {rows.map(row => {
   102	          const selectable = openableRow(row) !== null;
   103	          return <li key={row.namespace} className="extension-row" data-extension={row.namespace}>
   104	            <div className="extension-row-text">
   105	              <strong>{row.label}</strong>
   106	              <span className="extension-state" data-state={row.state}>{row.state}</span>
   107	              {row.detail && <p>{row.detail}</p>}
   108	            </div>
   109	            {selectable && <button type="button" disabled={!enabled} aria-label={`Open ${row.label}`} onClick={() => onOpen(row.namespace)}>Open</button>}
   110	          </li>;
   111	        })}
   112	      </ul>}
   113	  </section>;
   114	}
```

### apps/desktop/src/application/application.css (lines 1-21, 84-144, 160-187, 210-258, 269-282)
```css
     1	.application-controls { padding: 1.5rem 2rem; background: var(--aui-color-surface); border-bottom: 1px solid var(--aui-color-border); }
     2	.artifact-identity { margin: .75rem 0; color: var(--aui-color-muted); font-size: .7rem; overflow-wrap: anywhere; }
     3	.application-controls button, .conversation-panel button { border: 1px solid var(--aui-color-border); border-radius: .5rem; padding: .6rem .9rem; background: var(--aui-color-surface); color: inherit; font: inherit; cursor: pointer; }
     4	.application-controls button:hover:not(:disabled), .conversation-panel button:hover:not(:disabled) { border-color: var(--aui-color-accent); }
     5	.application-controls button:disabled, .conversation-panel button:disabled { opacity: .45; cursor: default; }
     6	.application-controls button:focus-visible, .conversation-panel button:focus-visible, .application-controls input:focus-visible, .composer textarea:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 3px; }
     7	.action-row { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1rem; }
     8	.application-alert, .creation-recovery { padding: 1rem; margin: 1rem 0; border: 1px solid var(--aui-color-border); border-left: 3px solid var(--aui-color-accent); border-radius: .5rem; overflow-wrap: anywhere; }
     9	.application-alert p:last-child { margin-bottom: 0; }
    10	.conversation-catalog { display: flex; gap: .5rem; overflow-x: auto; margin-top: 1rem; padding-bottom: .25rem; }
    11	.eyebrow { font-size: .7rem; letter-spacing: .12em; color: var(--aui-color-accent); }
    12	.scope-label { color: var(--aui-color-muted); font-size: .75rem; overflow-wrap: anywhere; }
    13	.progress-label { display: block; font-size: .75rem; margin-top: .8rem; color: var(--aui-color-muted); }
    14	.empty-state, .empty-workspace > p:last-child { color: var(--aui-color-muted); line-height: 1.6; }
    15	.composer-footer { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    16	.decision-card, .permissions-panel, .outbox { padding: 1.25rem; margin-top: 1.5rem; border: 1px solid var(--aui-color-border); border-radius: .8rem; }
    17	.decision-card h2, .permissions-panel h2, .outbox h2 { margin-top: 0; font-size: 1rem; }
    18	.decision-card p, .permissions-panel p { white-space: pre-wrap; overflow-wrap: anywhere; }
    19	.outbox > p { color: var(--aui-color-muted); font-size: .85rem; }
    20	.outbox article + article { border-top: 1px solid var(--aui-color-border); padding-top: 1rem; margin-top: 1rem; }
    21	.outbox code { font-size: .7rem; overflow-wrap: anywhere; }
    84	.desktop-shell:has(.application-controls) #main-content { align-content: start;
    85	  padding: 0 32px;
    86	  grid-column: 2; grid-row: 2; display: flex; min-width: 0; min-height: 0; overflow: hidden;
    87	}
    88	.conversation-panel {
    89	  width: min(100%, 820px); margin: 0 auto; height: 100%; min-height: 0;
    90	  display: flex; flex-direction: column; overflow-y: auto;
    91	}
    92	.conversation-panel > header { flex: none; padding: 18px 0 12px; border-bottom: 1px solid var(--aui-color-border); }
    93	.conversation-panel > header .eyebrow, .conversation-panel > header .scope-label { display: none; }
    94	.conversation-panel h1 { margin: 0; font-size: 15px; font-weight: 600; }
    95	.transcript { display: flex; flex-direction: column; gap: 28px; margin: 0; flex: 1; min-height: 80px; overflow-y: auto; padding: 32px 4px; }
    96	.message { min-width: 0; border: 0; border-radius: 0; padding: 0; font-size: 14px; line-height: 1.75; }
    97	.message-user p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
    98	.message-user { margin-left: 2rem; align-self: flex-end; max-width: 85%; margin: 0; padding: 12px 18px; border-radius: 20px; background: var(--aui-color-raised); }
    99	.message-assistant { margin-right: 2rem; margin: 0 20px 0 0; }
   100	.message > strong { font-size: 11px; color: var(--aui-color-muted); font-weight: 500; }
   101	.assistant-reply { min-width: 0; overflow-wrap: anywhere; }
   102	.assistant-reply p, .assistant-reply ul, .assistant-reply ol, .assistant-reply blockquote { margin: .65rem 0; }
   103	.assistant-reply > :last-child { margin-bottom: 0; }
   104	.assistant-reply :is(h1, h2, h3, h4, h5, h6) { margin: 1rem 0 .5rem; line-height: 1.3; font-weight: 600; }
   105	.assistant-reply h1 { font-size: 1.4rem; }
   106	.assistant-reply h2 { font-size: 1.2rem; }
   107	.assistant-reply :is(h3, h4, h5, h6) { font-size: 1rem; }
   108	.assistant-reply ul, .assistant-reply ol { padding-left: 1.5rem; }
   109	.assistant-reply blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--aui-color-border); }
   110	.assistant-reply code { font-family: ui-monospace, monospace; font-size: .85em; }
   111	.assistant-reply :not(pre) > code { padding: .1em .3em; border-radius: .25rem; background: var(--aui-color-raised); }
   112	.assistant-reply pre { max-width: 100%; box-sizing: border-box; overflow-x: auto; padding: .8rem; margin: 0; white-space: pre; overflow-wrap: normal; background: var(--aui-color-surface); }
   113	.reply-code-block { min-width: 0; margin: .8rem 0; border: 1px solid var(--aui-color-border); border-radius: .5rem; overflow: hidden; }
   114	.reply-code-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .5rem; font-size: .75rem; }
   115	.conversation-panel .reply-code-actions button { padding: .3rem .5rem; font-size: inherit; }
   116	.reply-code-actions span, .reply-destination { color: var(--aui-color-muted); }
   117	.composer { display: grid; gap: 8px; margin-top: 1.5rem; flex: none; margin: 12px 0 16px; padding: 12px 14px 10px; border-radius: 22px; background: var(--aui-color-raised); }
   118	.composer label { font-size: .85rem; font-weight: 600; position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
   119	.composer textarea { box-sizing: border-box; width: 100%; resize: vertical; padding: 4px 2px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; min-height: 54px; max-height: 160px; font-size: 14px; line-height: 1.5; }
   120	.composer textarea:focus-visible { outline: none; }
   121	.composer:focus-within { box-shadow: 0 0 0 2px var(--aui-color-accent); }
   122	.composer-footer span { font-size: 10px; color: var(--aui-color-muted); }
   123	.composer-attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
   124	.composer-attachments p { margin: 0; flex-basis: 100%; }
   125	.composer-image { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 4px 4px 10px; border: 1px solid var(--aui-color-border); border-radius: 12px; overflow-wrap: anywhere; }
   126	.composer-image [role="status"] { color: var(--aui-color-muted); }
   127	.conversation-panel .composer-attachments button { padding: 4px 10px; font-size: 12px; }
   128	.image-attachment { margin: 8px 0 0; }
   129	.image-attachment img { display: block; max-width: min(240px, 100%); max-height: 240px; border-radius: 8px; }
   130	.image-attachment figcaption, .image-preview-status { font-size: 12px; color: var(--aui-color-muted); overflow-wrap: anywhere; }
   131	.sent-images { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 0; border-top: 1px solid var(--aui-color-border); }
   132	.sent-images h2 { flex-basis: 100%; margin: 0; font-size: .85rem; }
   133	.composer-footer button { background: var(--aui-color-accent); color: var(--aui-color-on-accent); border: 0; border-radius: 20px; padding: 6px 14px; font-size: 12px; }
   134	.decision-card, .permissions-panel { flex: none; max-height: 30vh; overflow-y: auto; padding: 14px; margin-top: 12px; background: var(--aui-color-surface); font-size: 12px; }
   135	.outbox { flex: none; max-height: 22vh; overflow-y: auto; }
   136	.continuation-history { flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding-top: 16px; }
   137	.continuation-history .earlier-segment { flex: none; align-self: stretch; overflow-y: visible; padding: 0 4px; }
   138	.continuation-boundary { align-self: stretch; margin: 0; padding: 10px 0; border-top: 1px solid var(--aui-color-border); border-bottom: 1px solid var(--aui-color-border); color: var(--aui-color-muted); font-size: 12px; line-height: 1.5; }
   139	.continuation-choices p { margin: 8px 0 0; }
   140	.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
   141	.empty-workspace { padding: 24px; max-width: 38rem; justify-content: center; }
   142	.empty-workspace .eyebrow { font-size: 11px; }
   143	.empty-workspace h1 { font-size: 28px; }
   144	.desktop-shell:has(.application-controls) .shell-footer { grid-column: 2; grid-row: 3; padding: 4px 24px; border: 0; font-size: 10px; }
   210	.chat-view { flex-direction: column; }
   211	.chat-view > .conversation-panel { flex: 1; }
   212	.customization-panel { flex: none; max-height: 35%; overflow: auto; padding: 8px 0; width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }
   213	.customization-panel h2 { font-size: 16px; margin-top: 0; }
   214	.customization-modules { border: 1px solid var(--aui-color-border); border-radius: 12px; padding: 1rem; margin: 0; min-width: 0; }
   215	
   216	.chat-search { margin: 0 4px 16px; min-width: 0; }
   217	.chat-search label, .search-status { display: block; font-size: 12px; color: var(--aui-color-muted); }
   218	.chat-search input { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 8px; margin-top: 6px; border: 1px solid var(--aui-color-border); border-radius: 8px; background: var(--aui-color-canvas); color: inherit; font: inherit; }
   219	.chat-search > button { font-size: 12px; }
   220	.chat-search [role="listbox"] { display: flex; flex-direction: column; gap: 4px; }
   221	.chat-search [role="listbox"][hidden] { display: none; }
   222	.chat-search [role="option"] { width: 100%; overflow-wrap: anywhere; }
   223	.chat-search [role="option"][aria-selected="true"] { background: var(--aui-color-raised); outline: 1px solid var(--aui-color-accent); outline-offset: -1px; }
   224	.chat-search [role="option"] span, .chat-search [role="option"] small { display: block; white-space: normal; }
   225	.chat-search [role="option"] small { margin-top: 4px; color: var(--aui-color-muted); font-size: 11px; }
   226	
   227	.agent-choice { display: grid; gap: .4rem; min-width: 0; font-size: .8rem; }
   228	.agent-choice select { width: 100%; min-width: 0; max-width: 100%; padding: .5rem; border: 1px solid var(--aui-color-border); border-radius: .5rem; background: var(--aui-color-surface); color: inherit; font: inherit; }
   229	.agent-choice select:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 3px; }
   230	.agent-label { margin: 0; color: var(--aui-color-muted); font-size: .8rem; }
   231	
   232	.composer-footer { flex-wrap: wrap; align-items: flex-end; }
   233	.composer-agent-controls { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; flex: 1; }
   234	.conversation-panel .composer-setting { display: inline-flex; align-items: center; gap: 5px; padding: 6px 7px; min-width: 0; max-width: 100%; border: 0; border-radius: 7px; background: transparent; color: var(--aui-color-text); font-size: 12px; line-height: 1.3; text-align: left; }
   235	.conversation-panel .composer-setting:hover:not(:disabled), .conversation-panel .composer-setting[aria-expanded="true"] { background: var(--aui-color-surface); }
   236	.composer-setting svg { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
   237	.conversation-panel .composer-effort { color: var(--aui-color-muted); opacity: .65; }
   238	.composer-send-actions { display: flex; gap: 6px; margin-left: auto; }
   239	.composer-disclosure { flex-basis: 100%; margin: 0; color: var(--aui-color-muted); font-size: 10px; line-height: 1.4; }
   240	.composer-picker { position: absolute; z-index: 6; bottom: calc(100% + 10px); left: 0; width: min(320px, 100%); min-width: 0; box-sizing: border-box; max-height: min(420px, 55dvh); overflow: auto; padding: 12px; border: 1px solid var(--aui-color-border); border-radius: 16px; background: var(--aui-color-surface); box-shadow: 0 12px 40px #0003; color: var(--aui-color-text); }
   241	.composer-picker:focus { outline: none; }
   242	.composer-picker-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
   243	.conversation-panel .composer-picker-heading button { padding: 0 5px; background: transparent; color: var(--aui-color-muted); font-size: 20px; border: 0; }
   244	.composer-picker > p { margin: 5px 0 12px; color: var(--aui-color-muted); font-size: 11px; line-height: 1.5; }
   245	.composer-picker-options { display: grid; gap: 4px; }
   246	.conversation-panel .composer-picker-option { position: relative; display: grid; gap: 3px; width: 100%; padding: 8px 24px 8px 10px; background: transparent; color: inherit; border: 0; border-radius: 9px; font-size: 13px; line-height: 1.4; text-align: left; overflow-wrap: anywhere; }
   247	.conversation-panel .composer-picker-option:hover:not(:disabled) { background: var(--aui-color-raised); }
   248	.conversation-panel .composer-picker-option[aria-current="true"] { background: var(--aui-color-raised); opacity: 1; }
   249	.composer-footer .composer-picker-option > span { color: var(--aui-color-text); font-size: 13px; }
   250	.composer-picker-option small { font-size: 10px; line-height: 1.4; color: var(--aui-color-muted); }
   251	.composer-picker-option .picker-check { position: absolute; right: 9px; top: 10px; }
   252	.conversation-panel .composer-setting:focus-visible, .conversation-panel .composer-picker button:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 2px; }
   253	.empty-composer { margin-top: 24px; }
   254	.empty-composer > p { margin: 0 0 12px; color: var(--aui-color-muted); font-size: 13px; }
   255	@media (max-width: 760px) {
   256	  .composer-footer > .composer-agent-controls { flex-basis: 100%; }
   257	  .conversation-panel .composer-setting { padding-inline: 4px; font-size: 11px; }
   258	}
```

### extensions/crew/src/desktop/index.tsx line 11 (coworkers identical shape)
```tsx
    return { modules: [], workspace: { label: 'Crew', component: CrewWorkspace, transcript: CrewTranscript }, dispose() {} };
```

### Tauri drag-drop fact
Fact: no call to disable_drag_drop_handler and no dragDropEnabled key exist. In Tauri 2 the native drag-drop handler is enabled by default; on macOS it consumes OS file drops and emits tauri://drag-drop events with file paths, so HTML5 'drop' events in the webview do not receive File objects unless the handler is disabled (WebviewWindowBuilder::disable_drag_drop_handler or window config "dragDropEnabled": false). The browser build (vite --mode browser) receives normal HTML5 drops.
