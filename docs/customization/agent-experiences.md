# Author OpenPane experiences and saved metrics cards

Use the installed host's `main.js ui` command to change a running desktop
experience or publish a saved metrics snapshot to a conversation. Edits apply
live. The selected experience belongs to that host profile and survives restart.
The builtin appearance remains the default on a fresh profile.

## Find the running host

A host Codex turn receives a separate `<openpane-ui>` text item with the
exact conversation scope and CLI argv prefix. Use that prefix verbatim. It names
the supported Node executable, installed bundle and actual data directory. The
canonical user message remains separate; the upstream Codex thread may retain
the integration text.

For another CLI-capable agent, obtain those paths from the running launcher or
host operator. Run the command on the machine that owns the host. In particular,
an SSH host uses its own installed bundle and data directory. A laptop socket
cannot control the remote host.

In Bash or Zsh, represent the prefix as an array so spaces and punctuation stay
inside their arguments:

```sh
UI=( '/absolute/path/to/node' '/absolute/path/to/main.js' ui
     --data-dir '/absolute/path/to/host-data' )
"${UI[@]}" context
"${UI[@]}" experience schema
"${UI[@]}" display schema
"${UI[@]}" targets
```

Replace the three paths with the supplied values. `context` returns `hostId`,
`profileId`, `requestEpoch`, `revision`, `recoveryGeneration` and the current
selection. `targets` returns committed conversation scopes; follow its `after`
cursor until null. Choose the complete `{hostId, conversationId}` explicitly.
The active window is never an implicit publication target. Newly created chats
are valid even before a cached catalog refreshes.

The UI contract is version 1. It is separate from conversation service wire 16
and extension SDK 0.14.0. A normal host agent keeps the existing read-only
sandbox and on-request approvals. Request ordinary scoped approval for workspace
writes and local socket access when required. Do not expand sandbox roots or
change provider credentials.

## Make one visible edit

Copy [Messenger 2002](../../examples/experiences/messenger-2002/) into the
requested authoring workspace, or create an `experience.json` using the schema.
Change `theme.light.colors.accent` to `#4a3678` and its dark counterpart to a
readable color. The title strips and accents change when applied. Tokens alone
do not require editing the stylesheet.

Read `context` immediately before a new operation. In the following commands,
replace `REVISION`, `EPOCH`, `UUID` and `DIRECTORY` with the returned revision,
request epoch, a fresh UUID and the absolute source directory. Quote them as
individual arguments. Save the chosen request ID before sending the command.

```sh
"${UI[@]}" experience apply --directory 'DIRECTORY' \
  --expected-revision REVISION --request-id 'EPOCH:UUID'
"${UI[@]}" wait --request-id 'EPOCH:UUID' --wait-ms 30000
"${UI[@]}" status --request-id 'EPOCH:UUID'
```

`apply` validates all bytes before selecting an immutable, content-addressed
bundle. An exact retry of the same request ID returns its original receipt.
Different input under that ID conflicts. A stale revision requires reading
context and making a new deliberate operation. Never turn an ambiguous outcome
into another request ID without checking the original status.

A receipt identifies each window, visual result and placement result. Pending,
failed, departed and superseded windows remain explicit. A 30-second wait ending
with pending is not a successful paint. Hidden windows acknowledge when visible.
An interrupted wait can be resumed with the same ID. Selection is distinct from
an actual painted-window acknowledgement.

To redeliver the selected bytes, use a new ID and current revision:

```sh
"${UI[@]}" experience refresh --expected-revision REVISION --request-id 'EPOCH:UUID'
"${UI[@]}" experience restore --builtin --expected-revision REVISION \
  --expected-recovery-generation GENERATION --request-id 'recovery:GENERATION:UUID'
```

`GENERATION` is `recoveryGeneration` from context. Builtin restore uses the
reserved `recovery:GENERATION:UUID` request ID. The persistent **Restore
OpenPane appearance** control and Command/Control–Shift–Backspace also work
locally during an outage. They reconcile with the host when connected. If a
newer selection conflicts, retry restore explicitly. Existing child windows
retain their editor owners; builtin policy puts future new chats inline.

