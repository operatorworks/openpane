# 04 — Execution handoff

Work on a feature branch off `main`, for example `simplify-conversation-screen`. Do not edit `.view-rail` or `.application-controls` markup or CSS.

## Work packages

### WP1 — Composer chrome
**Prerequisites:** none.
**Spec:** [01](01-composer-chrome.md).

Files and symbols:
- `ConversationView.tsx`: hidden header, `data-empty`, removal of the empty-state line and the disclosure, auto-grow textarea with `ResizeObserver`, `composer-send`.
- `ConversationPermissions.tsx`: new `permissionsShown`. `application-controller.ts`: `stalePermissions` and `readPermissions` keep `unsupported`, as specified in [02](02-permissions-and-tools.md) § Permissions.
- `agent-presentation.ts`: new `conversationPresentation`.
- `ConversationView` prop `customizationNotices` (new), computed in `BrowserApplication` from `custom.namespaces`.
- `ComposerAgentControls.tsx:97`: remove the effort chip.
- `BrowserApplication.tsx:178`: `buildLabel` via `composerVisible` and `activeDisclosure`.
- `application.css`.
- `tests/application/agent-routing.test.mjs:146-147`.
- `journey.browser.test.mjs:238`, only if the visibility wait fails.

Verify:

```bash
npm run check
```

```bash
node --test tests/application/agent-routing.test.mjs tests/application/journey.browser.test.mjs tests/application/composer-image.browser.test.mjs tests/application/controller.test.mjs tests/host/extensions/extension-only.test.mjs
```

### WP2 — Permissions gate
**Prerequisites:** WP1, because both edit the same area of `ConversationView`.
**Spec:** [02](02-permissions-and-tools.md) § Permissions.

Files and symbols:
- `ConversationView.tsx`: the gated mount (using WP1's `permissionsShown`), moved directly above the composer.
- CSS for `.permissions-panel`.

Verify:

```bash
node --test extensions/crew/tests/provider.test.mjs tests/application/controller.test.mjs
```

Also confirm that a Codex conversation shows no `region "Permissions"`, before and after a reconnect. Add this assertion to `journey.browser.test.mjs` next to `:238`.

### WP3 — Custom tools to Extensions
**Prerequisites:** WP1.
**Spec:** [02](02-permissions-and-tools.md) § Custom tools.

Files and symbols:
- `CustomizationModules.tsx`: `surface`, and a null result for empty sets.
- `BrowserApplication.tsx`: the three lists, their routing and `toolsEligible`.
- `ExtensionsView.tsx`: `ExtensionsList` gains `tools` and `conversation`.
- `content-layout.browser.test.mjs:40,190`: deliberate expectation changes.
- CSS.
- `module-actions.browser.test.mjs`.

Verify:

```bash
node --test tests/application/module-actions.browser.test.mjs tests/application/frontend-tools.browser.test.mjs tests/application/journey.browser.test.mjs tests/application/transcript-overrides.browser.test.mjs tests/application/content-layout.browser.test.mjs tests/application/content-layout-image.browser.test.mjs tests/application/extensions-view.browser.test.mjs extensions/coworkers/tests/desktop.browser.test.mjs extensions/crew/tests/desktop.browser.test.mjs
```

### WP4 — Image drop
**Prerequisites:** WP1, which owns the composer footer layout.
**Spec:** [03](03-image-drop.md).

Files and symbols:
- `image-intake.ts` (new).
- `BrowserApplication.tsx`: the window-level file-drop guard.
- `ConversationView.tsx`: `attach`, `blocked`, the drop handlers, the "+" button, and the chip moved above the textarea.
- CSS.
- `tauri.conf.json`.
- `composer-image.browser.test.mjs`: the new drop cases.

Pre-check, which must print nothing. If it prints anything, stop before setting `dragDropEnabled: false`, and report what it found:

```bash
grep -rn "drag-drop\|onDragDropEvent" apps/desktop
```

Verify:

```bash
node --test tests/application/composer-image.browser.test.mjs tests/application/content-layout-image.browser.test.mjs tests/application/selective-activity.browser.test.mjs
```

Required manual gate: [03](03-image-drop.md) Acceptance 2, in `npm run desktop:dev`.

## Parallelism

WP2, WP3 and WP4 all edit `ConversationView.tsx` and `application.css`, so run them one after another after WP1. WP3 also touches `BrowserApplication.tsx` and `ExtensionsView.tsx`, and it can be developed alongside WP4 only in separate worktrees that are merged in order.

## Integration gate

Run from the repo root:

```bash
npm run verify
```

This runs build, check, lint and test.

Then compare the new captures against the after-state wireframe in [00](00-overview.md). Use the screenshot in the request only as the "before" picture, and as the pixel reference for the rail and sidebar. Open the browser build with `npm run host:browser-dev` after `npm run build`, and open a Codex conversation in dark appearance. Capture these screenshots:
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
- The Tauri Finder-drop gate ([03](03-image-drop.md) Acceptance 2) passes, and the result is reported. If it fails, the work is not done (see 03).
- `git diff main -- apps/desktop/src/application/application.css` shows no changed `.view-rail` or `.application-controls` rules, and line 6 is untouched.
- In `git diff main -- apps/desktop/src/shell/BrowserApplication.tsx`, the `rail` and `controls` JSX blocks (`:97-133`, `:162-173` at the base commit) are unchanged.
- No untracked generated test artifacts are committed.

## Deferred and follow-ups

- Paste an image from the clipboard into the composer.
- A native-path drop, only if the WP4 gate shows WKWebView does not deliver `File` objects. That outcome reopens the plan; it does not close it.
- A per-host effort setting, which would reintroduce the effort chip once a host offers it.
