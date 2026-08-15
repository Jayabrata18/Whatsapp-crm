import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.js';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = createApp({});
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();

    server.close();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});
