# Review: Simplify the new-conversation screen

## Coverage map

| # | Explicit requirement (user, 2026-11-21) | Plan location | Acceptance criterion | Coverage |
|---|---|---|---|---|
| R1 | Simplify the busy new-conversation screen | 00 criterion 1; 01 §Changes 1–4; 02 §Permissions, §Custom tools | 01-1, 01-2, 02-1, 02-3 | **Partial.** Ready namespaces still render empty `complementary` landmarks in the column (F8). 01-2 can't be checked as written (F10). |
| R2 | Remove the text box highlight while typing; the caret is enough | 01 CSS lines 121 and 6 | 01-4 (`.composer` box-shadow) | **Covered.** The line 6 edit is unnecessary and conflicts with R7 (F7). |
| R3 | Remove the resize handle | 01 CSS line 119; auto-grow | 01-4 (`resize: none`), 01-5 | **Covered.** Auto-grow ignores width changes (F15). |
| R4 | Add photo should be drag and drop | 03 in full; tauri.conf | 03-1, 03-2, 03-3 | **Partial.** No guard stops off-panel drops from navigating (F1). Rejected drops never reach `drop` (F3). Rejections are invisible for agents that can't take images (F4). |
| R5 | Custom tools configured elsewhere | 02 §Custom tools; Extensions view | 02-3, 02-4, 02-6 | **Covered.** Interface and test gaps in F8, F11, F13. |
| R6 | Several designs that still look like OpenPane | research/decision.md (3 proposals); 04 screenshots | Screenshot comparison only, no pass/fail | **Covered for "several designs"**. "Looks like OpenPane" is judged by screenshot review; that is acceptable for a subjective goal. |
| R7 | Leave the two left navigation panes alone | 00 criterion 6; 04 DoD diff check and pixel compare | 04 DoD | **Conflict.** The 01 line 6 edit changes a rule that contains `.application-controls` selectors (F7). |
| R8 | Change only this screen and things that use its components | 00 §Scope; 01 §Empty workspace; footer label | 01-7 | **Covered.** The footer condition is wrong when the conversation is hosted in a workspace (F9). |

## Findings

### Blocking

**F1. Drops outside the panel will navigate the webview.**
- **Plan location:** 03 §tauri.conf.json; 03 Acceptance 2; 04 WP4 manual check.
- **Evidence:**
  - Only `.conversation-panel` gets drag handlers (03 §Changes 3).
  - Setting `dragDropEnabled: false` hands OS file drops to HTML5 defaults (brief, Tauri fact).
  - The rail, the sidebar and the `#main-content` padding (`application.css:85`, 32px each side) all sit outside the panel. The panel itself is `min(100%, 820px)` wide.
  - Today the native handler consumes these drops, so nothing navigates.
- **Failure mode:** The agent follows 03 literally. A file dropped on the sidebar or in the side gutter loads the file in the webview, and app state is lost. The manual check catches this only after implementation. No browser test covers it.
- **Correction:** Add a document-level guard in `BrowserApplication.tsx`, or in the app entry, outside rail markup:
  - On `dragover` and `drop`, when `types` includes `'Files'`, call `preventDefault()`.
  - On `dragover`, also set `dropEffect = 'none'` unless the event is already handled.

  Add a browser test that dispatches a `drop` on `.view-rail` and asserts `defaultPrevented`. This keeps criterion 6 intact, because it adds no rail markup or CSS.

**F2. The permissions gate can stop the first read from ever happening, and one decision is left open.**
- **Plan location:** 02 §Permissions, the design note ("Refinement decides"); 04 WP2.
- **Evidence:**
  - The initial state is `stale`, `listing: null` (`application-controller.ts:148`), and the new gate hides exactly that state.
  - `ConversationPermissions` triggers reads only while it is mounted: the window-focus listener (`:15-19`), the panel `onFocus` when stale (`:32`), and Refresh (`:56`).
  - The packet has no evidence that the controller reads permissions when a conversation opens.
  - `extensions/crew/tests/provider.test.mjs:915-950` waits for `region "Permissions"`.
