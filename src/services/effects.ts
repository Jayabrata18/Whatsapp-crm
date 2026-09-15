import type { SheetStore } from '../adapters/sheets.js';

export type EffectHandler = (payload: unknown) => Promise<void>;

export interface EffectServiceDeps {
  store: SheetStore;
  handlers: Record<string, EffectHandler>;
  maxAttempts?: number; // default 5
  now?: () => Date;
}

const BASE_BACKOFF_MS = 60_000;

/**
 * Durable effect queue. A courier RTO transition fans out into several
 * side effects (cancel the Shopify order, tag it, message the customer,
 * write a ledger row) that must each retry independently — a webhook
 * retry must never re-run an effect that already succeeded.
 */
export class EffectService {
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(private readonly deps: EffectServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  async enqueue(orderNo: string, kind: string, payload: unknown): Promise<void> {
    const iso = this.now().toISOString();
    await this.deps.store.appendEffect({
      effectId: `${orderNo}:${kind}:${iso}`,
      orderNo,
      kind,
      payloadJson: JSON.stringify(payload),
      attempts: 0,
      state: 'PENDING',
      lastError: '',
      createdAt: iso,
      nextAttemptAt: iso,
    });
  }

  async drain(): Promise<{ done: number; retried: number; failed: number }> {
    const due = await this.deps.store.listDueEffects(this.now().toISOString());
    let done = 0;
    let retried = 0;
    let failed = 0;

    for (const effect of due) {
      const handler = this.deps.handlers[effect.kind];
      if (!handler) {
        // An unknown kind will never succeed, so retrying it just burns attempts.
        await this.deps.store.updateEffect(effect.effectId, {
          state: 'FAILED',
          lastError: `no handler for kind=${effect.kind}`,
        });
        failed += 1;
        continue;
      }

      try {
        await handler(JSON.parse(effect.payloadJson));
        await this.deps.store.updateEffect(effect.effectId, { state: 'DONE', lastError: '' });
        done += 1;
      } catch (error) {
        const attempts = effect.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);

        if (attempts >= this.maxAttempts) {
          await this.deps.store.updateEffect(effect.effectId, {
            attempts,
            state: 'FAILED',
            lastError: message,
          });
          failed += 1;
        } else {
          const delay = BASE_BACKOFF_MS * 2 ** (attempts - 1);
          await this.deps.store.updateEffect(effect.effectId, {
            attempts,
            lastError: message,
            nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
          });
          retried += 1;
        }
      }
    }

    return { done, retried, failed };
  }
}
