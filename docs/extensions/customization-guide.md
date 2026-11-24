# Customize OpenPane

Choose the format that matches the change. A repository is useful for code authoring; it is not required to choose an appearance or exchange colors.

| Change | Owner and format | Apply it |
| --- | --- | --- |
| Appearance, selected palette, enabled UI namespaces, global view choices | Desktop profile, preferences JSON | Settings; saved changes apply live |
| Reusable light/dark colors | Origin-local library, standalone palette JSON | Import, then explicitly select |
| Conversation modules/actions, a workspace, scoped transcript, frontend tools | Full-trust SDK namespace, executable React source | Preview working files; build committed code for release |
| Providers, operations, installation grants | Host configuration and credential owners | Existing server installation/replacement/refresh workflow |
| Prompts, skills and agent hooks | Provider's own contracts | Configure through that provider |

Distribution is separate from these owners. A code repository can include a palette, but importing the palette never activates its code. Executable manifests still require a runtime entry. Preferences contain no provider credentials, host addresses, Git revisions or artifact identities.

## Choose an appearance or exchange a palette

Open **Settings → Appearance**. Select System, Light or Dark. System follows OS changes without rewriting your preferences. Import a palette file or paste its JSON, review the preview and save it to the library. Selection is a separate action. Export one palette to share; remove it to stop keeping that version. Removing the selected palette chooses builtin colors and retains your light/dark preference.

**Export starter palette** gives you a complete pair based on builtin colors. The template also contains [review-palette.json](../../templates/customization/review-palette.json). The namespace/name declared in an imported file are metadata, not verified publisher identity. The digest identifies content, not safety or authorship.

V1 contains exactly these fields:

```json
{
  "kind": "openpane-palette",
  "version": 1,
  "namespace": "personal",
  "name": "review",
  "label": "Quiet review",
  "colors": { "light": {}, "dark": {} }
}
```

The empty maps above show structure only. Each must contain every role in this order: `canvas`, `surface`, `raised`, `text`, `muted`, `border`, `controlBorder`, `accent`, `onAccent`, `danger`, `onDanger`, `focus`. Use exactly six hexadecimal digits after `#`. Start from a complete exported document rather than importing the structure example. No extra fields, CSS expressions, scripts, assets or network references are accepted. Namespace and name match `^[a-z][a-z0-9-]{0,31}$`; the trimmed, NFC-normalized label is nonblank and at most 64 characters. Import accepts at most 64 KiB and the library stores at most 64 resources.

Canonical JSON has the field order shown above, followed by `light` then `dark` and the fixed role order. It has no incidental whitespace; colors are lowercase, labels normalized, and bytes are UTF-8. SHA-256 of those bytes identifies a version. Reordering input keys or changing hex case does not create a new version. Editing a color does; versions with the same logical name coexist, and reimport never replaces a selected version. WebCrypto must be available to verify palette identity; otherwise OpenPane retains data and reports that palette verification is unavailable.

Preferences and palette data belong to this origin and browser/webview profile. Different workspace/launcher ports and bundled native mode can have separate stores. They do not sync. **Edit preferences JSON**, Import and Export provide manual portability. Import preferences before palettes if useful: missing references are retained with builtin fallback. A stale editor refuses to overwrite newer saved changes and keeps your draft.

Recovery and Settings use builtin colors even when content colors are unreadable. **Restore default appearance** immediately restores System/builtin and attempts to save it. **Restore default view** immediately disables executable UI, preserves namespace/slot choices and attempts to save that choice. Both report failed persistence honestly and preserve your conversation/draft. **Reset saved preferences** repairs supported malformed records to safe defaults with executable UI off, while retaining imported resources and host data. Unsupported future versions are preserved. Explicit Retry freshly reads supported saved settings; focus or reconnect cannot silently undo recovery.

## Try a module without committing

Use the supported Node/npm versions in [.node-version](../../.node-version) and [package.json](../../package.json). From the OpenPane checkout:

```sh
npm ci
npm run setup:browser
npm run build
cp -R templates/customization /absolute/my-extension
npm run host:browser-dev -- --data-dir /absolute/private-preview-host --port 7140
```

Keep that host running. In another terminal, pass its actual printed loopback origin:

```sh
npm run customization:dev -- --source /absolute/my-extension --host-url http://127.0.0.1:7140
```

Open exactly the printed `http://127.0.0.1:PREVIEW_PORT/preview.html` URL. The persistent **Unqualified local preview** label identifies working source. Create a recorded conversation in Chats, open Extensions and use **Review the plan** under Conversation tools. It submits through the host's ordinary `ConversationCommands.send`; your composer draft stays untouched. Edit visible text in `desktop/index.tsx` or colors in `desktop/review.css`, then deliberately reload while idle to see the uncommitted edit.

