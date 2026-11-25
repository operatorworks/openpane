# AIM Classic

An optional agent-authored experience: a compact Agents/Conversations Home, separate native chats, classic neutral controls, blue captions, speaker-labelled transcript lines and rectangular input wells. Every entry and action comes from the connected OpenPane host.

Read the actual launcher's `ui context`, `experience schema` and `display schema`, then apply this directory using that prefix and the observed revision. Refresh reuses the saved immutable bytes. After editing CSS, run `node update-assets.mjs` here and apply again with a fresh request ID. Use builtin restore to return to the normal view.

The same bundle works over SSH and in a browser. Browsers use the existing inline fallback. On Home, inline open reveals Chats when this composition omits the conversation pane. The separate-window main does not create an empty editor just to fill a pane.

[Reference and differences](../../../docs/customization/references/aim-classic.md) records the dated AIM screenshots, font substitutions, native macOS chrome and pointer-size floors. No upstream stylesheet, remote font, AOL logo or historical contact data is bundled. All visual CSS here is original. There are no fake formatting, warn, block or window controls.
