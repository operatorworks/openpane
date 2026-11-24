# Experience qualification helpers

Use Node 24.22.3 and build the workspace before running these helpers.

`run.mjs` drives a disposable native transport fixture with its own broker. It
checks shared browser storage, document admission, relay delivery and synthetic
interactions in eight child windows. It does not qualify the production editor
controller, provider execution, real approvals or production close and reopen.

Build and run the fixture:

```sh
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features experience-probe --bin experience-probe
node tests/desktop/experience-probe/run.mjs
```

The fixture foregrounds the eight existing children sequentially for startup
and final paint; it does not assume simultaneous visibility. The main window
reports its actual native minimized state before each relay and during final
focus waits. Shared native monotonic timestamps measure the sampling interval. A passing result requires at least five minutes between minimized
samples, every sample minimized, and no sample gap over five seconds. Restoring
main at a sample fails the run. This is sampled evidence; it does not prove that
the window stayed minimized between samples. Result files identify the fixture
and this limitation. Production native journeys need separate evidence.

`cli.mjs` starts the packaged host against a disposable profile and an installed,
pinned Codex executable. The helper asks its turn to use the production UI prefix and exact
ConversationScope. It compares saved context, both discovery schemas and scoped
`display status` output with the actual profile. It does not inspect the agent's
command transcript, so matching output does not establish which argv ran. It does not create an alternative launcher or socket. Approvals remain
visible for the operator to answer.

```sh
node tests/desktop/experience-probe/cli.mjs /absolute/pinned/codex
```

An optional third argument names a configured Pup executable and requests one
real Datadog query. Omit it for a CLI-only check.

Both runners write evidence outside the repository. Malformed startup output
fails through cleanup. Child shutdown has a grace period followed by a bounded
forced stop, and a forced or unconfirmed stop makes qualification fail.