Each explicit document load compiles an in-memory snapshot of code, imported helpers, lazy modules and CSS. Its content-hashed assets remain available until the preview command closes. The preview keeps at most 128 MiB and 4096 outputs; reaching either limit refuses a new snapshot and asks you to restart the preview command. Earlier pages keep their snapshots, so opening an unused module or reloading another tab cannot mix source versions in the current page. This snapshot is unqualified and produces no release artifact. Code, imported helpers and CSS never update automatically. Reload can interrupt client-owned frontend work; there is no tool-call continuity promise and no automatic resend. Existing durable uncertainty recovery remains available. Manifest and source-map changes require restarting the preview command. Correct malformed source using the terminal diagnostic, then reload to retry.

The command accepts one package root with `package.json.openpane` metadata and a desktop entry. It reads working files, uses the installed shared SDK/React ABI, does not install dependencies and does not run package scripts or repository build configuration. Ordinary dependencies must be browser-ready ES modules already installed inside that source root; imports/symlinks that escape it and ambient machine packages are rejected. External Git graphs are not traversed. Code remains full trust and can alter or block the process.

The stable default port derives from the resolved source root and host origin, so consecutive previews keep the same origin and local choices. Use `--port 23140` to choose another; occupied ports fail rather than silently changing your storage scope. For a remote host, forward the same local and remote listener port, first stopping any local host on that port, then using `ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:7140:127.0.0.1:7140 HOST`, and use `http://127.0.0.1:7140` as the host origin. The host checks that HTTP Host and Origin match its listener port. The preview forwards only same-origin JSON POSTs to `/api/v1` and `/api/v1/images`. It starts neither a real provider nor a server development orchestrator.

## Add a namespace workspace

The template's module/action works with an existing active conversation regardless of provider namespace. Its **Plan review workspace** is a separate feature: it needs a host provider configured under the template's `personal` namespace. The browser-dev command's recorded agent does not claim that namespace and cannot make a real workspace conversation for it.

The workspace renders exactly one host-supplied conversation. Its scoped transcript highlights review notes from assistant text; the ordinary composer, approvals, Stop, recovery and navigation remain host-owned. No new agent loop or extension storage is involved. An offline test registers the ledger conformance provider under the template namespace and demonstrates the workspace through the real preview:

```sh
node --test tests/application/customization-preview.browser.test.mjs
```

Modules/actions are additive, identified by namespace plus complete module ancestry/action ID. Workspaces have one owner per namespace, and their transcript applies only to that namespace's conversation. The starter claims no global transcript, activity or content-layout slot.

Global overrides are opt-in SDK recipes: return `overrides: { transcript: YourTranscript }`, `overrides: { activity: YourActivity }` or `contentLayout: YourLayout` from activation. In Settings, automatic mode uses builtin presentation while loading and when multiple namespaces claim a slot; conflicts name the claimants. Builtin mode always selects builtin presentation. An explicit namespace choice never falls through to another claimant when loading, disabled, absent or failed; it retains the choice and shows builtin with a diagnostic.

**Enable executable UI customizations** and per-namespace controls affect desktop UI admission. They do not disable providers, revoke credentials, cancel remote runs or remove palettes. Surviving namespaces keep their activation and frontend-tool generation when another namespace is disabled. Old tool bindings finish through their pinned lifetime before disposal. Cleanup failure leaves that namespace unavailable until restart. Full-trust code can have effects that disabling a view cannot undo.

## Build committed code for release

Commit the extension repository, then build the immutable revision through the existing release path:

```sh
node scripts/build-local-customization.mjs \
  --repository /absolute/my-extension \
  --commit FULL_IMMUTABLE_GIT_COMMIT_ID \
  --out /absolute/fresh-browser-artifact
```

This reads the committed source graph and qualifies the artifact. Dirty files shown in preview remain excluded. Development plans have no Git identity and cannot be packaged as committed plans. Follow [sources](../customization/sources.md) and [server artifacts](../customization/server-artifacts.md) for release selection and host integration. Provider credentials stay protected by their host owners; private overlay-network access remains the client trust boundary.

The preview is browser-only. Release native UI code still requires rebuilding/packaging. iOS remains disconnected and rebuild-only; these runtime appearance/palette flows and native live preview have no iOS qualification claim. A successful browser test or native compile does not establish packaged Mac file-transfer/persistence behavior; observe the complete exchange in the actual Mac app before claiming that qualification.

In the Mac webview, export uses selectable JSON and Copy JSON; save the copied text as a `.json` file. Browser mode also offers Download JSON. Both paths export the same canonical palette document. Native blob downloads are not used.

Preference exports contain only user choices. Local compare-and-swap revisions and reset epochs stay inside the personalization database. A full repair can restart its revision at zero while advancing the epoch, so an editor opened before repair cannot overwrite the safe reset.
