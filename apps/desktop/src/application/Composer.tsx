import { useEffect, useLayoutEffect, useRef, type FormEvent, type ReactNode, type RefObject } from 'react';

/**
 * The one composer every chat surface renders: the new-conversation screen and an open conversation share its markup,
 * sizing and motion, so moving from one to the other reads as the same box changing place.
 */
export function Composer({ id, label = 'Message', text, onText, placeholder, readOnly = false, canSend, onSend, textareaRef, centred, drop, above, below, leading, controls, actions }: {
  readonly id: string;
  /** The textarea's accessible name (visually hidden). */
  readonly label?: string;
  readonly text: string;
  readonly onText: (value: string) => void;
  readonly placeholder: string;
  readonly readOnly?: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Whether the surrounding panel centres the composer; a change slides it to its new place. */
  readonly centred: boolean;
  readonly drop?: 'accept' | 'reject' | undefined;
  /** Above the textarea: attachment chip, drop hint and attachment notes. */
  readonly above?: ReactNode;
  /** Under the textarea: draft-save failures. */
  readonly below?: ReactNode;
  /** Start of the footer: the attach control. */
  readonly leading?: ReactNode;
  readonly controls?: ReactNode;
  /** Before Send: Stop. */
  readonly actions?: ReactNode;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const field = textareaRef ?? own;
  const form = useRef<HTMLFormElement>(null);
  // The textarea grows with its text; CSS max-height caps it, then it scrolls. A hidden view has no layout, so skip it.
  function fit(): void {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    if (node.scrollHeight > 0) node.style.height = `${node.scrollHeight}px`;
    else node.style.height = '';
  }
  useLayoutEffect(fit, [text]);
  useEffect(() => {
    const node = field.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []); // The textarea element is stable for this composer's lifetime.
  // Slide from where the composer was drawn last to where the new layout puts it (first, last, invert, play).
  const placed = useRef<{ readonly centred: boolean; readonly top: number } | null>(null);
  useLayoutEffect(() => {
    const node = form.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top, previous = placed.current;
    placed.current = { centred, top };
    if (!previous || previous.centred === centred || typeof node.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const offset = previous.top - top;
    if (Math.abs(offset) < 2) return;
    node.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (canSend) onSend();
  }
  return <form ref={form} className="composer" data-drop={drop} onSubmit={submit}>
    {above}
    <label htmlFor={id}>{label}</label>
    <textarea ref={field} id={id} value={text} onChange={event => onText(event.target.value)} readOnly={readOnly} placeholder={placeholder} rows={1} />
    {below}
    <div className="composer-footer">
      {leading}
      {controls}
      <div className="composer-send-actions">
        {actions}
        <button className="composer-send" aria-label="Send" title="Send" disabled={!canSend}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg></button>
      </div>
    </div>
  </form>;
}
