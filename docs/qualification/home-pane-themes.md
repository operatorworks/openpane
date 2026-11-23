# Home panes and application themes qualification

Code commit: `9ee400966e80fad34f54ecf04f6b9587b26118cf` on `codex/home-pane-themes`.
Base commit: `725ab8b53805a1e540bafe2b2d3925dc0f24463d`.
Qualification date: November 23, 2026.

The implementation and platform checks passed. Integration remains pending the
predecessor's unfinished review gauntlet. This work does not close that review,
push a branch, open a pull request, or merge either branch.

## Implemented behavior

Experience manifests use version 2. Agents can choose real Home panes, their
reading order, a stack or two columns, compact or comfortable controls, and
line or bubble transcripts. Chats keeps the directory and editor available
when Home omits them. Settings and Extensions remain separate destinations.

Home and Chats share keyed pane containers, one search instance, and one editor.
Workspace-owned conversations keep their existing ownership rules. Their hidden
Home placeholder contains no second editor. Theme changes preserve drafts,
selections, approvals, transcript scroll, and saved cards.

The host publishes one shared inventory of semantic parts, roles, states,
selectors, properties, and bounded CSS values. Authored styles can change
captions, form controls, fonts, borders, gradients, and shadows across main and
detached documents. The host rejects arbitrary layout, scripts, remote assets,
unknown functions, and selectors outside that inventory.

CSS and artwork stage before activation. Each document checks its current view,
Home, and Chats before it can paint an authored candidate. Composition defers
theme changes and restore. Native placement uses the exact validated and
host-confirmed delivery. An older handoff cannot reserve or fail a newer receipt.

Unsupported saved manifests fall back to builtin without deleting bundle bytes,
conversations, drafts, or cards. The UI transport and display-card formats retain
their independent versions. No pairing or attestation behavior was added.

## Verification results

Node 24.22.3 and npm 11.19.1 were used.

| Check | Result |
| --- | --- |
| Workspace build | Passed. Final desktop and browser outputs were rebuilt after the last desktop changes. |
| Workspace type checks and lint | Passed. |
| Complete package.json test inventory | 4,210 passed, zero failed, five existing skips. All 23 globs and 316 files ran with Node test concurrency 2. |
| Packaged macOS app | Built and signed locally. The app bundle is 15.23 MiB. |
| Rust tests and format check | 65 tests passed. Format check passed. |
| Browser behavior | Pane order, omitted-pane access, one editor, route preservation, IME deferral, supersession, rollback, recovery, CSS validation, and saved-version fallback passed. |
| Pointer and accessibility behavior | Fine-pointer compact rows, coarse-pointer 44px targets, forced colors, reduced motion, and keyboard focus passed. |
| Browser zoom | Actual Chrome zoom changed devicePixelRatio from 2 to 4. At 200%, keyboard navigation reached the visible editor and recovery remained visible. Zoom returned to its original value. |
| iOS | Prepare, Release build, simulator launch, and offline verification passed on iPhone 17 Pro with iOS 26.3. The disconnected screen was inspected. |

The full test command was the exact `npm test` file inventory with
`--test-concurrency=2`. Earlier failure logs remain in the evidence directory.
The final complete run is `final-tests-2.log`. The short-window regression now
passes at both 360 by 480 and 360 by 320. The preview has a finite viewport
height, and the test wheels the outer workspace when a clipped inner panel
cannot fit its target. The full-button and hit-test assertions remain intact.

## Native and remote journeys

The packaged app displayed Home and two real detached recorded chats. Both kept
independent drafts. The first chat retained its pending approval and synthetic
metrics card through apply, restore, normal close, and first-try reopen.
Keyboard restore also retained the selected draft. The native Appearance menu
restored builtin without reclaiming a child's editor. Normal Quit exited with
code 0.

While main was minimized, both child documents rendered the refreshed theme.
Main remained pending, as documented for hidden windows. The same receipt
reached `all-rendered` after main returned. The card's publication status stayed
identical. The entire recorded journey contains one deliberate Send and no
approval command or provider query.

