# Agent experience implementation record

The requested plan is `/Users/punk1290/git/openpane/.agents/plans/agent-driven-experiences/`.
Implementation is in progress on `codex/agent-driven-experiences` from
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

## Remaining acceptance

Units C–E, production native controller integration, bundled/SSH distribution,
real scoped card publication/restyling, the optional example, native screenshots
and edit video, full integration gates, and both review-gauntlet passes remain
incomplete. Transport and parser fixtures cannot stand in for those checks.