## Author tokens, styles and assets

`experience schema` returns the version-2 manifest schema, pane choices, semantic parts, applicable roles/states, supported declarations and limits. Version 1 experience bundles must be reauthored; the UI wire protocol and stored metrics card version remain unchanged.

Every v2 manifest adds `theme.density` (`comfortable` or `compact`) and these presentation fields:

```json
{
  "home": { "kind": "stack", "panes": ["agents", "conversations"] },
  "transcript": "lines"
}
```

Alternatively, use `{"kind":"columns","primary":["conversation"],"secondary":["extensions","status"],"balance":"primary-wide"}` for Home. Regions are nonempty and pane kinds are unique across the entire composition. Other balance values are `even` and `secondary-wide`; `transcript` can also be `bubbles`. Panes show actual host data and keep ordinary routes to omitted capabilities. A separate-chat main's conversation pane shows placement status; browser fallback can show the real inline editor.

[AIM Classic](../../examples/experiences/aim-classic/) demonstrates the directory/lines look. [Messenger 2002](../../examples/experiences/messenger-2002/) demonstrates the contrasting workbench. Both are optional. A cold v2 startup chooses Home; live apply preserves your current destination. Chats reveals the editor even when Home omits it.

Compact density uses smaller desktop targets only for fine-pointer environments without coarse input. Coarse/hybrid targets remain at least 44px. The same inherited theme reaches main and detached windows. The authoring CSS changes appearance; the manifest owns layout and application actions remain unchanged.

`[data-openpane-part="button"][data-openpane-role="navigation"][data-openpane-state="selected"]` styles selected navigation. Action roles include send, stop, approval and ordinary tones. Use only combinations returned by discovery; role/state attributes must be in the same compound as their applicable part. Native `:active`, `:disabled`, `:checked` and other discovered states remain functional. Bounded gradients and bevel shadows are available; arbitrary layout, imports and remote resources are rejected.

Structural changes wait for active text composition to finish. A visible document's pending receipt can mean this deferral; the protected status says “Appearance waiting for text input to finish”. It is neither a render success nor a failed apply. A newer apply or restore cancels the older candidate. No theme operation sends a message or queries a provider. The local builtin restore can also wait for composition; its notice distinguishes saving the selection from completing the visible restore.

Web CSS cannot repaint native OS window controls. The [reference sheet](references/aim-classic.md) explains the visual target and platform differences.

`experience schema` returns the manifest schema and supported semantic parts.
The theme has system/light/dark mode and separate light/dark token sets: colors,
spacing, radius, typography, system font stacks, border/shadow treatments and
chart colors. Presentation selects labeled page navigation or a rail, inline or
separate native chats, and bounded child geometry/title treatment. A browser
reports its inline placement fallback.

The stylesheet is restricted to `[data-openpane-part="…"]` selectors and visual
properties. Supported parts include main, page rail/page, chat directory/window,
header, transcript/row/text, toolbar, composer, button, card/title/toolbar/summary,
plot frame/plot/axis/grid/trace/legend, empty card, query details and values table.
Use the exact hyphenated names from discovery. Styles cannot add executable
controls, hide recovery, reposition protected approvals or fetch arbitrary URLs.
Use the [extension guide](../extensions/customization-guide.md) for new behavior.

Every CSS or PNG asset declares its filename, UTF-8 byte count and SHA-256.
After changing the example CSS, run `node update-assets.mjs` in its directory.
The directory loader computes the complete bundle digest. `--stdin` instead of
`--directory` accepts a complete bundle containing manifest, stylesheet, base64
PNG assets and canonical digest. Do not pipe a partial manifest to that mode.

Limits are 64 KiB manifest, 128 KiB stylesheet, 16 PNGs totaling 2 MiB and 2048 px
per image dimension. Assets stay local to the bundle. Remote fonts, images,
imports and scripts are rejected. Invalid bundles leave the selected experience
and drafts intact. Failed painting keeps the last usable appearance.

## Publish a metrics snapshot