- **Failure mode:** If the controller doesn't read on open, Crew never leaves `stale`/null. The panel never appears and the user has no way to trigger a read. Separately, "Refinement decides" leaves the agent to choose between reason-string matching and a vague "once the first read has started". Either choice can hide revoke errors after a failed first read.
- **Correction:**
  1. In WP2, first confirm from `application-controller.ts` where the first `permissions.read()` happens on open. If nothing triggers it, call `actions.permissions.read()` from `ConversationView` in an effect keyed on the conversation whenever `permissionState.kind !== 'unsupported'`, and move the window-focus refresh there as well.
  2. Settle the open rule now. Export the placeholder reason from `application-controller.ts:148` as a constant, for example `PERMISSIONS_NOT_READ`. Define `permissionsShown` as: `state.kind !== 'unsupported' && (state.kind === 'fresh' || state.listing !== null || (state.kind === 'stale' && state.reason !== PERMISSIONS_NOT_READ))`. This matches a typed constant, not a free-form string.
  3. Add a Codex check to WP2's verification, because acceptance 02-1 currently has no command.

**F3. Rejected drags never receive `drop`, so the specified alert never fires for real users.**
- **Plan location:** 03 §Changes 3, the Drop states row "Over, reject", and the Tests section.
- **Evidence:**
  - The plan sets `dropEffect = 'none'` for reject, then says "a drop sets the alert".
  - Per the HTML drag-and-drop model, when the current operation is `none` at release, the browser fires `dragleave` and does not fire `drop`.
  - The plan's tests use synthetic `dispatchEvent('drop')`, which fires whatever `dropEffect` says.
- **Failure mode:** All six browser cases pass. In real use, a GIF or multi-file drop only flashes an `aria-hidden` hint that disappears on release. Screen-reader users get nothing, which contradicts "The outcome is announced by the existing status and alert", and criterion 4's "explain why" is lost after release.
- **Correction:** Use `dropEffect = 'copy'` for every non-`ignore` file drag. Let the outline colour and the hint carry accept or reject. On `drop`, decide again from real data: `blocked ?? intakeFile([...dataTransfer.files])`, then call `attach` or set `imageError`. This also removes the stale-React-state read of the hover verdict. Update the state table to match.

**F4. A drop rejection is invisible when the agent can't take images.**
- **Plan location:** 03 §Changes 2 (`blocked` covers `!acceptsImages`) and §Changes 6 (the alert "stays directly under the chip").
- **Evidence:** The `imageError` alert renders inside `.composer-attachments`, which mounts only when `image || acceptsImages` (`ConversationView.tsx:190, 211`).
- **Failure mode:** On an agent without image support, a drop sets `imageError` and nothing renders. Criterion 4 fails silently.
- **Correction:** Render `{imageError?.store === active.store && <p role="alert">…</p>}` inside the composer, independent of `acceptsImages`. Add a drop case for an agent without image input, asserting its reason text.

### Improvements

**F5. Rescoping the Send fill to `.composer-send` loses on specificity, and the other buttons are left unstyled.**
- **Plan location:** 01 CSS line 133; 03 CSS `.composer-add`, the Remove "×" button, and "Delete `.composer-attachments` row styling".
- **Evidence:**
  - `.conversation-panel button` (`:3`) has specificity (0,1,1). Today `.composer-footer button` (`:133`) ties with it and wins because it comes later. A bare `.composer-send` is (0,1,0) and loses on background, border and padding.
  - Stop gets no class in the plan, so it falls back to the bordered `:3` style, not "the transparent `.composer-setting` look".
  - The chip's Remove and Retry buttons lose `:127` if that row is deleted.
