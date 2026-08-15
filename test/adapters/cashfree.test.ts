import { describe, it, expect, vi } from 'vitest';
import { CashfreeClient } from '../../src/adapters/cashfree.js';

function okResponse(linkUrl = 'https://payments-test.cashfree.com/links/abc123') {
  return new Response(JSON.stringify({ link_id: 'urbnmyth-1042', link_url: linkUrl }), {
    status: 200,
  });
}

const input = {
  linkId: 'urbnmyth-1042',
  amount: 1849,
  customerName: 'Aarav',
  customerPhone: '919876543210',
  purpose: 'Order #1042',
  expiryHours: 24,
};

describe('CashfreeClient', () => {
  it('posts to the sandbox host in TEST mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(
      input,
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://sandbox.cashfree.com/pg/links');
  });

  it('posts to the production host in PROD mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'PROD', fetchImpl }).createLink(
      input,
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.cashfree.com/pg/links');
  });

  it('sends the client credential and version headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({
      appId: 'app-1',
      secretKey: 'sec-1',
      env: 'TEST',
      fetchImpl,
    }).createLink(input);
    const headers = fetchImpl.mock.calls[0]![1].headers;
    expect(headers['x-client-id']).toBe('app-1');
    expect(headers['x-client-secret']).toBe('sec-1');
    expect(headers['x-api-version']).toBe('2023-08-01');
  });

  it('sends the amount in rupees with INR currency', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(
      input,
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.link_amount).toBe(1849);
    expect(body.link_currency).toBe('INR');
    expect(body.link_id).toBe('urbnmyth-1042');
    expect(body.link_purpose).toBe('Order #1042');
    expect(body.customer_details).toEqual({
      customer_name: 'Aarav',
      customer_phone: '919876543210',
    });
  });

  it('computes the expiry from the injected clock', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const now = () => new Date('2026-08-16T10:00:00.000Z');
    await new CashfreeClient({
      appId: 'a',
      secretKey: 's',
      env: 'TEST',
      fetchImpl,
      now,
    }).createLink(input);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.link_expiry_time).toBe('2026-08-17T10:00:00.000Z');
  });

  it('disables Cashfree auto-reminders so our WhatsApp flow owns them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(
      input,
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.link_auto_reminders).toBe(false);
  });

  it('returns the link url and id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('https://cf/links/zzz'));
    const result = await new CashfreeClient({
      appId: 'a',
      secretKey: 's',
      env: 'TEST',
      fetchImpl,
    }).createLink(input);
    expect(result).toEqual({ linkUrl: 'https://cf/links/zzz', linkId: 'urbnmyth-1042' });
  });

  it('throws with the Cashfree message on failure, without leaking the secret', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'link_id already exists' }), { status: 409 }),
      );
    const client = new CashfreeClient({
      appId: 'a',
      secretKey: 'top-secret',
      env: 'TEST',
      fetchImpl,
    });
    await expect(client.createLink(input)).rejects.toThrow(/link_id already exists/);
    await expect(client.createLink(input)).rejects.toThrow(/^(?!.*top-secret).*$/s);
  });
});
