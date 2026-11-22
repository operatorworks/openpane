# Decision record — simplify the new-conversation screen

## Hard constraints (checked before scoring)
1. Icon rail and Chats sidebar unchanged.
2. Composer has no focus ring/accent highlight while typing and no textarea resize grip.
3. Image attach works by drag-and-drop onto the conversation/composer in both browser and Tauri builds; PNG/JPEG + 4 MB contract unchanged. A keyboard-reachable fallback remains (accessibility), but there is no standalone "Add image" button row.
4. "Custom tools" fieldsets no longer render on the conversation screen; module actions stay reachable from another surface (or remain only via a claimed content layout).
5. Crew permission listing + revocation stays reachable with the "Permissions" region and "Refresh permissions" button contract (or tests are updated with a named rationale).
6. No pairing/attestation/device features (AGENTS.md).

## Selection criteria (predeclared, before reading proposals)
- C1 Visual calm: count of persistent chrome elements on an empty Codex chat (target: composer + at most one light context line).
- C2 Still OpenPane: reuses existing tokens (`--aui-color-*`), rounded raised composer, chip-style settings; no new design language or dependency.
- C3 Smallest coherent change: fewest new components/state; prefers deleting/relocating over adding layers.
- C4 Behaviour preserved and testable: every relocated control has an observable acceptance check and existing tests are updated, not deleted, where behaviour survives.
- C5 Clear ownership: Custom tools and permissions land in a surface whose owner already has the needed context (active conversation for module actions).

## Proposals
(filled after the panel runs)

| Seat | Design name | Central idea |
|---|---|---|
| Opus (`proposals/pass-1/opus`) | **A — Composer hub** | Header visually hidden; greeting + centred composer when empty; "+" and a "Tools" chip (popover) inside the composer; permissions only when supported; disclosure moves to the shell footer's right side; auto-growing textarea; drop target is the whole panel. |
| Sol (`proposals/pass-1/sol`) | **B — Details drawer** | One combined "Codex · GPT-6.2 Sol" picker; a "…" conversation-details panel above the composer holds identity, disclosure and permissions (auto-opens when grants appear); module actions move to a "Conversation tools" section in Extensions; byte-sniffing image validation. |
| Grok (`proposals/pass-1/grok`) | **C — Show only what can act** | Delete chrome that only says "nothing here": permissions mount only with a listing, empty module sets render nothing, non-empty modules move to the Extensions view, effort chip removed, disclosure kept visually hidden; "+" button + composer drop target. |

Convergence: all three agree on removing the ring and grip, deleting the disabled effort chip, a "+" that keeps the "Add image"/"Replace image" accessible names, a hidden "Image file" input, and `"dragDropEnabled": false` in `tauri.conf.json`. They diverge on where custom tools go (composer popover vs Extensions), how runtime details are shown (footer vs drawer vs hidden), and whether to add a combined picker. These are three real designs; no divergence pass was needed.

## Hard-constraint check
All three pass constraints 1–3 and 5–6. On constraint 4, A keeps tools on the conversation screen behind a chip. That reads against the user's "Custom tools should be configured elsewhere", so A fails C5.

## Scores (1–5)
| Criterion | A | B | C |
|---|---|---|---|
| C1 Visual calm | 4 (greeting + chip) | 4 (adds a "…" trigger) | 5 |
| C2 Still OpenPane | 5 | 4 (picker restructure) | 5 |
| C3 Smallest coherent change | 3 (3 new files, popover) | 2 (drawer, picker rewrite, sniffing) | 5 |
| C4 Behaviour preserved / testable | 4 | 4 | 4 (deletes header used by `journey` and `module-actions` tests) |
| C5 Clear ownership | 3 | 4 | 4 |

## Selection
Base: **C — Show only what can act**. It removes the most chrome with the fewest new parts. It is also the only design that moves both empty and non-empty tools off this screen without adding a new trigger to it.

Grafts adopted:
- From A: keep the header in the DOM, visually hidden, rather than deleting it. `journey.browser.test.mjs:238` waits for the heading "Your conversation", and `module-actions.browser.test.mjs:85` reads `.scope-label`. Screen readers keep the landmark.
- From A: gate permissions on `PermissionState.kind` rather than on whether a listing exists. The `unsupported` kind is verified at `application-controller.ts:41-44`.
- From A: auto-grow the textarea up to a cap. Without a grip, a fixed three-row box makes long prompts awkward.
- From A: on the Chats view the shell footer's right side shows `presentation.footer` ("Local Codex · Approvals required for changes") in place of `buildLabel`. The approval policy stays visible without sitting in the composer.
- From A: the whole conversation panel is the drop zone, and the composer shows the drag feedback.
- From B: the Extensions tools section names the conversation it acts on.

Rejected:
- A's Tools chip. It keeps tools on this screen.
- B's combined picker. It changes harness-switching behaviour, and that is out of scope.
- B's details drawer. It adds a new trigger on this screen.
- B's byte-signature sniffing. The host stays the authority. An empty MIME type falls back to the file extension, as in C.
- A's greeting line. An empty canvas with the placeholder is calmer and matches Cursor/Claude; noted as a product choice the user can reverse.
- C's extra `.disable_drag_drop_handler()` in `main.rs`. `from_config` already reads `dragDropEnabled`, so the call is redundant.

Unresolved tradeoff (non-blocking): module actions in Extensions run against a conversation that is not on screen. This is acceptable because no bundled extension ships modules (crew and coworkers both return `modules: []`). The section labels the target conversation.