- **Failure mode:** Send renders as a bordered surface button. The screenshot gate catches it late, if at all.
- **Correction:**
  - Write the selector as `.conversation-panel .composer-send`.
  - Give "+" and Stop `className="composer-setting …"`.
  - Re-home the chip button rule as `.conversation-panel .composer-image button`.

**F6. WP1 depends on a WP2 symbol.**
- **Plan location:** 01 §Changes 3, the last predicate term; 04 WP1/WP2 ordering.
- **Evidence:** WP1 needs `permissionsShown`, which WP2 creates. WP2 runs after WP1.
- **Failure mode:** WP1 won't compile, or the agent improvises a gate inside WP1.
- **Correction:** Move `permissionsShown` and its F2 decision into WP1 as the predicate's only dependency. WP2 then covers mounting position, CSS and the Crew test.

**F7. The line 6 edit conflicts with criterion 6 and the DoD diff check.**
- **Plan location:** 01 CSS table, row 6; 04 DoD.
- **Evidence:**
  - `application.css:6` is one rule whose selector list includes `.application-controls button:focus-visible` and `.application-controls input:focus-visible`.
  - `:120` already sets `outline: none` on `.composer textarea:focus-visible`, at equal specificity and later in the file.
- **Failure mode:** The diff check "no changed `.application-controls` rules" flags the edit. The agent then either fails its own DoD or argues around it.
- **Correction:** Leave line 6 alone. Strengthen acceptance 01-4 instead: the textarea's computed `outline-style` is `none` while it has focus. This also guards against design-system focus styles, which the packet doesn't show.

**F8. The `status` surface leaves empty landmarks and padding for ready namespaces.**
- **Plan location:** 02 §CustomizationModules, `surface: 'status'` ("The `<aside>` keeps its `aria-label` and `data-customization-*` attributes"); 00 criterion 5.
- **Evidence:**
  - Crew and coworkers are ready with `modules: []`.
  - The `<aside>` always renders (`CustomizationModules.tsx:81`) and carries `.customization-panel { padding: 8px 0 }` (`:212`).
- **Failure mode:** The Chats view keeps two empty `complementary "Customization crew/coworkers"` landmarks plus 32px of spacing, which also skews the centred empty state. Acceptance 02-3, which checks only for a "Custom tools" legend, still passes. Criterion 5 ("render nothing anywhere") is violated without any test noticing.
- **Correction:** Have `status` return `null` unless `owner.kind` is `loading` or `failed`. First grep tests for `data-customization-state="ready"` and `Customization (crew|coworkers)`; the packet doesn't show whether anything depends on them. Add an acceptance check: no `complementary` named `Customization crew` or `Customization coworkers` on Chats.

**F9. The disclosure's condition and its source are both wrong.**
- **Plan location:** 01 §BrowserApplication.tsx.
- **Evidence:**
  - When `slots.workspace` is set, the active `ConversationView` renders in the Extensions workspace, and Chats shows the empty-workspace section (`BrowserApplication.tsx:69-77`). `selectedView === 'chats' && app.active` is then true for a screen with no composer, and false where the composer actually is.
  - The shell's `presentation` comes from `runtime` (`:51-52`). The composer used `agentPresentation(active.agent)` for provider agents (`ConversationView.tsx:58`).
- **Failure mode:**
  - "Approvals required for changes" disappears beside a live composer in a workspace, and appears beside a screen that has none.
  - Provider conversations may show different disclosure text than before.
- **Correction:**
  - Condition: `app.active && ((selectedView === 'chats' && !slots.workspace) || (workspaceOpen && slots.workspace))`.
  - Text: compute it with the same expression as `ConversationView:58`, ideally a shared helper.
  - Add `tests/host/extensions/extension-only.test.mjs` to WP1's verification.

