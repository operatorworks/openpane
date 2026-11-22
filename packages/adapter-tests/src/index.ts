import type { RunAuthority } from '@openpane/contracts';
import type { EventObserver } from '@openpane/host';

export interface ProviderTestSubject<Event> {
  readonly authority: RunAuthority;
  readonly observation: EventObserver<Event>;
}