The repeatable WKWebView component check uses the existing native probe with
freshly bundled production `BrowserApplication`, `HomeSurface`, and
`ExperienceScope` code. It passed visible route and pane-order assertions,
same-node editor and approval assertions, exact draft and selection checks,
composition deferral, supersession, and host-persisted builtin restore.
Its composition events are synthetic. It does not claim physical IME testing.

The probe entry points are
[`home.mjs`](../../tests/desktop/experience-probe/home.mjs) and
[`home-window.jsx`](../../tests/desktop/experience-probe/home-window.jsx).
The existing native binary build command is
`cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features experience-probe --bin experience-probe`.
The component check command is `node tests/desktop/experience-probe/home.mjs`.

The authorized SSH host, `punk1290@100.69.236.34`, served its installed host and
browser assets. Apply, immutable refresh, and builtin restore each reached
`all-rendered`. The stylesheet returned HTTP 200 from a digest URL. No required
browser URL contained a laptop path. This check made no Datadog query.

## Examples and visual evidence

Both examples passed host bundle validation:

| Example | Bundle digest |
| --- | --- |
| AIM Classic | `240b6c1d2b3677ffe5d0a0afedbcf4cf1541f92f3e890cd693256e6d38fa5654` |
| Messenger 2002 | `5ef69684de5848ac991682069b39c8219d70e45ea09851cb02648982df059e5e` |

The [AIM reference record](../customization/references/aim-classic.md) documents
the inspected source images and platform differences. The recipes are original
CSS. No reference artwork or fonts are redistributed.

Browser and packaged captures show gray chrome, blue captions, inset white
panes, compact rows, raised and pressed controls, red local authors, blue remote
authors, and rectangular composers. An additional component specimen contains
the actual formatted-reply, code-block, image-attachment, metrics-card, approval,
and composer renderers with synthetic data. It preserves serif transcript text
and monospace code. The decoded image is 120 pixels wide. Card caption text is
white against its blue band.

Physical hybrid-pointer hardware was not available. Coarse-pointer emulation
passed, and the trusted `any-pointer: coarse` rule follows the fine-pointer rule.
The iOS check covers the existing disconnected app and shared theme packages.
It does not claim that iOS implements desktop experience authoring.

## Evidence identity

Private evidence is under `/tmp/openpane-home-pane-implementation/`. It contains
the full logs, immutable review snapshots, review findings and fixes, CLI
receipts, screenshots, and `final-evidence.json`. No credentials are included.
The final Sol review found no additional concrete defects in the reviewed changes.
It is separate from the unfinished predecessor gauntlet.

Builds ran before the code commit. Their metadata therefore names base commit
`725ab8b` and a dirty source fingerprint. The staged source matched the reviewed
snapshot byte for byte. The resulting commit's tree and parent were verified.

| Artifact | SHA-256 |
| --- | --- |
| Browser artifact.json | `3e407208610e8337d1537ee9b62e677eb83187f95d4d1fa418d7cc33131930b7` |
| Packaged Mac executable | `8de37a5e49786fac024a9b3c6b28b0e0112f57c7c14f1c40d987aae1abc40d86` |
| AIM stylesheet | `f68f0dd93aff4fcaab485cd7b7d0eb1942473760334357a3e9490cda2a121ded` |
| WKWebView component script | `78f964d6367652446c92c3959f5a07d48c0e2a75ca6f294e6ac7d7866acc2a5b` |

These SHA-256 values hash the complete files. Build logs print `artifactId`,
which hashes the canonical manifest payload; it is a different identity field.

The native component result is in
`/var/folders/3s/_jrxnd6s1tl_lhh2mqtxx1xc0000gn/T/openpane-native-home-zZ0gac/`.
The iOS result and inspected screenshot are under
`apps/ios/native/.work/evidence/`. The disposable simulator was shut down after
verification. Test windows and the browser tab were closed, and browser zoom
was restored.
