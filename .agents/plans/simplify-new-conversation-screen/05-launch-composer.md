# 05 — Launch screen uses the conversation composer (follow-up)

Requested by the owner on 2026-11-22. When the app starts, it showed the old empty-workspace screen: an eyebrow, a headline, a paragraph and a settings-only box. That screen should become the same greeting and composer as an empty conversation. Submitting from it should move into the conversation, and the shared parts should animate as one.

## Design

- **`Composer.tsx`** (new) is the only composer markup. It owns:
  - the form and the textarea auto-grow, which was moved out of `ConversationView`;
  - the footer slots: leading, controls, actions and Send;
  - a small move animation that slides the composer when the panel switches between centred and pinned. This covers an empty conversation receiving its first message.
- **`NewConversation.tsx`** (new) renders the launch screen:
  - the greeting as an h1, which the customization qualifier and the shell test look for;
  - an optional status note (no host, or no agents);
  - the `Composer`, with the existing `ComposerAgentControls`.
- **`BrowserApplication.startConversation(agentId, send)`** runs these steps:
  1. Create the conversation. While it opens, the launch screen stays up.
  2. Put the launch text into the new conversation's draft.
  3. Send it, when the launch Send button triggered the start.
  4. Swap the screens in a single `document.startViewTransition`, with `flushSync`. The two composers share `view-transition-name: conversation-composer` and the two greetings share `conversation-greeting`, so the browser morphs them. With reduced motion, or where the API is missing, the swap is instant.
- **Picking a model** on the launch screen still starts a chat right away, as before. Existing tests and provider flows depend on this. The text typed so far becomes that chat's draft, and an empty conversation looks identical to the launch screen.
- **A refused creation** leaves the launch screen and its text in place, and the error shows in the sidebar.

## Acceptance

`tests/application/new-conversation.browser.test.mjs` checks four things:
- the launch screen equals the empty conversation;
- Send stays disabled until there is text;
- sending opens the chat with that first message and an empty composer pinned lower;
- choosing a model carries the typed text into the new chat's draft without sending it.
