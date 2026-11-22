The selected design can meet the outcome. It needs closed decisions at seven places where an implementing agent would otherwise guess, unmount the wrong thing, or satisfy a test by putting chrome back. No new architecture is required.

## Coverage map

| Requirement | Plan location | Acceptance | Coverage |
|---|---|---|---|
| Calm empty Codex canvas: placeholder, "+", harness chip, model chip, Send, shell footer | `00` success 1; `01` goal and ASCII | `01` items 1, 2, 7, 8 | Partial. Predicate ignores the conflict alert and `CommandRecovery`. Empty ready namespaces still mount `<aside>`s. |
| No visible header, empty-state line, Permissions card, "Custom tools", effort chip, or in-composer disclosure | `00` table; `01` changes 1–2, 4; `02` gate; effort deletion | `01` item 2; `02` items 1 and 3 | Permissions negative case has no test command. Recorded string "Send a message to begin this recorded demonstration." is the same paragraph but is absent from `01` item 2. |
| Heading "Your conversation" and `.scope-label` stay in the DOM | `01` header | `01` item 3 | The visibility-wait edit is conditional, so the header can be made visible again to go green. |
| Typing shows only the caret; `.composer` `box-shadow` is `none` | `01` CSS lines 6 and 121 | `01` item 4 | Covered for the focused textarea. |
| `resize: none`; grows to a cap, then scrolls | `01` textarea and CSS line 119 | `01` item 5 | Criterion cannot be met as written: ten lines do not reach `40vh` on a normal window. |
| After the first message, composer sits at the bottom | `01` `data-empty` | `01` item 8 | Covered if `data-empty` is removed. |
| Send still submits | `01` Send button | `01` item 6 | Covered. `aria-label="Send"` keeps the accessible name. |
| Drop a PNG or JPEG anywhere on the panel attaches it | `03` drop zone and `tauri.conf.json` | `03` items 1 and 2 | Browser cases are specified. Finder success can be rejected before the extension fallback. Sidebar navigation has the wrong follow-up. |
| Invalid drops explain why and change nothing | `03` `dragVerdict`, `intakeFile`, drop states | `03` item 1, six cases | Size string is specified. Count and type strings for `intakeFile` are not. `imageError`’s `{store, message}` shape is not. |
| "+" is the keyboard path; Enter opens the chooser | `03` "+" button | `03` item 3 | Markup block has no `onClick`. Input value reset is not preserved. |
| Existing picker, chip, Retry, Remove, "Image file" stay | `03` tests that should pass unchanged | `03` item 1 | `Remove`’s accessible name is "confirm", not a fixed requirement. |
| Custom tools leave the default conversation screen; non-empty modules appear in Extensions | `02` routing; `00` success 5 | `02` items 3 and 4 | `00` success 5 forbids every conversation-screen module, which contradicts `02` item 6. |
| Empty module sets render nothing anywhere | `02` `ConversationModules` returns null | `02` item 3 | Only the "Custom tools" legend is checked. The empty `<aside>` remains. |
| Claimed layouts still receive modules | `02` `moduleAll` | `02` item 6 | Contradicts `00` success 5. No carve-out in the overview. |
| Load-failure alert stays in the conversation column | `02` `surface="status"` | `02` item 5 | Cited tests (`frontend-tools`, `journey`, `transcript-overrides`). Alert is inside the chats shell-view, which is `hidden` on Extensions. |
| Extensions tools name the active conversation | `02` `ExtensionsList` | `02` item 4 ("Runs in …") | Label source is "the catalog", which is not in the packet. `hasTools` can render the section with `tools={null}`. |
| Module actions from Extensions update the conversation | `02` test steps | `02` item 4 | Steps match the cited `module-actions` lines, including returning to Chats before the Message assertion. |
| Permissions only when the provider can show a listing; Crew revoke and Refresh stay | `02` table and `permissionsShown` | `02` items 1 and 2 | Gate is unresolved ("Refinement decides"). Unmount drops the focus listener. WP2 runs only the Crew test. |
| Disclosure moves to the shell footer on Chats | `01` `buildLabel` | `01` item 7 | Workspace uses the same composer and loses the line. `extension-only.test.mjs` is "confirm when it runs" and is not in the WP1 command. |
| Effort chip removed, including the empty workspace | `01` `ComposerAgentControls` | `01` item 2; `agent-routing.test.mjs:146-147` | Covered. |
| Rail and Chats sidebar markup and CSS unchanged | `00` success 6; `01` exclusions; `04` | `04` CSS diff check | Covered if shared selectors that also mention `.application-controls` are left intact. |
| No greeting, no picker redesign, no byte sniffing, no native-path drop, no paste, no iOS | `00` non-goals; `01` and `03` exclusions; `04` deferred | None, correctly | Host remains the content authority (`intakeFile` checks MIME and extension only). |
| `dragDropEnabled: false` only if nothing listens for `tauri://drag-drop` | `00` risks; `03`; `04` WP4 pre-check | Pre-check prints nothing | No stop rule if the grep prints a hit. |
| Full gate | `04` integration | `npm run verify`, screenshots, manual Finder drop | "Compare against the screenshots in the request" points at the before picture. |

