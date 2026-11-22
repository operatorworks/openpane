import type { ReactNode } from 'react';
import { Composer } from './Composer.js';

/**
 * The screen before a conversation exists. It draws the same greeting and composer an empty conversation does, so
 * starting one changes nothing on screen until the first message moves the composer down.
 */
export function NewConversation({ text, onText, placeholder, note, canSend, onSend, controls }: {
  readonly text: string;
  readonly onText: (value: string) => void;
  readonly placeholder: string;
  /** Why nothing can start yet (no host, no agents); null when the composer is ready. */
  readonly note: string | null;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly controls: ReactNode;
}) {
  return <section className="conversation-panel new-conversation" aria-label="Start a conversation" data-empty="true">
    <h1 className="conversation-greeting">A conversation that stays with you.</h1>
    {note && <p className="new-conversation-note">{note}</p>}
    <Composer id="new-message" label="First message" text={text} onText={onText} placeholder={placeholder} canSend={canSend} onSend={onSend} centred controls={controls} />
  </section>;
}