`display datadog` runs configured pup in the caller's environment. Configure an
absolute executable with `--pup` or `OPENPANE_PUP`, or make `pup` available on
PATH. Keep the operator's `DD_SITE`; acceptance uses `us3.datadoghq.com`. An
existing file-backed pup login may also need `DD_TOKEN_STORAGE=file`. Do not
copy credentials into the UI store, manifest or browser, or override `--org`.

```sh
"${UI[@]}" display datadog --scope-json '{"hostId":"HOST","conversationId":"CHAT"}' \
  --publication-id 'EPOCH:UUID' --query 'avg:system.cpu.user{*}' --from 1h --to now
"${UI[@]}" display status --scope-json '{"hostId":"HOST","conversationId":"CHAT"}' \
  --publication-id 'EPOCH:UUID'
```

The host reserves the key and fixed absolute epoch-second range before the
query. The CLI uses direct pup argv with `--no-agent --output=json`. It commits
only after successful child close and complete validation. Timeout is 30 seconds;
stdout is limited to 2 MiB and stderr to 16 KiB. Errors are bounded and sanitized.
The qualified pup response is v1 raw time series with epoch-millisecond
`pointlist` timestamps. Those timestamps and numeric values are preserved.
Aligned bucket bounds can differ from the requested range. Nulls remain gaps,
different units use separate panels, and successful empty data has an empty card.
Unknown shapes fail rather than guessing a time unit.

Concurrent identical requests, lost replies and restart never automatically run
a second query. Failed/interrupted attempts require explicit compare-and-set
retry using their status attempt number and the same retained absolute range:

```sh
"${UI[@]}" display retry --scope-json '{"hostId":"HOST","conversationId":"CHAT"}' \
  --publication-id 'EPOCH:UUID' --expected-attempt ATTEMPT
```

Any agent can publish a normalized event with `display publish --stdin`, the
same explicit scope and publication ID. `display schema` describes the named
AG-UI CUSTOM event `openpane.datadog.metrics.v1` and MetricsCardV1. It permits
8 series, 400 points per series and 64 KiB per card. Query-reserved IDs cannot be
reused for raw publication. Saved cards are OpenPane display data, independent
of provider history and commands. Restyling, reload and restart do not query pup.

`display list --scope-json SCOPE` starts a bounded snapshot. Continue using the
returned cursor with `--cursor-json CURSOR` and the same `--subscription-id ID` (choose one before starting, or retain the CLI’s default for that scope).
Each reply is at most 8 items and 512 KiB. Complete the fixed snapshot before
reading later changes. Unknown or expired cursors request a reset. `--after N`
is a shorthand within the current request epoch; it cannot resume a cursor from an earlier epoch. Use the complete `--cursor-json` value and its subscription ID to resume across reconnects. Within an epoch it accepts only a live cursor already issued to that subscription; it cannot assert that
an arbitrary suffix is complete.

There are 32 cards per conversation and 32 MiB total retained display data.
Capacity refuses a new publication without evicting another card. Explicitly
remove a card to release its slot:

```sh
"${UI[@]}" display remove --scope-json '{"hostId":"HOST","conversationId":"CHAT"}' \
  --publication-id 'EPOCH:PUBLICATION_UUID' --request-id 'EPOCH:REMOVE_UUID'
```

Removal emits a tombstone. Removing a failed or interrupted query explicitly
abandons that attempt and its retry option; it never creates a card. Running
queries must settle before removal. Replaying the old publication does not resurrect it.
Administrative `maintenance compact --expected-epoch EPOCH` retires completed UI
receipts and replay history while keeping active cards, drafts, native intents,
non-abandoned query attempts and the reserved builtin recovery replay. Pending
normal deliveries refuse compaction; use `--abandon-waits` to explicitly retire
unconfirmed waits. Abandonment never counts as rendering. Exact replay of the
latest compaction returns its saved result; changing its abandonment choice
conflicts. Other unknown retries from older epochs are rejected. `experience prune --keep N --request-id EPOCH:UUID`
reclaims unselected, unreferenced bundles; it does not erase drafts or cards.