## Findings

### 1. Blocking — Permissions gate unmounts the only focus refresh

**Plan location:** `02` Permissions, the `permissionsShown` note that says "Refinement decides."

**Evidence:** `PermissionState` is `fresh` with a listing, `loading` or `stale` with `listing | null` and a `reason`, or `unsupported` with a `reason`. The initial value is `{kind:'stale', listing:null, reason:'Open a conversation to read permissions.'}`. `ConversationPermissions.tsx:15-19` registers the window `focus` reader only while the component is mounted, and it does not read on mount. The revoke failure string "Revocation failed. Refresh permissions." is local state at line 24, not a `PermissionState` reason. Controller transitions after a failed read are not in the packet.

**Failure mode:** `{permissionsShown && <ConversationPermissions/>}` unmounts the listener for every `stale` or `loading` state with a null listing, which is the state a new conversation starts in. A later `stale` null listing with a real reason also has no Refresh control. The agent string-matches "Revocation failed…", which never appears on `PermissionState`, or shows the placeholder card again so the Crew test can find `region "Permissions"`.

**Correction:** Close the predicate. Render the panel when `kind !== 'unsupported'` and `listing !== null`, and also when `kind === 'stale'`, `listing === null`, and `reason !== 'Open a conversation to read permissions.'`. Keep `loading` with a null listing hidden. Mount `ConversationPermissions` for every non-`unsupported` state, run the focus effect unconditionally, and `return null` after the hooks when the predicate is false. If `extensions/crew/tests/provider.test.mjs` queries the region before the listing exists, wait for the region. Leave the placeholder card hidden.

### 2. Blocking — Empty module chrome, and the Extensions section can render with no tools

**Plan location:** `02` Custom tools; `00` success criterion 5.

**Evidence:** `CustomizationModules` always returns an `<aside aria-label="Customization …">` (`CustomizationModules.tsx:81-90`). `.customization-panel` has `padding: 8px 0` (`application.css:212`). Crew and coworkers both use `modules: []`. `module-actions.browser.test.mjs:27` finds `complementary "Customization fixture"`. `00` success 5 says modules render nowhere on the conversation screen; `02` acceptance 6 says a claimed layout still receives `moduleAll`. `hasTools` is computed from namespaces, while `tools` is null when `!app.active` or the layout is claimed. No catalog type or conversation-label field is in the packet. `active.scope.conversationId` is what `.scope-label` already shows.

**Failure mode:** Ready empty namespaces leave two labeled complementary regions, with padding, on the calm canvas. Acceptance 3 still passes because it only looks for the legend "Custom tools". `surface="tools"` drops the `<aside>`, and the fixture test fails. `hasTools` renders "Conversation tools" and `Runs in {null}` with an empty body. The agent invents a catalog lookup, or restores empty fieldsets so `extensions/coworkers/tests/desktop.browser.test.mjs` stays green. Another agent deletes claimed-layout modules to satisfy success criterion 5 and breaks the content-layout tests.

**Correction:** One render table:

| Surface | Loading or failed | Ready and `modules.length === 0` | Ready with modules |
|---|---|---|---|
| `status` | The aside and the existing notice | `null` | `null` |
| `tools` | `null` | `null` | The aside, the fieldset, and the modules |
| `all` | The aside and the notice | `null` | The aside, the fieldset, and the modules |

Render the Extensions section only when `app.active` is set, the layout is not claimed, and at least one ready namespace has modules. Its sentence is `Runs in {active.scope.conversationId}.` Amend `00` success 5 so claimed layouts are the exception stated in `02` acceptance 6. If the coworkers test expects an empty "Custom tools" fieldset, update the test. Do not restore the fieldset.

### 3. Blocking — `data-empty` ignores chrome the plan itself keeps

**Plan location:** `01` empty predicate, "Leave everything else in the panel as it is."

**Evidence:** `CustomizationContent.tsx:14-15` renders a content-layout conflict alert, and the predicate does not exclude `kind === 'conflict'`. `02` leaves loading and failure notices in the column, and the predicate does not mention them. `CommandRecovery` is always mounted at `ConversationView.tsx:218`. Its render rules are not in the packet. `CommandActivity` and `FileActivity` returning null only covers those two children.

