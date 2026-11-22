# Simplify the new-conversation screen

Status: Ready. Implementation has not started.

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

1. An empty Codex conversation shows a one-line greeting and the composer. The composer holds the placeholder, "+", the harness chip, the model chip and Send. The page also shows the shell footer. It does not show a visible header, a Permissions card, "Send a message to begin.", "Custom tools", the disabled effort chip or the in-composer disclosure line.
2. Typing in the composer shows only the caret. The computed `box-shadow` of `.composer` is `none` while the textarea has focus.
3. The textarea has no resize grip (`resize: none`). It grows with its content up to a cap, then scrolls.
4. Dropping a PNG or JPEG anywhere on the conversation panel attaches it. Invalid drops explain why and change nothing.
5. With the default layout, custom tool modules no longer render on the conversation screen. Non-empty modules appear in the Extensions view. Empty module sets render nothing anywhere. A content layout that claims the content area is a deliberate exception and still places the modules it receives ([02](02-permissions-and-tools.md) acceptance 6).
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
| Refinement | Opus and Sol completed in `research/refinement/pass-1`. Grok timed out and was retried once in `research/refinement/pass-1-grok-retry`. The packet's SHA-256 is in `research/refinement-packet.sha256`. Dispositions are in `research/refinement/dispositions.md`. Later local corrections, made after that snapshot, are listed there. |

## Risks and assumptions

- **Assumption:** with `dragDropEnabled: false`, the macOS WKWebView delivers HTML5 `File` objects. This is a required completion gate: a Finder drop in `npm run desktop:dev` ([03](03-image-drop.md) Acceptance 2). If it fails, the plan reopens to choose a native-path drop. The "+" picker does not count as meeting the drag-and-drop requirement.
- **Exception, by design:** a content layout that claims the content area still receives and places tool modules. Default and conflicting layouts never show tools in the column.
- **Assumption:** nothing in the app listens for `tauri://drag-drop`. Gate: `grep -rn "drag-drop\|onDragDropEvent" apps/desktop` returns nothing.
- **Tradeoff (non-blocking):** module actions in Extensions run against the active conversation while it is off screen. The section names that conversation.
- **Product choice (confirmed by the user on 2026-11-21, after reviewing mockups):** design C plus proposal A's greeting line, "A conversation that stays with you.", centred above the composer on an empty chat.

## Document map

| File | Purpose |
|---|---|
| [01-composer-chrome.md](01-composer-chrome.md) | Ring, grip, auto-grow, hidden header, empty-state centring, effort chip, footer disclosure. |
| [02-permissions-and-tools.md](02-permissions-and-tools.md) | The permissions gate, and moving custom tools to the Extensions view. |
| [03-image-drop.md](03-image-drop.md) | The "+" button, drag and drop on the panel, validation, and the Tauri setting. |
| [04-execution-handoff.md](04-execution-handoff.md) | Ordered work packages, commands, and the definition of done. |
| [research/](research/) | The brief, the decision record, the three proposals and the refinement record. |
