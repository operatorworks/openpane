export const EXPERIENCE_PARTS = ['main', 'page-rail', 'page', 'page-header', 'chat-directory', 'chat-window', 'header', 'transcript-surface', 'transcript', 'transcript-row', 'message-text',
  'toolbar', 'composer', 'button', 'card', 'card-title', 'card-toolbar', 'card-summary', 'plot-frame', 'plot', 'plot-axis', 'plot-grid', 'plot-trace', 'plot-legend', 'card-empty', 'query-details', 'data-table',
  'home', 'pane', 'pane-heading', 'input', 'textarea', 'select', 'checkbox', 'radio', 'field-label', 'status', 'caption', 'caption-title', 'message-author', 'message-body', 'code-block', 'approval-panel'] as const;
export type ExperiencePart = typeof EXPERIENCE_PARTS[number];
export const EXPERIENCE_ROLES = ['navigation', 'agent-row', 'directory-row', 'send', 'stop', 'primary', 'secondary', 'danger', 'approval'] as const;
export const EXPERIENCE_STATES = ['selected', 'local', 'remote'] as const;
export const EXPERIENCE_PSEUDO_CLASSES = [':hover', ':active', ':focus', ':focus-visible', ':focus-within', ':checked', ':disabled', ':enabled', ':first-child', ':last-child'] as const;
export const EXPERIENCE_PROPERTIES = ['color', 'background-color', 'accent-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'fill', 'stroke',
  'gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-size', 'line-height', 'font-weight', 'font-family', 'font-style', 'letter-spacing',
  'border-radius', 'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'stroke-width', 'border-style', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'text-decoration', 'box-shadow', 'background-image'] as const;
export function isExperiencePart(value: unknown): value is ExperiencePart {
  return EXPERIENCE_PARTS.some(part => part === value);
}
export function experienceRoleApplies(part: ExperiencePart, role: string): boolean {
  return part === 'button' && EXPERIENCE_ROLES.some(value => value === role);
}
export function experienceStateApplies(part: ExperiencePart, state: string): boolean {
  return part === 'button' ? state === 'selected'
    : (part === 'transcript-row' || part === 'message-author' || part === 'message-body' || part === 'message-text') && (state === 'local' || state === 'remote');
}
export const EXPERIENCE_STYLE_DISCOVERY = {
  parts: EXPERIENCE_PARTS, roles: { button: EXPERIENCE_ROLES },
  states: { button: ['selected'], 'transcript-row': ['local', 'remote'], 'message-author': ['local', 'remote'], 'message-body': ['local', 'remote'], 'message-text': ['local', 'remote'] },
  pseudoClasses: EXPERIENCE_PSEUDO_CLASSES, properties: EXPERIENCE_PROPERTIES,
  selectorPolicy: 'Every role/state equality attribute must share a compound selector with its applicable semantic part. Only descendant and child combinators are supported.',
  placement: 'On a supported separate-chat main window the conversation pane shows placement status. Inline browser fallback retains its real editor.',
  gradients: { directions: ['to right', 'to bottom', 'to left', 'to top', '0deg', '90deg', '180deg', '270deg'], minStops: 2, maxStops: 4 },
} as const;
