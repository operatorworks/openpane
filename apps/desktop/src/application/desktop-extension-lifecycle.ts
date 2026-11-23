import { customizationMessage } from './customization-message.js';
import { checkExtensionEntrypoint } from '@openpane/sdk';
import type { UiExtensionEntry } from '@openpane/sdk/react';
import { createUiExtensionGeneration } from '@openpane/sdk/react-tools';
import type { FrontendToolGeneration } from '@openpane/sdk/tools';
import type { DesktopCustomization, NamespaceActivation } from './DesktopCustomizations.js';
import type { GenerationSink, GenerationSnapshot } from './frontend-sends.js';

type Retirement = { readonly kind: 'pending'; readonly completion: Promise<void> } | { readonly kind: 'settled' };
type Lifetime = {
  readonly entry: DesktopCustomization;
  readonly id: number;
  wanted: boolean;
  state: NamespaceActivation;
  generation: FrontendToolGeneration | undefined;
  activation: Promise<void>;
  retirement: Retirement | undefined;
};

/** Document-owned reconciliation; subscriptions never own activation or sink tokens. */
export class DesktopExtensionLifecycle {
  private desired = new Map<string, DesktopCustomization>();
  private readonly owners = new Map<string, Lifetime>();
  private readonly cleanupFailures = new Map<string, Extract<NamespaceActivation, { readonly kind: 'failed' }>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly NamespaceActivation[] = [];
  private attachment: { sink: GenerationSink; token: object } | undefined;
  private initialSettled = false;
  private nextId = 0;
  private closed = false;
  readonly subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  readonly getSnapshot = () => this.snapshot;

  attach(sink: GenerationSink): void {
    if (this.attachment?.sink !== sink) {
      if (this.attachment) this.attachment.sink.clear(this.attachment.token);
      this.attachment = { sink, token: {} };
      sink.begin(this.attachment.token);
    }
    this.publishSink();
  }

  reconcile(entries: readonly DesktopCustomization[]): void {
    if (this.closed) return;
    this.desired = new Map(entries.map(entry => [entry.manifest.namespace, entry]));
    for (const [namespace, owner] of this.owners) {
      if (this.desired.get(namespace) !== owner.entry) {
        owner.wanted = false;
        this.retire(owner);
      }
    }
    for (const [namespace, entry] of this.desired) {
      if (!this.owners.has(namespace) && !this.cleanupFailures.has(namespace)) this.start(entry);
    }
    this.publish();
  }

  private start(entry: DesktopCustomization): void {
    const namespace = entry.manifest.namespace;
    const owner: Lifetime = { entry, id: ++this.nextId, wanted: true, state: { kind: 'loading', namespace }, generation: undefined,
      activation: Promise.resolve(), retirement: undefined };
    this.owners.set(namespace, owner);
    const fail = (error: unknown) => {
      owner.state = { kind: 'failed', namespace, message: `Executable UI failed. ${customizationMessage(error)}` };
      if (owner.generation) this.retire(owner);
      this.publish();
    };
    owner.activation = (async () => {
      let primaryFailure: { readonly error: unknown } | undefined;
      try {
        const imported = await entry.load();
        if (!owner.wanted) return;
        const compatibility = checkExtensionEntrypoint(entry.manifest, 'desktop', imported.default);
        if (compatibility.kind !== 'compatible') throw new Error(compatibility.reason);
        const executable = imported.default as UiExtensionEntry<'desktop'>;
        const active = await createUiExtensionGeneration({ namespace, generation: String(owner.id), platform: 'desktop',
          activate: context => executable.activate(context), onFailure: error => { primaryFailure = { error }; fail(error); } });
        owner.generation = active.generation;
        if (owner.wanted) owner.state = { kind: 'ready', namespace, lifetime: owner.id, generation: active.generation, presentation: active.presentation, fail };
      } catch (error) {
        // The SDK rethrows the primary failure unchanged when cleanup succeeds.
        // A distinct rejection after our nonthrowing observer means acquired cleanup failed.
        if (primaryFailure && !Object.is(error, primaryFailure.error)) this.recordCleanupFailure(owner, error);
        else fail(error);
      }
      this.publish();
    })();
  }

  private recordCleanupFailure(owner: Lifetime, error: unknown): void {
    const namespace = owner.entry.manifest.namespace;
    owner.state = { kind: 'failed', namespace, message: `Executable UI cleanup failed. ${customizationMessage(error)} Restart the app before enabling this namespace.` };
    this.cleanupFailures.set(namespace, owner.state);
  }

  private retire(owner: Lifetime): void {
    if (owner.retirement?.kind === 'pending') return;
    if (owner.retirement?.kind === 'settled') { this.releaseRemoved(owner); return; }
    // Close retention immediately for a published generation; only pending acquisition waits.
    const retiring = owner.generation ? owner.generation.retire() : owner.activation.then(() => owner.generation?.retire());
    const completion = retiring.catch(error => this.recordCleanupFailure(owner, error)).then(() => {
      owner.retirement = { kind: 'settled' };
      this.releaseRemoved(owner);
      this.publish();
    });
    owner.retirement = { kind: 'pending', completion };
  }

  private releaseRemoved(owner: Lifetime): void {
    const namespace = owner.entry.manifest.namespace;
    if (owner.wanted || this.owners.get(namespace) !== owner) return;
    this.owners.delete(namespace);
    const next = this.desired.get(namespace);
    if (next && !this.closed && !this.cleanupFailures.has(namespace)) this.start(next);
    this.publish();
  }

  private publishSink(): void {
    const generations = this.snapshot.flatMap(owner => owner.kind === 'ready' ? [owner.generation] : []);
    const value: GenerationSnapshot = this.initialSettled ? { kind: 'ready', generations } : { kind: 'transitioning' };
    this.attachment?.sink.publish(this.attachment.token, value);
  }

  private publish(): void {
    this.snapshot = [...new Set([...this.desired.keys(), ...this.cleanupFailures.keys()])].sort().map(namespace => {
      const failure = this.cleanupFailures.get(namespace);
      if (failure) return failure;
      const owner = this.owners.get(namespace);
      return owner?.wanted ? owner.state : { kind: 'loading', namespace };
    });
    if (!this.snapshot.some(owner => owner.kind === 'loading')) this.initialSettled = true;
    this.publishSink();
    this.listeners.forEach(notify => notify());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.desired.clear();
    for (const owner of this.owners.values()) { owner.wanted = false; this.retire(owner); }
    this.publish();
    if (this.attachment) this.attachment.sink.clear(this.attachment.token);
    this.attachment = undefined;
    await Promise.all([...this.owners.values()].flatMap(owner => owner.retirement?.kind === 'pending' ? [owner.retirement.completion] : []));
    this.listeners.clear();
  }
}