**Failure mode:** `data-empty="true"` is set while an alert, a load notice, or recovery chrome is on screen. Acceptance 1’s 10% centering check fails, or it passes while success criterion 1 ("only the composer") is false. The agent satisfies the named invisible-text list and leaves the extra sibling.

**Correction:** Treat the canvas as empty only when the existing predicate holds and `contentLayout.kind !== 'conflict'` and no namespace is `loading` or `failed`. Read `CommandRecovery` before implementing. If it renders anything while there is nothing to recover, return null in that case and require the same in acceptance `01` item 2.

### 4. Blocking — Auto-grow records a collapsed height, and the growth check does not reach the cap

**Plan location:** `01` textarea effect and acceptance item 5; empty-state CSS `justify-content: center`.

**Evidence:** The chats shell-view stays mounted with the `hidden` attribute while Extensions is open, so this effect is not torn down and does not re-run when the view is shown again. The effect is keyed only on `editor.text`. A `hidden` subtree has no layout box, so `scrollHeight` is 0. CSS keeps `font-size: 14px` and `line-height: 1.5` (`application.css:119`); ten such lines are about 210px plus padding. The cap is `40vh`, which is taller than that whenever the viewport is taller than about 525px. The panel is a nested flex column with `overflow-y: auto` (`application.css:88-90`), and the textarea cap is a fraction of the viewport, so the centered composer can overflow the panel.

**Failure mode:** After a trip to Extensions, a multi-line draft stays clamped to `min-height: 24px` until the next keystroke. The agent shrinks the cap until ten lines overflow, which changes the design. `justify-content: center` clips the top of a tall composer and the user cannot scroll to it.

**Correction:** Remeasure in a `ResizeObserver` on the textarea, and skip the write when `scrollHeight` is 0. Set the inline height from `scrollHeight` and let CSS `max-height` clamp it. Use `justify-content: safe center`. Replace acceptance item 5 with two checks: two lines increase the used height, and a value whose `scrollHeight` exceeds the computed `max-height` leaves the used height at that cap and scrolls.

### 5. Blocking — The approvals line is removed from every composer, then restored on only one view

**Plan location:** `01` `BrowserApplication.tsx` `buildLabel`; `04` WP1 verify list.

**Evidence:** The disclosure is deleted from shared `ConversationView`, which the workspace also mounts (`workspaceConversation = slots.workspace ? activeConversation : null`, with `workspaceOpen` at `BrowserApplication.tsx:59`). The replacement runs only for `selectedView === 'chats' && app.active`. Codex footer text is `Local Codex · Approvals required for changes`. Recorded footer text is `Recorded playback · No live model`, and recorded `buildLabel` is `Browser development · Recorded host`. `tests/host/extensions/extension-only.test.mjs:152,159` assert that body text lacks `/Recorded playback|Recorded host/`. The plan’s claim that this host’s presentation is a provider is not in the packet. WP1’s command does not run that test.

**Failure mode:** A workspace conversation shows the composer with the approvals line nowhere. WP1 goes green, then full verify fails the extension-only test. The agent deletes the assertion or stops moving the disclosure, and Codex acceptance item 7 fails with it.

**Correction:** Use `presentation.footer` whenever `app.active` is set and the conversation panel is the visible surface: Chats, or `workspaceOpen`. Keep `buildLabel` on Settings, on Extensions when the workspace is closed, and when no conversation is open. Add `extension-only.test.mjs` to the WP1 command. If that test fails, leave its assertion as it is and keep `buildLabel` for any presentation whose footer matches the forbidden pattern. Codex does not match, so acceptance item 7 still holds.

### 6. Blocking — Scoping the accent fill to `.composer-send` drops the Send and Stop styles

**Plan location:** `01` CSS line 133 and the Send/Stop notes.

**Evidence:** `.conversation-panel button` (`application.css:3`) is specificity `(0, 1, 1)`. `.composer-footer button` (`application.css:133`) is `(0, 2, 0)` and currently beats it. A bare `.composer-send` is `(0, 1, 0)` and loses to line 3. Stop has no `composer-setting` class. Line 234’s transparent chip style applies only to `.composer-setting`. Line 3 also styles `.application-controls button`.

**Failure mode:** Send becomes the large bordered panel button. Stop does too. The agent edits line 3 to repair Send and changes the application-controls buttons, which the handoff forbids.

**Correction:** Leave line 3 and every `.application-controls` selector untouched. Add `.conversation-panel .composer-send` for the 32px accent button. Add `composer-setting` to Stop. Removing `.composer textarea:focus-visible` from the shared outline list on line 6 is optional; line 120 already sets `outline: none` at equal specificity later in the file.

