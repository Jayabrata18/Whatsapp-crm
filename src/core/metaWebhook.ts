export type MetaEvent =
  | { kind: 'button'; messageId: string; from: string; buttonText: string }
  | { kind: 'text'; messageId: string; from: string; text: string }
  | { kind: 'status'; wamid: string; status: string };

interface RawMessage {
  id?: unknown;
  from?: unknown;
  type?: unknown;
  text?: { body?: unknown } | null;
  button?: { text?: unknown; payload?: unknown } | null;
  interactive?: { type?: unknown; button_reply?: { title?: unknown } | null } | null;
}

interface RawStatus {
  id?: unknown;
  status?: unknown;
}

/**
 * Meta delivers template quick-reply taps as `type: 'button'` and interactive
 * message taps as `type: 'interactive'`. Both are normalized to one `button`
 * event so the service layer only ever handles a single shape.
 */
function parseMessage(message: RawMessage): MetaEvent | null {
  const messageId = typeof message.id === 'string' ? message.id : null;
  const from = typeof message.from === 'string' ? message.from : null;
  if (!messageId || !from) return null;

  if (message.type === 'button') {
    const buttonText = message.button?.text ?? message.button?.payload;
    if (typeof buttonText === 'string') return { kind: 'button', messageId, from, buttonText };
    return null;
  }

  if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
    const title = message.interactive.button_reply?.title;
    if (typeof title === 'string') return { kind: 'button', messageId, from, buttonText: title };
    return null;
  }

  if (message.type === 'text' && typeof message.text?.body === 'string') {
    return { kind: 'text', messageId, from, text: message.text.body };
  }

  return null;
}

export function parseMetaWebhook(payload: unknown): MetaEvent[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];

  const events: MetaEvent[] = [];

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as { value?: unknown })?.value;
      if (typeof value !== 'object' || value === null) continue;

      const messages = (value as { messages?: unknown }).messages;
      if (Array.isArray(messages)) {
        for (const message of messages as RawMessage[]) {
          const event = parseMessage(message);
          if (event) events.push(event);
        }
      }

      const statuses = (value as { statuses?: unknown }).statuses;
      if (Array.isArray(statuses)) {
        for (const status of statuses as RawStatus[]) {
          if (typeof status.id === 'string' && typeof status.status === 'string') {
            events.push({ kind: 'status', wamid: status.id, status: status.status });
          }
        }
      }
    }
  }

  return events;
}

/** Strips emoji, punctuation, and casing so button labels match reliably. */
function normalizeButtonText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesConfirm(buttonText: string): boolean {
  return normalizeButtonText(buttonText) === 'i confirm';
}

export function matchesCancel(buttonText: string): boolean {
  return normalizeButtonText(buttonText) === 'cancel order';
}
