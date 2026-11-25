# Messenger 2002

An optional desktop experience with labeled page navigation, a chat directory,
square frames, beveled controls and inset metrics plots. It uses system fonts
and original CSS. OpenPane keeps its builtin appearance until you apply it.

Copy this directory into your authoring workspace. Edit `experience.json` for
tokens or `style.css` for semantic parts. After editing CSS, run
`node update-assets.mjs` to update its declared byte count and hash. Apply that
directory with the installed UI CLI described in the
[agent experience guide](../../../docs/customization/agent-experiences.md).

The manifest requests separate native chat windows. A browser uses inline chats
and reports that limitation. Restore builtin appearance from the persistent
recovery control or with Command/Control–Shift–Backspace. Already open native
chat windows keep their editors until closed.
