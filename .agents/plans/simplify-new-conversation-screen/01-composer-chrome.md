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
2. **Empty-state paragraph.** Delete the paragraph at line 137. When `empty` (below) is true, render `<p className="conversation-greeting">A conversation that stays with you.</p>` as the panel's first visible child, before `CustomizationContent`. It is a paragraph, not a heading: the visually hidden h1 stays the page heading.
3. **Empty predicate** (proposed local `const empty`). The panel is empty only when all of these hold:
   - `view.document.domain.messages.length === 0`;
   - `!continuation`;
   - `Object.keys(view.document.decisions).length === 0`;
   - `observationStatus` is absent or its kind is `'not-applicable'` or `'observing'`. These are the kinds that render no notice. `ProviderObservationStatus` is defined at `packages/contracts/src/observation.ts:19-22`, and the controller adds `'unknown'` at `application-controller.ts:37`;
   - `active.agent.availability.kind === 'ready'`;
   - `transcript.kind === 'default'`, `activity.kind === 'default'` and `contentLayout.kind === 'default'`. A claimed or conflicting selection renders its own content or an alert;
   - the domain has no command or file activity. Check that `view.document.domain.activities` is empty or absent. `CommandActivity` and `FileActivity` both filter this list before returning `null` (`CommandActivity.tsx:4-6`, `FileActivity.tsx:4-6`);
   - `recoveryModel(view)` (`recovery.ts`, already imported) returns empty `retained`, `uncertain` and `pending` lists. `CommandRecovery` renders a section only when one of them is non-empty (`CommandRecovery.tsx:15, 30`);
   - no customization namespace is `loading` or `failed`. Pass this in as a new optional `ConversationView` prop, `customizationNotices: boolean`, computed in `BrowserApplication` from `custom.namespaces`;
   - `permissionState` is absent or `!permissionsShown(permissionState)`.

   `permissionsShown` and its controller fix are part of this work package. They are specified in [02](02-permissions-and-tools.md) § Permissions.

   When any of these facts is uncertain, render the normal layout. Centring is cosmetic, so a false "not empty" result is harmless. Customization load or failure notices, if present, still render above the composer.

   Set `data-empty={empty ? 'true' : undefined}` on the section. Leave everything else in the panel as it is.
4. **Composer disclosure.** Delete `<p className="composer-disclosure">`. Its text moves to the footer (see below).
5. **Textarea.**
   - Change it to `rows={1}`.
   - Add a local `resize()` that sets `style.height = 'auto'`, then `style.height = scrollHeight + 'px'`. CSS `max-height: 40vh` enforces the cap, so JavaScript never reads it.
   - Call `resize()` from a `useLayoutEffect` keyed on `editor.text`. Skip the write when `scrollHeight` is 0, which happens while the view is `hidden`.
   - Also call it from a `ResizeObserver` on the textarea that reacts only when its content-box width changes. This covers window resizes, and the 0 → visible transition when the Chats view is unhidden after a draft changed while Extensions was shown.
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

- At line 178, show the disclosure wherever the active composer is visible: `const composerVisible = Boolean(app.active) && ((selectedView === 'chats' && !slots.workspace) || (workspaceOpen && Boolean(slots.workspace)))`. Then pass `buildLabel={composerVisible ? activeDisclosure : presentation.buildLabel}`.
- Compute `activeDisclosure` the same way `ConversationView.tsx:58` picks its presentation. Move that expression into a new exported helper, `conversationPresentation(active.agent, agent)`, in `agent-presentation.ts`, and have `ConversationView` call it too. The footer and the composer must never disagree.
- Other views, and the state with no conversation, keep `buildLabel`.
- Check `tests/host/extensions/extension-only.test.mjs:152,159`. They assert that the body has no "Recorded playback|Recorded host". In the extension-only host the presentation is a provider, so `presentation.footer` is a provider string. Confirm this when the test runs.

### `application.css`

Change only selectors scoped to `.conversation-panel` or `.composer`:

| Line | Change |
|---|---|
| 6 | **Do not edit.** This rule also lists `.application-controls` selectors. Line 120 already overrides the textarea outline later in the file. |
| 92 | `.conversation-panel > header` loses its padding and border. The `visually-hidden` class handles the rest. |
| 119 | Set `resize: none; overflow-y: auto; min-height: 24px; max-height: 40vh`. |
| 121 | Delete the `.composer:focus-within` rule. |
| 133 | Replace with `.conversation-panel .composer-send` (specificity 0,2,0, which beats `.conversation-panel button` at `:3`), a round 32px accent button. Give "+" ([03](03-image-drop.md)) and Stop `className="composer-setting …"` so they take the existing transparent chip look. |
| 237 and 239 | Delete `.composer-effort` and `.composer-disclosure`. |

Add these rules:

- `.conversation-panel[data-empty="true"] { justify-content: safe center; }`. `safe` keeps a tall composer scrollable instead of clipping its top.
- `.conversation-panel[data-empty="true"] .conversation-content { flex: none; min-height: 0; }`
- `.conversation-panel[data-empty="true"] .transcript { padding: 0; min-height: 0; }`
- `.conversation-greeting { margin: 0 0 16px; text-align: center; font-size: 22px; font-weight: 500; color: var(--aui-color-text); }`

Button `:focus-visible` outlines (lines 6 and 252) stay, so keyboard focus remains visible on every control except the textarea.

### Empty workspace (`BrowserApplication.tsx:72-77`)

No markup change. It loses the effort chip because it shares `ComposerAgentControls`. It has no textarea, so the ring and grip changes do not apply.

## Acceptance

1. An empty Codex conversation has `data-empty="true"` and shows the greeting "A conversation that stays with you." above the composer. The greeting is gone once `data-empty` is removed. The composer's vertical centre is within 10% of the panel's centre.
2. "Send a message to begin.", the effort button and `.composer-disclosure` have a count of 0. `.conversation-panel > header.visually-hidden` exists, and its bounding box is at most 1×1. Do not use `toBeHidden()` on the heading: Playwright treats clipped 1×1 boxes as visible.
3. `getByRole('heading', { name: 'Your conversation' })` still resolves, and `journey.browser.test.mjs:238` passes. The h1 keeps a non-empty box, so a visibility wait should succeed. If it does not, change that wait to `{ state: 'attached' }`. Never remove `visually-hidden` to make a test pass.
4. With the textarea focused:
   - `getComputedStyle(composer).boxShadow` is `'none'`;
   - the textarea's computed `outline-style` is `'none'`;
   - its `resize` is `'none'`.
5. The textarea grows as text is typed. After content taller than the computed `max-height` is entered, its height equals `max-height` and `scrollHeight > clientHeight`. Clearing the text shrinks it back. At 520px width, a rewrap changes the height.
6. When "Send" (the accessible name) is enabled, it submits as before.
7. The footer reads "Conversation connected" and "Local Codex · Approvals required for changes" while a Codex chat is open in the Chats view. With no conversation, or on the Settings view, the footer shows `buildLabel`. `tests/host/extensions/extension-only.test.mjs` passes.
8. After the first message is sent, `data-empty` is removed and the composer is at the bottom.

## Exclusions

- No changes to the picker.
- No changes to `.view-rail` or `.application-controls`.
