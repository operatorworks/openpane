export function customizationMessage(error: unknown): string {
  const limit = 10;
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  for (let index = 0; index < pending.length; index++) {
    const cause = pending[index];
    if (seen.has(cause)) continue;
    seen.add(cause);
    try {
      if (!(cause instanceof Error)) {
        messages.push('Customization failed.');
        continue;
      }
      const message: unknown = cause.message;
      messages.push(typeof message === 'string' ? message : 'Customization failed.');
      if (cause instanceof AggregateError) {
        const causes: unknown = cause.errors;
        if (Array.isArray(causes)) {
          for (let index = 0; index < causes.length && pending.length < limit; index++) pending.push(causes[index]);
        }
      }
    } catch { messages.push('Customization failed.'); }
  }
  return messages.join(' ');
}
