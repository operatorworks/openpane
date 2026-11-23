# Agent experience implementation record

The requested plan is `/Users/punk1290/git/openpane/.agents/plans/agent-driven-experiences/`.
Implementation is on `codex/agent-driven-experiences` from
`ca8814a` (origin/main on 2026-11-22). The original checkout's Cargo.lock and
`.claude/` settings are preserved. No pairing or attestation is added.

## Reconciliation

The plan's source snapshot predates #146 and #141. Origin-local palette and
personalization support now exists. Live host experiences must provide one
selected visual frame while preserving namespace preferences and saved work.
The host status-read correction remains intact. Service wire 16 is unchanged.

## Unit A evidence

- Node 24.22.3 / npm 11.19.1: toolchain check and dependency installation passed.
- Contracts and theme: strict experience/metrics parsers, discovery schemas,
  UI ownership types and the pinned AG-UI CUSTOM validator. New tokens inherit
  through the existing theme provider; omitted values retain builtin output.
- Focused protocol/theme/browser checks: 57 passed. The application probe
  preserved the actual textarea node, focus, selection, composition, persisted
  draft, pending approval and command count across a visual edit. Its visual
  source is disposable; it does not qualify production delivery.
- Native transport fixture: packaged, ad-hoc signed Tauri 2.12.5 application
  on macOS 26.6.2, main plus eight WKWebViews, shared IndexedDB and Web Locks,
  duplicate focus reuse, close/reopen draft recovery, child command exclusion,
  targeted native relay and wrong-document rejection. Main remained minimized
  for over five minutes; every child observed final generation 142. Synthetic
  interactions test the native command transport, not provider execution.
- Actual app-server Codex 0.167.2 through the packaged host: ChatGPT login,
  read-only sandbox/on-request approvals preserved, three approved operations,
  workspace file edit and a harmless same-user socket request with exact scope.
  The actual configured pup 1.23.6 ran with `--no-agent --output=json`, fixed
  epoch-second bounds, `DD_SITE=us3.datadoghq.com`, and no organization override.
  Its raw response contains `series[].pointlist` with epoch-millisecond times.
  No production query normalizer or display publication has been qualified yet.

Private artifacts (outside the repository):

- Native: `/var/folders/3s/_jrxnd6s1tl_lhh2mqtxx1xc0000gn/T/openpane-native-qualification-HGxvaD/`
- Actual agent/CLI/pup: `/tmp/op-ui-aDKmB9/`
- Focused checks: `/tmp/openpane-unit-a-tests.log`
- Workspace build: `/tmp/openpane-agent-build.log`
- Workspace type checks: `/tmp/openpane-agent-check.log`

### Native admission correction

The first fixture's exact-document remote capability failed: native IPC reports
its remote caller URL as the origin root. The corrected capability names that
exact scheme/host/port origin (no wildcard origins) and exact registered label.
The command additionally checks `window.url()` against the full admitted
`/browser.html` URL before any effect. A granted-origin document at the wrong
path/query was rejected by the native command in the rerun. Navigation and
popup denial remain independent. Production must use this same admission.

### Rerun the probes

After the normal workspace build:

```sh
node --test tests/protocol/*.test.mjs tests/theme/*.test.mjs tests/application/experience-stability.browser.test.mjs
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features experience-probe --bin experience-probe
node tests/desktop/experience-probe/run.mjs
node tests/desktop/experience-probe/cli.mjs /absolute/pinned/codex /absolute/configured/pup
```

The native probe takes over five minutes and opens disposable native windows.
The CLI probe uses a short private `/tmp` path because macOS Unix sockets have a
path-length limit. It uses the user's existing subscription and pup login,
requires ordinary scoped approvals, and retains its evidence. It does not
change either login or expand the Codex sandbox.

## Unit B checkpoint

The host/browser path now implements immutable bundle validation, the separate
UI database and private UI socket, installed `main.js ui` dispatch, request
replay and epochs, capacity and reserved builtin recovery, scoped asset serving,
a single browser UI reader, painted-window receipts, and live application around
the existing controller/editor. The production Codex driver receives a separate
versioned CLI context item per send and resume; canonical messages remain clean.

The existing PNG decoder validates artwork fully before a selection can commit.
The bundle digest preserves authored token bytes, including color case. Human
text limits use the same Unicode character counting as the discovery schemas.
Normal receipt accounting reserves space for later failed-render reports.

The copied installed bundle outside the checkout passed schema discovery and a
real stylesheet-validation/apply command. Browser checks passed live paint,
immutable refresh, failed stylesheet rollback, builtin restore, and preservation
of editor identity and saved draft. Host checks passed replay/conflict/stale
writes, restart, 4096-receipt and bundle capacity, bounded cohorts, compaction,
pruning and full-capacity builtin recovery.

