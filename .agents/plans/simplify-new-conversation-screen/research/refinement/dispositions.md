# Refinement dispositions (pass 1)

The reviewed packet is `research/refinement-packet.md`; its SHA-256 is in `refinement-packet.sha256`. I checked each claim against the source before accepting it.

## Opus findings

| ID | Priority | Disposition | Where it landed |
|---|---|---|---|
| F1 | Off-panel drops navigate the webview | Accepted. | Window-level guard ([03](../../03-image-drop.md)); rail drop test. |
| F2 | Permissions gate and first read | Accepted with a different fix. The controller already reads on open, reconnect and after commands (`application-controller.ts:445, 464, 470, 619`), so a mount-driven read is not needed. The real bug, checked in source: `stalePermissions` turns `unsupported` into `stale`/null on disconnect (`:260-263`). It is fixed in the controller, and the predicate is now kind-only, with no reason strings. | [02](../../02-permissions-and-tools.md) § Permissions |
| F3 | `dropEffect = 'none'` means no `drop` event | Accepted. | [03](../../03-image-drop.md) drop zone and state table |
| F4 | Alert hidden for agents without image input | Accepted. | [03](../../03-image-drop.md) composer feedback |
| F5 | `.composer-send` loses on specificity | Accepted. Checked: `application.css:3` is `.conversation-panel button`. | [01](../../01-composer-chrome.md) CSS; [03](../../03-image-drop.md) CSS |
| F6 | WP1 depends on WP2's symbol | Accepted. | `permissionsShown` moved into WP1 |
| F7 | The line 6 edit touches `.application-controls` | Accepted. Checked: `application.css:6`. | [01](../../01-composer-chrome.md) CSS table |
| F8 | Empty `<aside>` wrappers stay in the DOM | Accepted. Two tests change deliberately (`content-layout.browser.test.mjs:40, 190`). | [02](../../02-permissions-and-tools.md) |
| F9 | Footer condition is wrong in workspaces | Accepted. | [01](../../01-composer-chrome.md) BrowserApplication |
| F10 | Playwright treats 1×1 boxes as visible | Accepted. | [01](../../01-composer-chrome.md) acceptance 2 |
| F11 | Role locators skip hidden elements | Accepted. | [02](../../02-permissions-and-tools.md) test updates |
| F12 | Empty predicate misses activity and outbox | Accepted. Checked: `domain.activities`, `CommandActivity.tsx:4-6`. | [01](../../01-composer-chrome.md) |
| F13 | `hasTools` and `tools` drift | Accepted. Eligibility is now computed once. | [02](../../02-permissions-and-tools.md) |
| F14 | Missing test files and upload-stall hook | Accepted. | [03](../../03-image-drop.md) tests; [04](../../04-execution-handoff.md) |
| F15 | Auto-grow ignores width changes | Accepted, as a `ResizeObserver`. | [01](../../01-composer-chrome.md) |

## Sol findings

| ID | Disposition |
|---|---|
| 1 | Merged with F2. Accepted through the controller fix. The window-focus listener only unmounts for `unsupported` or during the first read. A failed read stays visible as `stale`, with Refresh. |
| 2 | **Partly rejected.** Moving tools out of claimed layouts would redefine the `ConversationContentLayoutProps.modules` slot. A claimed layout is a customization the user installed in order to arrange tools, so this is not the default clutter the request targets. No bundled extension claims a layout. The eligibility-unification part is accepted (see F13). |
| 3 | Merged with F8. Accepted. |
| 4 | Merged with F1. Accepted. |
| 5 | Merged with F3. Accepted. |
| 6 | Accepted. `attach` enforces `blocked`, uses a per-store intake guard and a remove-generation counter, and keeps the alert outside the gate. |
| 7 | Merged with F15. Accepted. The `ResizeObserver` also covers the 0 → visible transition when Chats is unhidden. |
| 8 | Accepted, together with F12. Centring now requires `default` transcript, activity and layout selections, so conflicts are excluded. Customization notices still render; centring does not hide them. |
| 9 | Accepted. The Finder drop is now a required completion gate. If it fails, the plan reopens. |

## Grok

The pass-1 seat timed out (exit 124). It was retried once with `--timeout 1200` and completed (`pass-1-grok-retry/grok`). It reviewed the same snapshot.

| ID | Disposition |
|---|---|
| 1 | Accepted. Same root issue as F2, resolved by the controller fix and the kind-only predicate. Reason-string matching was rejected. |
| 2 | Accepted. Its render table matches the surfaces. The overview's success criterion 5 now states the claimed-layout exception. Using the catalog label was kept: `conversationLabel` and `app.catalog.items` exist (`BrowserApplication.tsx:16, 117-118`), with a fallback to the conversation ID. |
| 3 | Accepted. The predicate now uses `recoveryModel(view)` (checked: `CommandRecovery.tsx:15, 30`), a `customizationNotices` prop, and default-only selections. |
| 4 | Accepted. Skip writes when `scrollHeight` is 0, use `safe center`, and use the two-part growth check. |
| 5 | Already covered by F9. |
| 6 | Already covered by F5 and F7. |
| 7 | Accepted: the "+" `onClick`, the input reset, the `imageError` shape, permissive drag-time types (so the extension fallback still runs), a `document` `dragend` listener, a grep stop rule, and bubbling test events. Its point that a failed Finder drop is "the wrong fix" is folded into the required gate. |
| 8 | Partly accepted. Clipped 1×1 elements still count as visible to Playwright, so the visibility wait should pass. The fallback to `attached` stays, with an explicit rule never to remove `visually-hidden`. The screenshot comparison now targets the after-state wireframe. |
| 9 | Accepted: a scoped `.conversation-panel .permissions-panel` rule. |

## Follow-up pass

None of the corrections changes the selected architecture: placement, surfaces and drop model are unchanged. They tighten interfaces, the controller state and the gates. No blocking finding is unresolved, so no second all-seat pass is required.
