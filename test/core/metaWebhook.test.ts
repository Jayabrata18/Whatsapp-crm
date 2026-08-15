import { describe, it, expect } from 'vitest';
import { parseMetaWebhook, matchesConfirm, matchesCancel } from '../../src/core/metaWebhook.js';

function envelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'w1', changes: [{ field: 'messages', value }] }],
  };
}

describe('parseMetaWebhook', () => {
  it('parses a template quick-reply button', () => {
    const payload = envelope({
      messages: [
        {
          id: 'wamid.AAA',
          from: '919876543210',
          type: 'button',
          button: { text: 'I Confirm', payload: 'I Confirm' },
        },
      ],
    });
    expect(parseMetaWebhook(payload)).toEqual([
      { kind: 'button', messageId: 'wamid.AAA', from: '919876543210', buttonText: 'I Confirm' },
    ]);
  });

  it('parses an interactive button_reply as a button event', () => {
    const payload = envelope({
      messages: [
        {
          id: 'wamid.BBB',
          from: '919876543210',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'I Confirm' } },
        },
      ],
    });
    expect(parseMetaWebhook(payload)).toEqual([
      { kind: 'button', messageId: 'wamid.BBB', from: '919876543210', buttonText: 'I Confirm' },
    ]);
  });

  it('parses a plain text message', () => {
    const payload = envelope({
      messages: [{ id: 'wamid.CCC', from: '919876543210', type: 'text', text: { body: 'hello' } }],
    });
    expect(parseMetaWebhook(payload)).toEqual([
      { kind: 'text', messageId: 'wamid.CCC', from: '919876543210', text: 'hello' },
    ]);
  });

  it('parses delivery statuses', () => {
    const payload = envelope({
      statuses: [
        { id: 'wamid.AAA', status: 'delivered', recipient_id: '919876543210' },
        { id: 'wamid.BBB', status: 'read', recipient_id: '919876543210' },
      ],
    });
    expect(parseMetaWebhook(payload)).toEqual([
      { kind: 'status', wamid: 'wamid.AAA', status: 'delivered' },
      { kind: 'status', wamid: 'wamid.BBB', status: 'read' },
    ]);
  });

  it('parses messages and statuses from multiple entries in one payload', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w1',
          changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.A', status: 'sent' }] } }],
        },
        {
          id: 'w2',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { id: 'wamid.B', from: '919876543210', type: 'text', text: { body: 'hi' } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(payload)).toHaveLength(2);
  });

  it.each([
    [{}, 'empty object'],
    [{ entry: [] }, 'no entries'],
    [{ entry: [{ changes: [] }] }, 'no changes'],
    [envelope({}), 'change with no messages or statuses'],
    [null, 'null'],
    ['not-json', 'a string'],
  ])('returns an empty array for %s (%s)', (payload, _label) => {
    expect(parseMetaWebhook(payload)).toEqual([]);
  });

  it('skips a message with no id without dropping its siblings', () => {
    const payload = envelope({
      messages: [
        { from: '919876543210', type: 'text', text: { body: 'no id' } },
        { id: 'wamid.DDD', from: '919876543210', type: 'text', text: { body: 'has id' } },
      ],
    });
    expect(parseMetaWebhook(payload)).toEqual([
      { kind: 'text', messageId: 'wamid.DDD', from: '919876543210', text: 'has id' },
    ]);
  });
});

describe('button matchers', () => {
  it.each(['I Confirm', 'i confirm', '  I CONFIRM  ', 'I Confirm ✅'])(
    'matches %s as confirm',
    (text) => expect(matchesConfirm(text)).toBe(true),
  );

  it.each(['Cancel Order', 'cancel order', 'CANCEL ORDER'])('matches %s as cancel', (text) =>
    expect(matchesCancel(text)).toBe(true),
  );

  it('does not confuse cancel with confirm', () => {
    expect(matchesConfirm('Cancel Order')).toBe(false);
    expect(matchesCancel('I Confirm')).toBe(false);
  });

  it('rejects unrelated text', () => {
    expect(matchesConfirm('where is my order')).toBe(false);
    expect(matchesCancel('where is my order')).toBe(false);
  });
});