`npm run verify` passed at this checkpoint: 3,988 passed, five existing skips,
zero failures (3,993 total). Rust tests passed 40/40; formatting and diff checks
passed. Logs are `/tmp/openpane-experiences-verify-ab-checkpoint.log` and
`/tmp/openpane-cargo-unit-a.log`. Prior failed/inconclusive runs are retained for
reproduction; they are not counted as passes. The shutdown test now observes the
durable acceptance file directly because macOS directory notifications can arrive
after recorded playback has completed.

## Unit C implementation

The production browser entry selects a window role before creating a controller.
The native broker persists allocations and child requests privately, checks the
exact document and incarnation, and creates one editor per scope. Main relays
appearance state to children. Each child receives its own delivery envelope.
Placement and visual outcomes have independent receipts.

Each conversation has a dedicated IndexedDB view. Conversation locks precede
view locks. Scoped migration preserves other conversations and moves draft,
image and outbox records atomically. A persisted writer generation rejects late
callbacks. Draft carry between conversations copies only captured unsent text
and clears it with a revision check after the destination confirms it. Pending
creation, failed windows and child requests retain their recorded identities
for explicit recovery. Closed-view tool recovery inspects saved journals without
connecting a conversation or sending commands, and skips live view owners.

SDK compatibility is 0.14.0. Workspace open/create returns inline, detached,
pending or refused outcomes. The service wire remains 16.

Actual production native checks opened main and two children, preserved distinct
drafts, reused an existing window, closed one child without closing its siblings,
and restored a closed chat inline with its original draft. Native checks found
and fixed a main-thread dispatch deadlock and event listeners that accepted
other windows' events. Their private evidence is in
`/tmp/openpane-native-production-qualification-20261122/`. That package predates
later receipt and recovery changes, so final native qualification remains open.
The latest native model tests pass 48/48. Browser storage tests pass nine cases,
including interrupted migration, stale writers, draft carry and failed-window
inline recovery. `npm run verify` passes 4,006 tests with five existing skips and zero failures
(4,011 total). The complete log is `/tmp/openpane-c-full-verify-six.log`.
The native broker tests and formatting also pass. The timeout regression in
the installed-builder test now shortens only the deadline under test, so a
healthy startup probe keeps its normal deadline during the execution test.

The configured overlay SSH host is available. Node 24.22.3 and pup
2.0.1 are available there. With `DD_SITE=us3.datadoghq.com` and
`DD_TOKEN_STORAGE=file`, authentication and an actual fixed-range metrics query
passed. Its response has `resp_version: 1` and epoch-millisecond pointlist times.
Private raw evidence stays on that host under
`~/.cache/openpane-qualification/pup-shape-20261122/`.

## Unit D implementation

Saved display data lives in the separate UI database. Publications use an explicit
conversation scope, strict named CUSTOM events and immutable payloads. Query
reservations retain their absolute range and executable metadata. Direct pup
processes have bounded output, deadlines and ownership fences. Replay and
reconnect do not start another query; retry is explicit. Snapshot paging and
native relay budgets bound delivery without discarding active cards.

The app-owned card region follows transcript content, including extension
layouts. SVG plots preserve null gaps, separate units and expose an exact values
table. Experience tokens and semantic styles change the card without changing
its saved event. Cards do not enter provider history or the command journal.

## Unit E acceptance

Launcher-default app-server Codex authored the optional violet Messenger 2002
variation in an isolated workspace with ordinary one-time approvals. Fresh
profiles remain builtin. Main navigation reached Chats, Extensions and Settings.
Two actual native chats retained separate drafts and approval authority. Native
restyle apply and refresh receipts report all-rendered for main and both chats
plus one idle transition slot (three actual windows, four receipt slots).

The local pup 1.23.6 publication retained all 179 points, timestamps, labels and
units in an independent comparison against captured raw output. Its publication
ID and immutable event remained identical after restyling, reconnect, child
reopen and host restart. Its query counter remained one. The native plot uses
the selected chart colors and complete theme tokens; the axis has no area fill.

Eight production native children each received a nine-card snapshot, exercising
multiple delivery pages. With main continuously minimized, each received a new
publication after 326–349 seconds. A visible child also completed a normal
Codex response during the minimized interval. Hidden windows retain explicit
pending paint outcomes until activated. Builtin restore kept existing child
owners and a future new chat opened inline in main.

A plain shell followed context/targets/schema discovery, applied an optional
bundle variation and published a normalized CUSTOM card to an explicitly chosen
nonactive conversation. The correct native chat rendered it. Interrupting a
wait preserved the original request and recoverable status. Invalid bundle
input left the selected revision unchanged. Missing executable, failed auth,
query cancellation and process limits are exercised with controlled fixtures;
real credential configuration was preserved.