**F10. Acceptance 01-2 can't be tested with Playwright's notion of "visible".**
- **Plan location:** 01 Acceptance 2 and 3.
- **Evidence:** Playwright treats any element with a non-empty bounding box as visible. The h1 inside a `.visually-hidden` header keeps its own box, so `toBeHidden()` fails even though it is clipped. The same rule is why acceptance 3 expects `journey:238` to pass.
- **Failure mode:** The agent writes `expect(heading).toBeHidden()`, sees it fail, and then either "fixes" the header with `display: none`, which breaks `journey:238` and a11y, or drops the check.
- **Correction:** Restate 01-2 for the header as "`header.visually-hidden` exists and its bounding box is at most 1×1". Keep `toBeHidden()`/absent checks for the paragraph, the effort button and the disclosure.

**F11. The module-actions test can't find the textbox while Extensions is shown.**
- **Plan location:** 02 §Test updates ("Hidden inputs still report `inputValue`, so this step is only needed for visibility checks").
- **Evidence:**
  - The chat view is hidden with `hidden` on `.shell-view`.
  - `module-actions:43/73` use `getByRole('textbox', { name: 'Message' })`, and role locators exclude hidden elements by default.
- **Failure mode:** The agent skips the "click Chats" step as optional, and the locator times out.
- **Correction:** Make the click on "Chats" before `:43` and `:73` mandatory, or use `includeHidden: true`. `.scope-label` (`:85`) is a CSS locator and is unaffected.

**F12. The empty predicate misses content that can render.**
- **Plan location:** 01 §Changes 3.
- **Evidence:**
  - A claimed `activity` selection renders `CustomizationActivity` inside the transcript (`ConversationView.tsx:150-152`).
  - `CommandActivity`/`FileActivity` read `domain`, not `messages`.
  - `CommandRecovery` (`:218`) renders after the form.
- **Failure mode:** Content renders while `data-empty="true"`. The transcript is then zero-padded, and the composer is centred with content around it.
- **Correction:**
  - Add `activity.kind !== 'claimed'`.
  - Add "no command or file activity in `view.document.domain`", using the same check those components use to return `null`.
  - Add `view.outbox.length === 0`, or the `recoveryModel(view)` equivalent.

**F13. The `ExtensionsList` interface is inconsistent between 02 and 04.**
- **Plan location:** 02 §ExtensionsView ("tools, conversation" plus a `hasTools` that is "passed in"); 04 WP3 ("tools, conversation and hasTools").
- **Failure mode:** Two prop shapes. The agent may add a redundant boolean that can drift from `tools`.
- **Correction:** Keep two props. `BrowserApplication` passes `tools={hasTools && app.active && slots.contentLayout.kind !== 'claimed' ? moduleTools : null}`, and `ExtensionsList` renders the section when `tools != null`. Name the label source explicitly; the catalog entry shape isn't in the packet, which is an evidence gap. Keep the `conversationId` fallback.

**F14. Per-package verification omits tests the plan says must pass, and one case needs a fixture hook.**
- **Plan location:** 04 WP1, WP3, WP4 verify commands.
- **Evidence:**
  - 02 relies on `journey:642,661`, `transcript-overrides:181` and `content-layout-image`, none of which are in WP3's verify list.
  - The extension-only test is missing from WP1 (see F9).
  - The 03 case "drop during an upload" needs a way to hold `status: 'uploading'`. The packet doesn't show that the test harness has one.
- **Correction:**
  - Add the missing files to each work package's `node --test` line.
  - In WP4, find or add the upload-stall hook before writing that case, and record it.

**F15. Auto-grow doesn't respond to width changes.**
- **Plan location:** 01 §Changes 5.
- **Evidence:** The effect is keyed only on `editor.text`. 04 requires that "at 520px the composer does not overflow".
- **Failure mode:** After a window resize, text rewraps but the height stays stale. The result is either clipped lines with a scrollbar or blank rows.
- **Correction:** Run the same measurement from a `ResizeObserver` on the textarea's width. `max-height: 40vh` already enforces the cap, so set `height = scrollHeight` and don't read the cap in JS.
