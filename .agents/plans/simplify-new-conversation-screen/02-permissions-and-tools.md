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

Evidence that permissions are read on their own: the controller reads them when a conversation opens or reconnects (`application-controller.ts:445, 451, 464, 470`) and after each command (`:619`). The panel does not have to be mounted for a read to happen.

`stalePermissions` (`:260-263`) currently turns any earlier state into `stale` whenever a disconnect or command occurs (`:287, 460, 552, 608, 712`). For a Codex conversation the earlier state was `unsupported`, so after a disconnect it becomes `stale` with a null listing, and the card would come back.

### Controller fix: `application-controller.ts`

- `stalePermissions` keeps the `unsupported` kind when the previous state was `unsupported`. Support is a property of the conversation, not of the connection.
- `readPermissions` publishes `loading` only when the previous state is not `unsupported`. Otherwise it keeps `unsupported` until the read returns. This prevents a flash.
- Add a test to `tests/application/controller.test.mjs`. Start from an `unsupported` conversation, disconnect, then send a command. The state must still be `unsupported`.

### Visibility rule

Add a new export to `ConversationPermissions.tsx`:

```
permissionsShown(state) =
  state.kind !== 'unsupported' && !(state.kind === 'loading' && state.listing === null)
```

| State | Shown? | Why |
|---|---|---|
| `unsupported` | No | Nothing to act on. |
| `loading` with a null listing | No | The first read is in progress. |
| `fresh` | Yes | Grants or "No active work-item permissions were found." |
| `loading` with a listing | Yes | Refreshing an existing listing. |
| `stale`, with a listing or null | Yes | A failed or interrupted read. The reason and "Refresh permissions" are the recovery path. |

The initial state is `stale`, null, "Open a conversation to read permissions." It exists only while no conversation is active, and the panel never renders then, so no reason-string matching is needed.

Known edge (non-blocking): if a Codex conversation disconnects before its first read returns, it goes from `loading` (null) to `stale` (null), and the card shows "Reconnect to refresh permissions." until the next read returns `unsupported`.

The window-focus refresh listener stays in `ConversationPermissions`. It is unmounted only for `unsupported`, which needs no refresh, and during the first read, which the controller already owns.

### Placement

- **`ConversationView.tsx`.** At line 172, render `{permissionState && permissionsShown(permissionState) && <ConversationPermissions …/>}`. Move it below the decision cards, directly above the composer.
- **`application.css`.** Add a new, later rule: `.conversation-panel .permissions-panel { padding: 10px 12px; margin-top: 8px; }`. Leave the grouped rules at `:16` and `:134` as they are, because they also style `.decision-card` and `.outbox`. The border stays.

Region names, button labels and the revoke flow do not change.

**Sequencing.** `permissionsShown` and the controller fix belong to WP1, because the empty predicate depends on them ([04](04-execution-handoff.md)).

## Custom tools

### `CustomizationModules.tsx`

- `ConversationModules` returns `null` when `modules.length === 0`.
- Add a new prop to `CustomizationModules`: `surface: 'status' | 'tools'`.
  - `status`: returns `null` at the top level, with no `<aside>`, unless `owner.kind` is `loading` or `failed`. When it does render, it shows the loading text or the failed alert, keeping the text "Custom tools could not load. … Use Restore default view to continue without them." The `<aside>` keeps its `aria-label` and `data-customization-*` attributes.
  - `tools`: returns `null` at the top level unless the namespace is `ready` with `presentation.modules.length > 0`.
- Add `surface: 'all'` for claimed content layouts. It returns `null` when there is neither a notice nor a usable module; otherwise it behaves as today.
- Ready namespaces with `modules: []` (crew, coworkers) produce no DOM and no height on any surface.

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
- **Extensions list.** Compute eligibility once: `const toolsEligible = Boolean(app.active) && slots.contentLayout.kind !== 'claimed' && custom.namespaces.some(o => o.kind === 'ready' && o.presentation.modules.length > 0)`. Then pass `<ExtensionsList … tools={toolsEligible ? moduleTools : null} conversation={toolsEligible ? label : null} />`.

  The label comes from `conversationLabel({ scope, preview })` (`@openpane/contracts/conversation`, already imported at `BrowserApplication.tsx:16`), using the `app.catalog.items` entry whose scope matches `app.active.scope`. If no entry matches, fall back to `app.active.scope.conversationId`.

### `ExtensionsView.tsx`: `ExtensionsList`

- Add new optional props: `tools?: ReactNode | null` and `conversation?: string | null`. Do not add a separate boolean.
- Render `<section className="conversation-tools" aria-label="Conversation tools"><h2>Conversation tools</h2><p>Runs in {conversation}.</p>{tools}</section>` after the list, only when `tools != null`. `BrowserApplication` passes `null` unless `toolsEligible`, so an array of null-rendering elements never reaches this check.

### `application.css`

- `.extensions-panel .customization-panel { max-height: none; overflow: visible; }`
- `.conversation-tools { margin-top: 24px; }`
- `.customization-modules` keeps its border inside Extensions.

## Test updates

- **`module-actions.browser.test.mjs`.**
  - Before locating `complementary "Customization fixture"`, click the rail button "Extensions".
  - Before each `getByRole('textbox', { name: 'Message' })` at `:43` and `:73`, click "Chats". This is mandatory: role locators skip elements under a `hidden` ancestor.
  - Click "Extensions" again before the next tool interaction.
  - `.scope-label` (`:85`) is a CSS locator in the hidden header, so it is unaffected.
- **Alert tests.** `frontend-tools`, `journey` and `transcript-overrides` should pass unchanged, because the failed alert stays in the column.
- **`content-layout.browser.test.mjs`.**
  - `:40` (claimed layout) expects wrappers for `['coworkers','crew','personal','transcript']`. Under `surface="all"`, the empty crew and coworkers render nothing, so the expectation becomes `['personal','transcript']`.
  - `:190` (conflict, default fallback) counts 2 `ready` wrappers. Under `surface="status"`, ready wrappers render nothing; change it to count 0 and keep the conflict-alert assertion.
  - These are deliberate expectation changes. Record them in the commit message.
- **`content-layout-image.browser.test.mjs`.** It should pass unchanged.
- **Crew provider test.** It should pass unchanged. The region appears once the listing is fresh. If the test queries the region before the first read finishes, it already waits (line 927 onwards). Confirm when it runs.

## Acceptance

1. In a Codex conversation there is no `region "Permissions"`.
2. In a Crew conversation with grants there is a `region "Permissions"` above the composer, and both revoke paths and "Refresh permissions" work.
3. The Chats view has no `group` or `fieldset` with the legend "Custom tools", and no `complementary` named "Customization crew" or "Customization coworkers".
4. With the module-actions fixture:
   - Chats shows no module buttons.
   - Extensions shows "Conversation tools", "Runs in …", and the fixture's buttons.
   - Running an action there updates the conversation, which is visible after you return to Chats.
5. When a customization fails to load, the alert "Custom tools could not load." still appears in the conversation column.
6. A claimed content layout still renders the modules it receives. This is a deliberate exception: a layout that claims the content area is a customization the user installed to arrange tools, so its placement wins. A default or conflicting layout never shows tools in the column.