The final SSH release used the same source bundle on the configured overlay
host. Actual pup 2.0.1 published a fresh 179-point snapshot; exact replay returned
the same reservation with one query for that publication. Independent raw-data
comparison passed. The packaged macOS app displayed both retained remote cards
in their assigned native chat through the SSH launcher, using the same selected
bundle digest as local. No enrollment or provider credential copying was added.

Private evidence is under `/tmp/op-live-3leonef4/evidence/`; remote raw evidence
remains under `~/.cache/openpane-qualification/actual-publisher-20261122/` on the
configured host. It includes builtin/main/chat/card screenshots, the 20-second
`agent-apply-refresh.mp4`, per-window native identities and scoped delivery
observations. Raw provider data and credentials are excluded from this repo.

Observed experience digests:

- Initial violet bundle: `ff50596ceb54c4173a9c7b4e7293e81095f5e58634aaf57fc84f61460d9fc565`.
- Codex restyle: `253b2e88a736352254c95e2710f4d39738eed7c76e4ba9401e5090e16a4f9a10`.
- Plain-shell/SSH variation: `dab81b2f3b44fa4c161fdeb398629d71fe36703f4262ccf4604671dc9e17918c`.

No performance ratio is claimed. The 30-second CLI wait reports pending honestly;
painted receipts and native observations establish delivery separately.

## Final checks

`npm run verify -- -- --test-concurrency=4` passed: 4,057 passed, five existing
skips, zero failures (4,062 total). It includes workspace builds, iOS TypeScript
checks, lint, provider suites, images, recovery, capture, SDK callers and the new
experience/card tests. Rust formatting and all 48 native tests passed. The Mac
bundle succeeded (15.11 MiB, local ad-hoc signing). Logs are
`/tmp/openpane-e-quiet-final-{verify,fmt,rust,bundle}.log`.

The same native approval ID and prompt survived another apply and refresh,
both all-rendered. Its selected draft remained visible, and clicking Allow
completed the scoped command successfully. Evidence is
`native-approval-across-refresh.json` with before/after screenshots.

Earlier failed and interrupted runs remain in the private logs. The compact
approval fix initially affected extension scrolling; its scope was corrected.
The directory notification acceptance fixture was changed to observe the durable
file directly. A timing-sensitive inherited-pipe fixture passed independently
after the eight-window exercise; the final full gate used four test processes.
Both review-gauntlet passes follow this implementation checkpoint.


## Correctness hardening verification

The first review panel identified retry, process cleanup, native history, and
saved-draft edge cases. The fixes preserve native window identity across document
replacement, scope pending work to the current host, and retire completed history
with its replay epoch. Draft copies and source clearing now commit atomically
with their recovery records. Duplicate legacy drafts have a read-only recovery
view. A first message that changes placement remains an unsent target draft.

`npm run verify -- -- --test-concurrency=4` passed with 4,093 passes, five existing
skips, and zero failures, out of 4,098 tests. The final native changes passed all
57 Rust tests and formatting. The production Mac bundle succeeded at 15.18 MiB.
Logs are `/tmp/openpane-gauntlet-correctness-full-verify-r2.log` and
`/tmp/openpane-gauntlet-native-final-{tests,fmt,bundle}.log`.

The rebuilt native app preserved two distinct unsent drafts through detachment
and builtin restore. A retained child created a main-window chat and reported a
completed request. Its persisted reservation was target-ready. Closing and
reopening another child preserved its draft. A second app instance reported the
profile lock without acquiring an editor and quit normally. The first instance
also quit normally. The default native View menu has no Reload command.

The exported editor schema documents a remaining runtime validation requirement
for UTF-16 identifier limits and ownership. Generated identifiers use ASCII.
The shutdown test's fixed playback delay remains a test precision limitation;
it does not alone prove that shutdown overlaps an active response drain.

Fresh correctness and maintainability reviews of these fixes are still required
before the review-gauntlet checkpoints.


### Recovery and replay hardening, November 23

The final hardening check ran the full repository verification with Node 24.22.3
and npm 11.19.1: 4,148 tests, 4,143 passed, no failures and five existing skips.
Rust formatting and all 62 native tests passed. Focused tests cover whole-text
carry copies, target-copy removal, independent legacy recovery, creation refusal,
interrupted browser handoffs, request expiry, explicit Keep across replay epochs,
compaction CAS replay and replacement creation after a lost reply. Recovered text
is never submitted automatically.

The rebuilt Mac application also passed an actual window check against an isolated
recorded host. Repeated native Restore actions persisted even when builtin was
already selected. The native close fallback preserved a committed draft on reopen.
Normal Quit closed main and two children, and a restart recovered the second
child's exact saved draft. Native Quit Without Saving exited successfully. The
separate-window appearance receipt was all-rendered; this check submitted no
recorded commands. The temporary app and host were closed afterward.