### 7. Blocking — The drop path disagrees with itself, and the manual-failure follow-up is the wrong fix

**Plan location:** `03` "+" markup, `attach`, `dragVerdict`, drop handlers, tests; `04` WP4 manual check.

**Evidence:** The specified "+" markup has no `onClick`. The current chooser clears `event.target.value` before reading the file (`ConversationView.tsx:200-206`). `imageError` renders only when `imageError.store === active.store` (lines 73 and 211). `dragend` fires on the drag source, and the plan attaches it to the panel. `preventDefault` is only on the panel, while acceptance item 2 requires a sidebar drop not to navigate. A failed manual check is defined as a native-path follow-up. `intakeFile`’s extension fallback runs only after `dragVerdict` returns accept, and `dragVerdict` rejects every known type other than PNG or JPEG. Finder item MIME types are not in the packet. React 17 delegates listeners at the root, so a synthetic drop must bubble.

**Failure mode:** "+" does not open the chooser, so acceptance item 3 fails. The same file cannot be chosen twice. A reject sets a string into `imageError` and the alert never appears. The outline sticks after Escape or a drop outside the panel. A sidebar drop navigates, and the agent files a native-path follow-up instead of preventing the navigation. A Finder PNG whose drag type is not exactly `image/png` or `image/jpeg` is rejected before the extension fallback, and the manual test is reported as a webview limitation. The browser tests dispatch a `DragEvent` that never reaches `onDrop`.

**Correction:** Keep one drop contract.

- The "+" `onClick` is `imageInput.current?.click()`. On change, copy `files[0]`, set `value = ''`, then call `attach`.
- Copy `dataTransfer.files` into an array synchronously inside `onDrop`, then recompute the verdict from that event. Ignore React drag state for the decision.
- Write errors only as `setImageError({ store: active.store, message })`, or throw `Error` inside `imageAction`, which already does that.
- Use these reject strings in both functions: count other than 1 → "Drop one image at a time."; type not PNG or JPEG → "Drop a PNG or JPEG image."; size → "Choose an image of at most 4 MB."
- At drag time, reject `image/*` other than `image/png` and `image/jpeg`, multiple files, and `blocked`. Treat an empty type, `application/octet-stream`, and any non-image type as accept, then let `intakeFile` decide on drop so the extension fallback still runs.
- `blocked` uses the existing expression: `imageInput.kind === 'unsupported' ? imageInput.reason : 'This agent cannot receive images.'`
- Reset the depth counter and `drop` to idle on `drop`. Also listen for `dragend` on `document`.
- On `document` `dragover`, if `types` contains `Files`, call `preventDefault` and do not set `dropEffect` or `data-drop`. The panel alone sets `dropEffect` and the outline.
- If the Finder drop delivers a `File` and intake still rejects a `.png` or `.jpg`, report that. File a native-path follow-up only when the panel drop’s `dataTransfer.files` is empty. If the WP4 grep prints anything, stop before setting `dragDropEnabled: false`.
- Tests: `new DataTransfer()`, `items.add(file)`, then `dragenter`, `dragover`, and `drop` with `bubbles: true` and `cancelable: true`. The Remove control’s accessible name stays `Remove`.
- Deleting `.composer-attachments button` (`application.css:127`) leaves Retry on the large line-3 button. Give Retry the compact chip-button padding when that rule is removed.

### 8. Improvement — The heading wait will fail closed, and the screenshot check points at the old screen

**Plan location:** `01` acceptance item 3; `04` integration gate.

**Evidence:** `.visually-hidden` (`application.css:140`) clips the header, so a default visibility wait on `getByRole('heading', { name: 'Your conversation' })` times out. `journey.browser.test.mjs:238` is that wait. The integration text says to compare against the screenshots in the request, and those screenshots are the current busy screen. Rail and sidebar pixel checks are separate and already correct.

**Failure mode:** The agent removes `visually-hidden` to satisfy the journey wait, or restores Permissions, tools, and the ring to match the request screenshot.

**Correction:** In WP1, change that wait to `state: 'attached'` and keep the header visually hidden. Compare the new empty, pending-image, and Crew captures to the ASCII after-state in `00`. Use the request screenshot only as the before image for the rail and sidebar.

### 9. Improvement — Permissions padding shares selectors with decision cards and the outbox

**Plan location:** `02` `.permissions-panel` CSS.

**Evidence:** Padding and margin for this panel come from grouped rules at `application.css:16` and `:134`, shared with `.decision-card` and `.outbox`.

**Failure mode:** Editing those groups in place changes decision cards and the outbox.

**Correction:** Add a later `.conversation-panel .permissions-panel` rule for `padding: 10px 12px` and `margin-top: 8px`. Leave the grouped selectors as they are.
