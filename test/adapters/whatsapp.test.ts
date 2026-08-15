import { describe, it, expect, vi } from 'vitest';
import { GraphWhatsAppClient } from '../../src/adapters/whatsapp.js';

function okResponse(wamid = 'wamid.XYZ') {
  return new Response(JSON.stringify({ messages: [{ id: wamid }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GraphWhatsAppClient', () => {
  it('posts a template to the right URL with a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });

    await client.sendTemplate({
      to: '919876543210',
      template: 'order_confirm_cod',
      languageCode: 'en',
      bodyParams: ['Aarav', '#1042', 'Tee x2', '1899'],
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('builds the body component from bodyParams in order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });

    await client.sendTemplate({
      to: '919876543210',
      template: 'order_confirm_cod',
      languageCode: 'en',
      bodyParams: ['Aarav', '#1042'],
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: { name: 'order_confirm_cod', language: { code: 'en' } },
    });
    expect(body.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Aarav' },
          { type: 'text', text: '#1042' },
        ],
      },
    ]);
  });

  it('omits the components array when there are no body params', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    await client.sendTemplate({
      to: '919876543210',
      template: 'hello_world',
      languageCode: 'en_US',
      bodyParams: [],
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.template.components).toBeUndefined();
  });

  it('adds a URL button component when a suffix is supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });

    await client.sendTemplate({
      to: '919876543210',
      template: 'pay_early_link',
      languageCode: 'en',
      bodyParams: ['Aarav', '1849', '50'],
      urlButtonSuffix: 'abc123',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.template.components).toContainEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'abc123' }],
    });
  });

  it('returns the wamid from the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('wamid.HELLO'));
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    const result = await client.sendTemplate({
      to: '9',
      template: 't',
      languageCode: 'en',
      bodyParams: [],
    });
    expect(result.wamid).toBe('wamid.HELLO');
  });

  it('throws with the Meta error message on a non-2xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Template name does not exist', code: 132001 } }),
          { status: 400 },
        ),
      );
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    await expect(
      client.sendTemplate({ to: '9', template: 'nope', languageCode: 'en', bodyParams: [] }),
    ).rejects.toThrow(/Template name does not exist/);
  });

  it('never puts the access token in the thrown error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const client = new GraphWhatsAppClient({
      accessToken: 'super-secret-token',
      phoneNumberId: '123',
      fetchImpl,
    });
    await expect(
      client.sendTemplate({ to: '9', template: 't', languageCode: 'en', bodyParams: [] }),
    ).rejects.toThrow(/^(?!.*super-secret-token).*$/s);
  });

  it('throws when the response carries no message id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    await expect(
      client.sendTemplate({ to: '9', template: 't', languageCode: 'en', bodyParams: [] }),
    ).rejects.toThrow(/no message id/);
  });
});
