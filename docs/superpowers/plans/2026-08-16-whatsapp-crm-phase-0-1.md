# URBNMYTH WhatsApp CRM — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript Express "hub" that turns Shopify orders into WhatsApp confirmation messages, converts an "I Confirm" tap into a Cashfree payment link for the order total minus a flat ₹50 COD fee, and shows the whole pipeline on a dashboard.

**Architecture:** Four layers with one-directional dependencies — `routes/` (HTTP edge, signature checks) → `services/` (flow orchestration) → `core/` (pure functions, zero I/O) and `adapters/` (external systems, injected into services). Every adapter is an interface with a real implementation and an in-memory fake, so the test suite never touches the network.

**Tech Stack:** Node 24, TypeScript 5 (strict, ESM), Express 5, Zod, Vitest, `googleapis` + `google-auth-library` (Application Default Credentials), native `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-16-whatsapp-crm-phase-0-1-design.md`

## Global Constraints

- TypeScript strict mode, ESM (`"type": "module"`), Node 24. All relative imports carry a `.js` extension.
- `core/` must not import from `adapters/`, `services/`, or `routes/`. It is pure — no `fetch`, no `fs`, no clock reads except via an injected argument.
- Services receive every adapter through their constructor. No service constructs its own HTTP client.
- `COD_FEE_INR` is `50`, flat, config-driven. Never hardcode `50` outside `.env.example` and test fixtures.
- Status enum is exactly: `PENDING | CONFIRMED | CANCELLED | PAID_EARLY | NO_RESPONSE`.
- Webhook responses: `401` on bad signature, `200` on duplicate or unusable-phone, `500` on downstream failure. Never `200` to hide an error.
- Logs are single-line JSON to stdout. Never log tokens, signatures, or full webhook bodies.
- Google credentials come from Application Default Credentials. No service-account key file in the repo, ever.
- Money is handled in whole rupees as `number`. Cashfree amounts are sent as rupees, not paise.
- Every task ends with a commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | Zod-validated env, fails fast at boot |
| `src/logger.ts` | Single-line JSON logging |
| `src/server.ts` | Express app assembly, raw-body capture |
| `src/index.ts` | Entrypoint, binds `$PORT` |
| `src/core/phone.ts` | `normalizeIndianPhone()` |
| `src/core/signatures.ts` | Three timing-safe verifiers |
| `src/core/shopifyOrder.ts` | `parseShopifyOrder()` |
| `src/core/incentive.ts` | `computePricing()` |
| `src/core/metaWebhook.ts` | `parseMetaWebhook()` |
| `src/core/metrics.ts` | `computeMetrics()` for the dashboard |
| `src/adapters/sheets.ts` | `SheetStore` interface + row types |
| `src/adapters/googleSheetStore.ts` | Sheets implementation |
| `src/adapters/whatsapp.ts` | `WhatsAppClient` + Graph API impl |
| `src/adapters/cashfree.ts` | `PaymentLinkClient` + Cashfree impl |
| `src/adapters/shopifyAdmin.ts` | `OrderTagger` + Admin API impl |
| `src/services/orderIntake.ts` | Shopify order → row → template |
| `src/services/confirmation.ts` | Button reply → CONFIRMED → payment link |
| `src/services/payment.ts` | Cashfree success → PAID_EARLY → tag |
| `src/routes/shopify.ts` | `POST /webhook/shopify` |
| `src/routes/meta.ts` | `GET`/`POST /webhook/meta` |
| `src/routes/cashfree.ts` | `POST /webhook/cashfree` |
| `src/routes/api.ts` | `GET /api/orders`, token-guarded |
| `src/routes/dashboard.ts` | `GET /dashboard` |
| `src/views/dashboard.ts` | HTML template literal |
| `test/fakes/inMemorySheetStore.ts` | Fake store used by every service test |
| `test/fakes/stubClients.ts` | Fake WhatsApp / payment / tagger |
| `scripts/send-hello.ts` | Phase 0 exit test |
| `scripts/fake-order.ts` | Signed fake Shopify payload |
| `docs/templates.md` | Submission-ready WhatsApp template copy |
| `deploy.sh` | Cloud Run deploy wrapper |

---

## Task 1: Project scaffold, config, logger, health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/config.ts`, `src/logger.ts`, `src/server.ts`, `src/index.ts`
- Test: `test/config.test.ts`, `test/health.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`, `type Config`, `log(level, msg, fields?)`, `createApp(deps: AppDeps): express.Express`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "urbnmyth-hub",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "send:hello": "tsx scripts/send-hello.ts",
    "send:fake-order": "tsx scripts/fake-order.ts"
  },
  "dependencies": {
    "express": "^5.1.0",
    "google-auth-library": "^9.15.1",
    "googleapis": "^144.0.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

`tsx` is what runs the TypeScript entrypoints directly. Node's built-in type stripping
cannot be used here: it does not rewrite a `./config.js` specifier to `config.ts`, and
`NodeNext` ESM requires those `.js` specifiers. Vitest handles its own transpilation, so
`tsx` is only needed for `dev` and the two operator scripts.

- [ ] **Step 2: Create `tsconfig.json` and `tsconfig.build.json`**

Two configs, deliberately. `tsconfig.json` covers everything including tests, so
`npm run typecheck` catches a fake that has drifted out of sync with its interface.
`tsconfig.build.json` emits only `src/`, so `dist/index.js` lands where `npm start`
expects it.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no peer-dependency errors.

- [ ] **Step 5: Write the failing config test**

Create `test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  META_ACCESS_TOKEN: 'tok',
  META_PHONE_NUMBER_ID: '123',
  META_WABA_ID: '456',
  META_VERIFY_TOKEN: 'verify',
  META_APP_SECRET: 'secret',
  SHOPIFY_WEBHOOK_SECRET: 'shopsecret',
  SHOPIFY_STORE_DOMAIN: 'urbnmyth.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_x',
  CASHFREE_APP_ID: 'cfid',
  CASHFREE_SECRET_KEY: 'cfsecret',
  CASHFREE_ENV: 'TEST',
  SHEET_ID: 'sheet123',
  DASHBOARD_TOKEN: 'dash',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(valid);
    expect(config.codFeeInr).toBe(50);
    expect(config.port).toBe(8080);
    expect(config.templateLang).toBe('en');
    expect(config.codGatewayNames).toEqual(['cash on delivery', 'cod']);
  });

  it('parses COD_FEE_INR and COD_GATEWAY_NAMES overrides', () => {
    const config = loadConfig({
      ...valid,
      COD_FEE_INR: '75',
      COD_GATEWAY_NAMES: 'Cash on Delivery (COD), Pay on Delivery',
    });
    expect(config.codFeeInr).toBe(75);
    expect(config.codGatewayNames).toEqual(['cash on delivery (cod)', 'pay on delivery']);
  });

  it('throws naming the missing variable', () => {
    const { META_ACCESS_TOKEN, ...missing } = valid;
    expect(() => loadConfig(missing)).toThrow(/META_ACCESS_TOKEN/);
  });

  it('rejects a non-numeric COD_FEE_INR', () => {
    expect(() => loadConfig({ ...valid, COD_FEE_INR: 'fifty' })).toThrow(/COD_FEE_INR/);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npm test -- config`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 7: Implement `src/config.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  META_ACCESS_TOKEN: z.string().min(1),
  META_PHONE_NUMBER_ID: z.string().min(1),
  META_WABA_ID: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1),
  SHOPIFY_STORE_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_TOKEN: z.string().min(1),
  CASHFREE_APP_ID: z.string().min(1),
  CASHFREE_SECRET_KEY: z.string().min(1),
  CASHFREE_ENV: z.enum(['TEST', 'PROD']),
  SHEET_ID: z.string().min(1),
  DASHBOARD_TOKEN: z.string().min(1),
  COD_FEE_INR: z.coerce.number().int().nonnegative().default(50),
  COD_GATEWAY_NAMES: z.string().default('cash on delivery,cod'),
  TEMPLATE_LANG: z.string().default('en'),
});

export interface Config {
  port: number;
  metaAccessToken: string;
  metaPhoneNumberId: string;
  metaWabaId: string;
  metaVerifyToken: string;
  metaAppSecret: string;
  shopifyWebhookSecret: string;
  shopifyStoreDomain: string;
  shopifyAdminToken: string;
  cashfreeAppId: string;
  cashfreeSecretKey: string;
  cashfreeEnv: 'TEST' | 'PROD';
  sheetId: string;
  dashboardToken: string;
  codFeeInr: number;
  codGatewayNames: string[];
  templateLang: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${details}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    metaAccessToken: e.META_ACCESS_TOKEN,
    metaPhoneNumberId: e.META_PHONE_NUMBER_ID,
    metaWabaId: e.META_WABA_ID,
    metaVerifyToken: e.META_VERIFY_TOKEN,
    metaAppSecret: e.META_APP_SECRET,
    shopifyWebhookSecret: e.SHOPIFY_WEBHOOK_SECRET,
    shopifyStoreDomain: e.SHOPIFY_STORE_DOMAIN,
    shopifyAdminToken: e.SHOPIFY_ADMIN_TOKEN,
    cashfreeAppId: e.CASHFREE_APP_ID,
    cashfreeSecretKey: e.CASHFREE_SECRET_KEY,
    cashfreeEnv: e.CASHFREE_ENV,
    sheetId: e.SHEET_ID,
    dashboardToken: e.DASHBOARD_TOKEN,
    codFeeInr: e.COD_FEE_INR,
    codGatewayNames: e.COD_GATEWAY_NAMES.split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
    templateLang: e.TEMPLATE_LANG,
  };
}
```

- [ ] **Step 8: Run the config test**

Run: `npm test -- config`
Expected: PASS, 4 tests.

- [ ] **Step 9: Implement `src/logger.ts`**

```ts
type Level = 'info' | 'warn' | 'error';

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    severity: level.toUpperCase(),
    message,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
```

- [ ] **Step 10: Write the failing health test**

Create `test/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server.js';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = createApp({});
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();

    server.close();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 11: Run it to confirm it fails**

Run: `npm test -- health`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 12: Implement `src/server.ts`**

The `verify` hook is the important part: Shopify and Meta both sign the raw bytes, and re-serializing the parsed object produces different bytes and a failed signature check.

```ts
import express from 'express';
import type { Request, Response } from 'express';

export interface AppDeps {
  // Routers are attached in later tasks. Empty for now.
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function createApp(_deps: AppDeps): express.Express {
  const app = express();

  app.use(
    express.json({
      limit: '2mb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
```

- [ ] **Step 13: Implement `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';

const config = loadConfig(process.env);
const app = createApp({});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});
```

- [ ] **Step 14: Run all tests and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS, 5 tests, no type errors.

- [ ] **Step 15: Create `.env.example`**

```bash
# Meta WhatsApp Cloud API
META_ACCESS_TOKEN=
META_PHONE_NUMBER_ID=
META_WABA_ID=
META_VERIFY_TOKEN=pick-any-random-string-and-paste-the-same-one-in-meta
META_APP_SECRET=

# Shopify
SHOPIFY_WEBHOOK_SECRET=
SHOPIFY_STORE_DOMAIN=urbnmyth.myshopify.com
SHOPIFY_ADMIN_TOKEN=

# Cashfree — TEST or PROD
CASHFREE_APP_ID=
CASHFREE_SECRET_KEY=
CASHFREE_ENV=TEST

# Google Sheets (auth is via Application Default Credentials — no key file)
SHEET_ID=

# Dashboard
DASHBOARD_TOKEN=

# Business rules
COD_FEE_INR=50
COD_GATEWAY_NAMES=cash on delivery,cod
TEMPLATE_LANG=en
```

- [ ] **Step 16: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/ test/
git commit -m "feat: scaffold hub with validated config, logger, and health endpoint"
```

---

## Task 2: Phone normalization

**Files:**
- Create: `src/core/phone.ts`
- Test: `test/core/phone.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeIndianPhone(raw: string | null | undefined): string | null` — returns exactly 12 digits `91XXXXXXXXXX`, or `null` when the input cannot be a valid Indian mobile number.

- [ ] **Step 1: Write the failing test**

Create `test/core/phone.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeIndianPhone } from '../../src/core/phone.js';

describe('normalizeIndianPhone', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['+919876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['9876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['91 98765-43210', '919876543210'],
    ['0091 9876543210', '919876543210'],
    ['  9876543210  ', '919876543210'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeIndianPhone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['12345', 'too short'],
    ['5876543210', 'does not start with 6-9'],
    ['98765432101234', 'too long'],
    ['not-a-phone', 'non-numeric'],
    ['+1 415 555 0123', 'non-Indian country code'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeIndianPhone(input)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(normalizeIndianPhone(null)).toBeNull();
    expect(normalizeIndianPhone(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- phone`
Expected: FAIL — `Cannot find module '../../src/core/phone.js'`

- [ ] **Step 3: Implement `src/core/phone.ts`**

Indian mobile numbers are 10 digits starting 6–9. Everything else — landlines, foreign numbers, junk — is rejected, because sending a template to a bad number costs money and damages the number's quality rating.

```ts
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

export function normalizeIndianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // Strip an international dialling prefix: 0091... or 00...
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Strip the country code.
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  // Strip a domestic trunk prefix.
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (!INDIAN_MOBILE.test(digits)) return null;
  return `91${digits}`;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- phone`
Expected: PASS, 18 assertions across 3 test blocks.

- [ ] **Step 5: Commit**

```bash
git add src/core/phone.ts test/core/phone.test.ts
git commit -m "feat: add Indian phone normalization"
```

---

## Task 3: Webhook signature verification

**Files:**
- Create: `src/core/signatures.ts`
- Test: `test/core/signatures.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `verifyShopifyHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean`
  - `verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean`
  - `verifyCashfreeSignature(rawBody: Buffer, header: string | undefined, timestamp: string | undefined, secret: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/core/signatures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyShopifyHmac,
  verifyMetaSignature,
  verifyCashfreeSignature,
} from '../../src/core/signatures.js';

const body = Buffer.from('{"id":123,"name":"#1042"}');
const secret = 'shhh';

describe('verifyShopifyHmac', () => {
  const valid = createHmac('sha256', secret).update(body).digest('base64');

  it('accepts a correct base64 signature', () => {
    expect(verifyShopifyHmac(body, valid, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyShopifyHmac(Buffer.from('{"id":999}'), valid, secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyShopifyHmac(body, valid, 'wrong')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyShopifyHmac(body, undefined, secret)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    expect(verifyShopifyHmac(body, valid.slice(0, 10), secret)).toBe(false);
  });
});

describe('verifyMetaSignature', () => {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  const valid = `sha256=${digest}`;

  it('accepts a correct sha256= prefixed signature', () => {
    expect(verifyMetaSignature(body, valid, secret)).toBe(true);
  });

  it('rejects a signature missing the sha256= prefix', () => {
    expect(verifyMetaSignature(body, digest, secret)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyMetaSignature(Buffer.from('{"id":999}'), valid, secret)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
  });
});

describe('verifyCashfreeSignature', () => {
  const timestamp = '1755300000';
  const valid = createHmac('sha256', secret)
    .update(timestamp + body.toString('utf8'))
    .digest('base64');

  it('accepts a correct timestamp+body signature', () => {
    expect(verifyCashfreeSignature(body, valid, timestamp, secret)).toBe(true);
  });

  it('rejects a different timestamp', () => {
    expect(verifyCashfreeSignature(body, valid, '1755399999', secret)).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    expect(verifyCashfreeSignature(body, valid, undefined, secret)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyCashfreeSignature(body, undefined, timestamp, secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- signatures`
Expected: FAIL — `Cannot find module '../../src/core/signatures.js'`

- [ ] **Step 3: Implement `src/core/signatures.ts`**

`timingSafeEqual` throws when the two buffers differ in length, which is itself a length oracle and a crash risk on malformed input. The length check happens first, and returns `false` rather than throwing.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyShopifyHmac(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeCompare(header, expected);
}

export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeCompare(header.slice('sha256='.length), expected);
}

export function verifyCashfreeSignature(
  rawBody: Buffer,
  header: string | undefined,
  timestamp: string | undefined,
  secret: string,
): boolean {
  if (!header || !timestamp) return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp + rawBody.toString('utf8'))
    .digest('base64');
  return safeCompare(header, expected);
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- signatures`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/signatures.ts test/core/signatures.test.ts
git commit -m "feat: add timing-safe webhook signature verification"
```

---

## Task 4: Shopify order parsing and COD detection

**Files:**
- Create: `src/core/shopifyOrder.ts`
- Test: `test/core/shopifyOrder.test.ts`, `test/fixtures/shopifyOrder.ts`

**Interfaces:**
- Consumes: `normalizeIndianPhone` from Task 2
- Produces:
  - `interface ParsedOrder { orderNo: string; orderId: string; customerName: string; phone: string | null; amount: number; isCod: boolean; itemsSummary: string }`
  - `parseShopifyOrder(payload: unknown, codGatewayNames: string[]): ParsedOrder`
  - Throws `Error` when the payload has no usable `id` or `name`.

- [ ] **Step 1: Create the fixture builder**

Create `test/fixtures/shopifyOrder.ts`:

```ts
export function shopifyOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5544332211,
    name: '#1042',
    total_price: '1899.00',
    financial_status: 'pending',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    customer: { first_name: 'Aarav', last_name: 'Sharma', phone: null },
    shipping_address: { phone: '+91 98765 43210', first_name: 'Aarav' },
    billing_address: { phone: null },
    line_items: [
      { title: 'Oversized Tee — Black', quantity: 2 },
      { title: 'Cargo Pants — Olive', quantity: 1 },
    ],
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/core/shopifyOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseShopifyOrder } from '../../src/core/shopifyOrder.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';

const COD_NAMES = ['cash on delivery', 'cod'];

describe('parseShopifyOrder', () => {
  it('parses a COD order end to end', () => {
    const order = parseShopifyOrder(shopifyOrderPayload(), COD_NAMES);
    expect(order).toEqual({
      orderNo: '#1042',
      orderId: '5544332211',
      customerName: 'Aarav',
      phone: '919876543210',
      amount: 1899,
      isCod: true,
      itemsSummary: 'Oversized Tee — Black x2, Cargo Pants — Olive x1',
    });
  });

  it('detects COD by substring match, case-insensitively', () => {
    const payload = shopifyOrderPayload({ payment_gateway_names: ['COD'] });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(true);
  });

  it('treats a prepaid gateway as not COD', () => {
    const payload = shopifyOrderPayload({
      payment_gateway_names: ['Razorpay Secure'],
      financial_status: 'paid',
    });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(false);
  });

  it('falls back to financial_status when the gateway list is empty', () => {
    const payload = shopifyOrderPayload({ payment_gateway_names: [], financial_status: 'pending' });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(true);
  });

  it('is not COD when the gateway list is empty and the order is paid', () => {
    const payload = shopifyOrderPayload({ payment_gateway_names: [], financial_status: 'paid' });
    expect(parseShopifyOrder(payload, COD_NAMES).isCod).toBe(false);
  });

  it('falls back from shipping to customer to billing phone', () => {
    const shippingMissing = shopifyOrderPayload({
      shipping_address: { phone: null },
      customer: { first_name: 'Aarav', phone: '9812345678' },
    });
    expect(parseShopifyOrder(shippingMissing, COD_NAMES).phone).toBe('919812345678');

    const onlyBilling = shopifyOrderPayload({
      shipping_address: { phone: null },
      customer: { first_name: 'Aarav', phone: null },
      billing_address: { phone: '08812345678' },
    });
    expect(parseShopifyOrder(onlyBilling, COD_NAMES).phone).toBe('918812345678');
  });

  it('returns a null phone when every candidate is unusable', () => {
    const payload = shopifyOrderPayload({
      shipping_address: { phone: '12345' },
      customer: { first_name: 'Aarav', phone: null },
      billing_address: { phone: null },
    });
    expect(parseShopifyOrder(payload, COD_NAMES).phone).toBeNull();
  });

  it('falls back to a generic name when the customer has none', () => {
    const payload = shopifyOrderPayload({
      customer: { first_name: null, phone: null },
      shipping_address: { phone: '9876543210', first_name: null },
    });
    expect(parseShopifyOrder(payload, COD_NAMES).customerName).toBe('there');
  });

  it('prefers the shipping address name when the customer record has none', () => {
    const payload = shopifyOrderPayload({ customer: { first_name: null, phone: null } });
    expect(parseShopifyOrder(payload, COD_NAMES).customerName).toBe('Aarav');
  });

  it('truncates a long items summary to 180 characters', () => {
    const line_items = Array.from({ length: 30 }, (_, i) => ({
      title: `Very Long Product Name Number ${i}`,
      quantity: 1,
    }));
    const summary = parseShopifyOrder(shopifyOrderPayload({ line_items }), COD_NAMES).itemsSummary;
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('rounds the total to whole rupees', () => {
    const payload = shopifyOrderPayload({ total_price: '1899.60' });
    expect(parseShopifyOrder(payload, COD_NAMES).amount).toBe(1900);
  });

  it('throws when the payload has no id', () => {
    expect(() => parseShopifyOrder({ name: '#1042' }, COD_NAMES)).toThrow(/id/);
  });

  it('throws when the payload has no name', () => {
    expect(() => parseShopifyOrder({ id: 1 }, COD_NAMES)).toThrow(/name/);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- shopifyOrder`
Expected: FAIL — `Cannot find module '../../src/core/shopifyOrder.js'`

- [ ] **Step 4: Implement `src/core/shopifyOrder.ts`**

```ts
import { normalizeIndianPhone } from './phone.js';

export interface ParsedOrder {
  orderNo: string;
  orderId: string;
  customerName: string;
  phone: string | null;
  amount: number;
  isCod: boolean;
  itemsSummary: string;
}

const SUMMARY_MAX = 180;

interface RawAddress {
  phone?: string | null;
  first_name?: string | null;
}

interface RawPayload {
  id?: unknown;
  name?: unknown;
  total_price?: unknown;
  financial_status?: unknown;
  payment_gateway_names?: unknown;
  customer?: { first_name?: string | null; phone?: string | null } | null;
  shipping_address?: RawAddress | null;
  billing_address?: RawAddress | null;
  line_items?: Array<{ title?: string | null; quantity?: number | null }> | null;
}

function detectCod(payload: RawPayload, codGatewayNames: string[]): boolean {
  const gateways = Array.isArray(payload.payment_gateway_names)
    ? payload.payment_gateway_names.filter((g): g is string => typeof g === 'string')
    : [];

  if (gateways.length > 0) {
    return gateways.some((gateway) => {
      const lower = gateway.toLowerCase();
      return codGatewayNames.some((needle) => lower.includes(needle));
    });
  }

  // No gateway information — an unpaid order is almost certainly COD.
  return payload.financial_status === 'pending';
}

function buildItemsSummary(payload: RawPayload): string {
  const items = Array.isArray(payload.line_items) ? payload.line_items : [];
  const summary = items
    .map((item) => `${item?.title ?? 'Item'} x${item?.quantity ?? 1}`)
    .join(', ');
  if (summary.length <= SUMMARY_MAX) return summary;
  return `${summary.slice(0, SUMMARY_MAX - 1)}…`;
}

export function parseShopifyOrder(payload: unknown, codGatewayNames: string[]): ParsedOrder {
  const raw = (payload ?? {}) as RawPayload;

  if (raw.id === undefined || raw.id === null || raw.id === '') {
    throw new Error('Shopify payload is missing id');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('Shopify payload is missing name');
  }

  const phone =
    normalizeIndianPhone(raw.shipping_address?.phone) ??
    normalizeIndianPhone(raw.customer?.phone) ??
    normalizeIndianPhone(raw.billing_address?.phone);

  const customerName =
    raw.customer?.first_name?.trim() || raw.shipping_address?.first_name?.trim() || 'there';

  const amount = Math.round(Number(raw.total_price ?? 0));

  return {
    orderNo: raw.name,
    orderId: String(raw.id),
    customerName,
    phone,
    amount: Number.isFinite(amount) ? amount : 0,
    isCod: detectCod(raw, codGatewayNames),
    itemsSummary: buildItemsSummary(raw),
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npm test -- shopifyOrder`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/shopifyOrder.ts test/core/shopifyOrder.test.ts test/fixtures/shopifyOrder.ts
git commit -m "feat: parse Shopify orders and detect COD"
```

---

## Task 5: Pricing and the COD-fee waiver

**Files:**
- Create: `src/core/incentive.ts`
- Test: `test/core/incentive.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Pricing { payable: number; codFee: number }`
  - `computePricing(amount: number, isCod: boolean, codFeeInr: number): Pricing`

- [ ] **Step 1: Write the failing test**

Create `test/core/incentive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computePricing } from '../../src/core/incentive.js';

describe('computePricing', () => {
  it('waives the COD fee on a COD order', () => {
    expect(computePricing(1899, true, 50)).toEqual({ payable: 1849, codFee: 50 });
  });

  it('charges a prepaid order the full amount with no fee', () => {
    expect(computePricing(1899, false, 50)).toEqual({ payable: 1899, codFee: 0 });
  });

  it('does not waive when the order total equals the fee', () => {
    expect(computePricing(50, true, 50)).toEqual({ payable: 50, codFee: 0 });
  });

  it('does not waive when the order total is below the fee', () => {
    expect(computePricing(30, true, 50)).toEqual({ payable: 30, codFee: 0 });
  });

  it('never produces a zero or negative payable', () => {
    for (const amount of [0, 1, 25, 49, 50, 51]) {
      const { payable } = computePricing(amount, true, 50);
      expect(payable).toBeGreaterThanOrEqual(amount > 0 ? 1 : 0);
      expect(payable).toBeLessThanOrEqual(amount);
    }
  });

  it('honours a configured fee other than 50', () => {
    expect(computePricing(2000, true, 75)).toEqual({ payable: 1925, codFee: 75 });
  });

  it('applies no waiver when the fee is configured to zero', () => {
    expect(computePricing(1899, true, 0)).toEqual({ payable: 1899, codFee: 0 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- incentive`
Expected: FAIL — `Cannot find module '../../src/core/incentive.js'`

- [ ] **Step 3: Implement `src/core/incentive.ts`**

The guard matters: a payment link for ₹0 or a negative amount is rejected by Cashfree and would strand the order in CONFIRMED with no link. On a tiny order the customer simply pays full price and gets no discount, which is the correct commercial answer anyway.

```ts
export interface Pricing {
  /** What the customer pays on the early-payment link, in whole rupees. */
  payable: number;
  /** The COD fee actually waived. Zero when no waiver applies. */
  codFee: number;
}

export function computePricing(amount: number, isCod: boolean, codFeeInr: number): Pricing {
  if (!isCod || codFeeInr <= 0 || amount <= codFeeInr) {
    return { payable: amount, codFee: 0 };
  }
  return { payable: amount - codFeeInr, codFee: codFeeInr };
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- incentive`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/incentive.ts test/core/incentive.test.ts
git commit -m "feat: add COD-fee waiver pricing rule"
```

---

## Task 6: Meta webhook parsing

**Files:**
- Create: `src/core/metaWebhook.ts`
- Test: `test/core/metaWebhook.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type MetaEvent = { kind: 'button'; messageId: string; from: string; buttonText: string } | { kind: 'text'; messageId: string; from: string; text: string } | { kind: 'status'; wamid: string; status: string }`
  - `parseMetaWebhook(payload: unknown): MetaEvent[]`
  - `matchesConfirm(buttonText: string): boolean`
  - `matchesCancel(buttonText: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/core/metaWebhook.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseMetaWebhook, matchesConfirm, matchesCancel } from '../../src/core/metaWebhook.js';

function envelope(value: Record<string, unknown>) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'w1', changes: [{ field: 'messages', value }] }] };
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
        { id: 'w1', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.A', status: 'sent' }] } }] },
        {
          id: 'w2',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [{ id: 'wamid.B', from: '919876543210', type: 'text', text: { body: 'hi' } }],
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
  ])('returns an empty array for %s (%s)', (payload) => {
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- metaWebhook`
Expected: FAIL — `Cannot find module '../../src/core/metaWebhook.js'`

- [ ] **Step 3: Implement `src/core/metaWebhook.ts`**

Meta delivers template quick-reply taps as `type: 'button'` and interactive-message taps as `type: 'interactive'`. Both are normalized to one `button` event so the service layer only handles one shape.

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `npm test -- metaWebhook`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/metaWebhook.ts test/core/metaWebhook.test.ts
git commit -m "feat: parse Meta webhook messages, buttons, and delivery statuses"
```

---

## Task 7: SheetStore interface and the in-memory fake

**Files:**
- Create: `src/adapters/sheets.ts`
- Create: `test/fakes/inMemorySheetStore.ts`
- Test: `test/fakes/inMemorySheetStore.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ConfirmStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'PAID_EARLY' | 'NO_RESPONSE'`
  - `interface OrderRow`, `interface MessageRow`, `interface SheetStore`
  - `class InMemorySheetStore implements SheetStore` (test-only)

The fake is written and tested first because every service test in Tasks 11–13 depends on it. A buggy fake produces green tests over broken code.

- [ ] **Step 1: Define `src/adapters/sheets.ts`**

This task has no failing-test-first step for the interface itself — a TypeScript interface has no behaviour to test. The behaviour lives in the fake (Step 3) and the Google implementation (Task 8), and both are tested.

```ts
export type ConfirmStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'PAID_EARLY' | 'NO_RESPONSE';

export interface OrderRow {
  orderNo: string;
  orderId: string;
  customerName: string;
  phone: string;
  amount: number;
  codFee: number;
  payable: number;
  isCod: boolean;
  confirmStatus: ConfirmStatus;
  paymentLink: string;
  createdAt: string;
  confirmedAt: string;
  paidAt: string;
}

export interface MessageRow {
  orderNo: string;
  template: string;
  wamid: string;
  direction: 'out' | 'in';
  status: string;
  timestamp: string;
}

export type EventSource = 'shopify' | 'meta' | 'cashfree';

export interface SheetStore {
  appendOrder(row: OrderRow): Promise<void>;
  listOrders(): Promise<OrderRow[]>;
  findOrderByNo(orderNo: string): Promise<OrderRow | null>;
  /** Most recently created order for this phone in PENDING status, or null. */
  findLatestPendingByPhone(phone: string): Promise<OrderRow | null>;
  updateOrder(orderNo: string, patch: Partial<OrderRow>): Promise<void>;
  appendMessage(row: MessageRow): Promise<void>;
  updateMessageStatus(wamid: string, status: string): Promise<void>;
  /** True when this exact event was already processed. */
  hasEvent(source: EventSource, externalId: string): Promise<boolean>;
  recordEvent(source: EventSource, externalId: string): Promise<void>;
}

export const ORDER_HEADERS = [
  'order_no', 'order_id', 'customer_name', 'phone', 'amount', 'cod_fee', 'payable',
  'is_cod', 'confirm_status', 'payment_link', 'created_at', 'confirmed_at', 'paid_at',
] as const;

export const MESSAGE_HEADERS = [
  'order_no', 'template', 'wamid', 'direction', 'status', 'timestamp',
] as const;

export const EVENT_HEADERS = ['source', 'external_id', 'received_at'] as const;
```

- [ ] **Step 2: Write the failing fake test**

Create `test/fakes/inMemorySheetStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemorySheetStore } from './inMemorySheetStore.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
    amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'PENDING',
    paymentLink: '', createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '', paidAt: '',
    ...overrides,
  };
}

describe('InMemorySheetStore', () => {
  it('appends and lists orders', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    expect(await store.listOrders()).toHaveLength(1);
  });

  it('finds an order by number and returns null for an unknown one', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    expect((await store.findOrderByNo('#1042'))?.orderId).toBe('5544332211');
    expect(await store.findOrderByNo('#9999')).toBeNull();
  });

  it('patches an order without disturbing other fields', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    await store.updateOrder('#1042', { confirmStatus: 'CONFIRMED', confirmedAt: 'now' });
    const updated = await store.findOrderByNo('#1042');
    expect(updated?.confirmStatus).toBe('CONFIRMED');
    expect(updated?.confirmedAt).toBe('now');
    expect(updated?.amount).toBe(1899);
  });

  it('returns the most recent PENDING order for a phone', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order({ orderNo: '#1001', createdAt: '2026-08-14T10:00:00.000Z' }));
    await store.appendOrder(order({ orderNo: '#1042', createdAt: '2026-08-16T10:00:00.000Z' }));
    expect((await store.findLatestPendingByPhone('919876543210'))?.orderNo).toBe('#1042');
  });

  it('ignores non-PENDING orders when matching by phone', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order({ orderNo: '#1042', confirmStatus: 'PAID_EARLY' }));
    expect(await store.findLatestPendingByPhone('919876543210')).toBeNull();
  });

  it('does not match a different phone', async () => {
    const store = new InMemorySheetStore();
    await store.appendOrder(order());
    expect(await store.findLatestPendingByPhone('919000000000')).toBeNull();
  });

  it('records and detects events per source', async () => {
    const store = new InMemorySheetStore();
    expect(await store.hasEvent('shopify', '5544332211')).toBe(false);
    await store.recordEvent('shopify', '5544332211');
    expect(await store.hasEvent('shopify', '5544332211')).toBe(true);
    expect(await store.hasEvent('meta', '5544332211')).toBe(false);
  });

  it('updates a message status by wamid', async () => {
    const store = new InMemorySheetStore();
    await store.appendMessage({
      orderNo: '#1042', template: 'order_confirm_cod', wamid: 'wamid.AAA',
      direction: 'out', status: 'sent', timestamp: '2026-08-16T10:00:00.000Z',
    });
    await store.updateMessageStatus('wamid.AAA', 'delivered');
    expect(store.messages[0]?.status).toBe('delivered');
  });

  it('ignores a status update for an unknown wamid', async () => {
    const store = new InMemorySheetStore();
    await expect(store.updateMessageStatus('wamid.NOPE', 'read')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- inMemorySheetStore`
Expected: FAIL — `Cannot find module './inMemorySheetStore.js'`

- [ ] **Step 4: Implement `test/fakes/inMemorySheetStore.ts`**

```ts
import type {
  EventSource, MessageRow, OrderRow, SheetStore,
} from '../../src/adapters/sheets.js';

export class InMemorySheetStore implements SheetStore {
  orders: OrderRow[] = [];
  messages: MessageRow[] = [];
  events = new Set<string>();

  async appendOrder(row: OrderRow): Promise<void> {
    this.orders.push({ ...row });
  }

  async listOrders(): Promise<OrderRow[]> {
    return this.orders.map((row) => ({ ...row }));
  }

  async findOrderByNo(orderNo: string): Promise<OrderRow | null> {
    const found = this.orders.find((row) => row.orderNo === orderNo);
    return found ? { ...found } : null;
  }

  async findLatestPendingByPhone(phone: string): Promise<OrderRow | null> {
    const matches = this.orders
      .filter((row) => row.phone === phone && row.confirmStatus === 'PENDING')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = matches.at(-1);
    return latest ? { ...latest } : null;
  }

  async updateOrder(orderNo: string, patch: Partial<OrderRow>): Promise<void> {
    const index = this.orders.findIndex((row) => row.orderNo === orderNo);
    if (index === -1) return;
    this.orders[index] = { ...this.orders[index]!, ...patch };
  }

  async appendMessage(row: MessageRow): Promise<void> {
    this.messages.push({ ...row });
  }

  async updateMessageStatus(wamid: string, status: string): Promise<void> {
    const index = this.messages.findIndex((row) => row.wamid === wamid);
    if (index === -1) return;
    this.messages[index] = { ...this.messages[index]!, status };
  }

  async hasEvent(source: EventSource, externalId: string): Promise<boolean> {
    return this.events.has(`${source}:${externalId}`);
  }

  async recordEvent(source: EventSource, externalId: string): Promise<void> {
    this.events.add(`${source}:${externalId}`);
  }
}
```

- [ ] **Step 5: Run the test**

Run: `npm test -- inMemorySheetStore`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/sheets.ts test/fakes/inMemorySheetStore.ts test/fakes/inMemorySheetStore.test.ts
git commit -m "feat: define SheetStore interface and in-memory test fake"
```

---

## Task 8: Google Sheets implementation

**Files:**
- Create: `src/adapters/googleSheetStore.ts`
- Test: `test/adapters/googleSheetStore.test.ts`

**Interfaces:**
- Consumes: `SheetStore`, `OrderRow`, `MessageRow`, header constants from Task 7
- Produces:
  - `interface SheetsApi` — the narrow slice of the Google client this adapter uses
  - `class GoogleSheetStore implements SheetStore` with `constructor(api: SheetsApi, sheetId: string)`
  - `createSheetsApi(): Promise<SheetsApi>` — real client via Application Default Credentials
  - `orderRowToValues(row: OrderRow): (string | number | boolean)[]` and `valuesToOrderRow(values: unknown[]): OrderRow`

`SheetsApi` is a hand-rolled two-method interface rather than the full `googleapis` type. It keeps the adapter testable with a plain object and keeps the Google SDK out of the test suite entirely.

- [ ] **Step 1: Write the failing test**

Create `test/adapters/googleSheetStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GoogleSheetStore, orderRowToValues, valuesToOrderRow } from '../../src/adapters/googleSheetStore.js';
import type { SheetsApi } from '../../src/adapters/googleSheetStore.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
    amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'PENDING',
    paymentLink: '', createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '', paidAt: '',
    ...overrides,
  };
}

class FakeSheetsApi implements SheetsApi {
  tabs: Record<string, unknown[][]> = { orders: [], messages: [], events: [] };
  appended: Array<{ range: string; values: unknown[][] }> = [];
  updated: Array<{ range: string; values: unknown[][] }> = [];

  async getValues(_sheetId: string, range: string): Promise<unknown[][]> {
    const tab = range.split('!')[0]!;
    return this.tabs[tab] ?? [];
  }

  async appendValues(_sheetId: string, range: string, values: unknown[][]): Promise<void> {
    const tab = range.split('!')[0]!;
    this.tabs[tab] = [...(this.tabs[tab] ?? []), ...values];
    this.appended.push({ range, values });
  }

  async updateValues(_sheetId: string, range: string, values: unknown[][]): Promise<void> {
    this.updated.push({ range, values });
  }
}

describe('row serialization', () => {
  it('round-trips an order row', () => {
    const original = order({ paymentLink: 'https://cf.link/abc', confirmedAt: 'x' });
    expect(valuesToOrderRow(orderRowToValues(original))).toEqual(original);
  });

  it('coerces sheet string values back to the right types', () => {
    const values = ['#1042', '5544332211', 'Aarav', '919876543210', '1899', '50', '1849',
      'TRUE', 'PENDING', '', '2026-08-16T10:00:00.000Z', '', ''];
    const row = valuesToOrderRow(values);
    expect(row.amount).toBe(1899);
    expect(row.payable).toBe(1849);
    expect(row.isCod).toBe(true);
  });

  it('treats a short row from the sheet as empty trailing fields', () => {
    const row = valuesToOrderRow(['#1042', '5544332211', 'Aarav', '919876543210', '1899', '50', '1849', 'FALSE', 'PENDING']);
    expect(row.paymentLink).toBe('');
    expect(row.paidAt).toBe('');
    expect(row.isCod).toBe(false);
  });
});

describe('GoogleSheetStore', () => {
  it('appends an order below the header row', async () => {
    const api = new FakeSheetsApi();
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.appendOrder(order());
    expect(api.appended[0]?.range).toBe('orders!A:M');
    expect(api.appended[0]?.values[0]?.[0]).toBe('#1042');
  });

  it('lists orders and skips the header row', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [
      ['order_no', 'order_id', 'customer_name', 'phone', 'amount', 'cod_fee', 'payable',
        'is_cod', 'confirm_status', 'payment_link', 'created_at', 'confirmed_at', 'paid_at'],
      orderRowToValues(order()),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    const orders = await store.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.orderNo).toBe('#1042');
  });

  it('returns an empty list when the tab holds only a header', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [['order_no']];
    expect(await new GoogleSheetStore(api, 'sheet123').listOrders()).toEqual([]);
  });

  it('updates the correct 1-indexed row, accounting for the header', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [['header'], orderRowToValues(order({ orderNo: '#1001' })), orderRowToValues(order())];
    const store = new GoogleSheetStore(api, 'sheet123');
    await store.updateOrder('#1042', { confirmStatus: 'CONFIRMED' });
    // header is row 1, #1001 is row 2, #1042 is row 3
    expect(api.updated[0]?.range).toBe('orders!A3:M3');
    expect(api.updated[0]?.values[0]?.[8]).toBe('CONFIRMED');
  });

  it('does nothing when updating an unknown order', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [['header']];
    await new GoogleSheetStore(api, 'sheet123').updateOrder('#9999', { confirmStatus: 'CONFIRMED' });
    expect(api.updated).toHaveLength(0);
  });

  it('records and detects events', async () => {
    const api = new FakeSheetsApi();
    api.tabs.events = [['source', 'external_id', 'received_at']];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect(await store.hasEvent('shopify', '55443')).toBe(false);
    await store.recordEvent('shopify', '55443');
    expect(await store.hasEvent('shopify', '55443')).toBe(true);
    expect(await store.hasEvent('meta', '55443')).toBe(false);
  });

  it('finds the latest PENDING order for a phone', async () => {
    const api = new FakeSheetsApi();
    api.tabs.orders = [
      ['header'],
      orderRowToValues(order({ orderNo: '#1001', createdAt: '2026-08-14T10:00:00.000Z' })),
      orderRowToValues(order({ orderNo: '#1042', createdAt: '2026-08-16T10:00:00.000Z' })),
      orderRowToValues(order({ orderNo: '#1050', confirmStatus: 'PAID_EARLY', createdAt: '2026-08-17T10:00:00.000Z' })),
    ];
    const store = new GoogleSheetStore(api, 'sheet123');
    expect((await store.findLatestPendingByPhone('919876543210'))?.orderNo).toBe('#1042');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- googleSheetStore`
Expected: FAIL — `Cannot find module '../../src/adapters/googleSheetStore.js'`

- [ ] **Step 3: Implement `src/adapters/googleSheetStore.ts`**

```ts
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import {
  type EventSource, type MessageRow, type OrderRow, type SheetStore,
} from './sheets.js';

/** The narrow slice of the Sheets API this adapter needs. */
export interface SheetsApi {
  getValues(sheetId: string, range: string): Promise<unknown[][]>;
  appendValues(sheetId: string, range: string, values: unknown[][]): Promise<void>;
  updateValues(sheetId: string, range: string, values: unknown[][]): Promise<void>;
}

const ORDERS_RANGE = 'orders!A:M';
const MESSAGES_RANGE = 'messages!A:F';
const EVENTS_RANGE = 'events!A:C';

export function orderRowToValues(row: OrderRow): (string | number | boolean)[] {
  return [
    row.orderNo, row.orderId, row.customerName, row.phone, row.amount, row.codFee,
    row.payable, row.isCod ? 'TRUE' : 'FALSE', row.confirmStatus, row.paymentLink,
    row.createdAt, row.confirmedAt, row.paidAt,
  ];
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function valuesToOrderRow(values: unknown[]): OrderRow {
  return {
    orderNo: str(values[0]),
    orderId: str(values[1]),
    customerName: str(values[2]),
    phone: str(values[3]),
    amount: num(values[4]),
    codFee: num(values[5]),
    payable: num(values[6]),
    isCod: str(values[7]).toUpperCase() === 'TRUE',
    confirmStatus: (str(values[8]) || 'PENDING') as OrderRow['confirmStatus'],
    paymentLink: str(values[9]),
    createdAt: str(values[10]),
    confirmedAt: str(values[11]),
    paidAt: str(values[12]),
  };
}

function messageRowToValues(row: MessageRow): string[] {
  return [row.orderNo, row.template, row.wamid, row.direction, row.status, row.timestamp];
}

export class GoogleSheetStore implements SheetStore {
  constructor(
    private readonly api: SheetsApi,
    private readonly sheetId: string,
  ) {}

  /** Rows below the header, paired with their 1-indexed sheet row number. */
  private async orderRowsWithIndex(): Promise<Array<{ row: OrderRow; sheetRow: number }>> {
    const values = await this.api.getValues(this.sheetId, ORDERS_RANGE);
    return values
      .slice(1)
      .map((values, index) => ({ row: valuesToOrderRow(values), sheetRow: index + 2 }))
      .filter((entry) => entry.row.orderNo !== '');
  }

  async appendOrder(row: OrderRow): Promise<void> {
    await this.api.appendValues(this.sheetId, ORDERS_RANGE, [orderRowToValues(row)]);
  }

  async listOrders(): Promise<OrderRow[]> {
    return (await this.orderRowsWithIndex()).map((entry) => entry.row);
  }

  async findOrderByNo(orderNo: string): Promise<OrderRow | null> {
    const found = (await this.orderRowsWithIndex()).find((entry) => entry.row.orderNo === orderNo);
    return found?.row ?? null;
  }

  async findLatestPendingByPhone(phone: string): Promise<OrderRow | null> {
    const matches = (await this.orderRowsWithIndex())
      .map((entry) => entry.row)
      .filter((row) => row.phone === phone && row.confirmStatus === 'PENDING')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return matches.at(-1) ?? null;
  }

  async updateOrder(orderNo: string, patch: Partial<OrderRow>): Promise<void> {
    const entry = (await this.orderRowsWithIndex()).find((e) => e.row.orderNo === orderNo);
    if (!entry) return;
    const merged = { ...entry.row, ...patch };
    await this.api.updateValues(
      this.sheetId,
      `orders!A${entry.sheetRow}:M${entry.sheetRow}`,
      [orderRowToValues(merged)],
    );
  }

  async appendMessage(row: MessageRow): Promise<void> {
    await this.api.appendValues(this.sheetId, MESSAGES_RANGE, [messageRowToValues(row)]);
  }

  async updateMessageStatus(wamid: string, status: string): Promise<void> {
    const values = await this.api.getValues(this.sheetId, MESSAGES_RANGE);
    // Row 1 is the header, so array index i maps to sheet row i + 1.
    const index = values.findIndex((row, i) => i > 0 && str(row[2]) === wamid);
    if (index === -1) return;
    const sheetRow = index + 1;
    await this.api.updateValues(this.sheetId, `messages!E${sheetRow}:E${sheetRow}`, [[status]]);
  }

  async hasEvent(source: EventSource, externalId: string): Promise<boolean> {
    const values = await this.api.getValues(this.sheetId, EVENTS_RANGE);
    return values
      .slice(1)
      .some((row) => str(row[0]) === source && str(row[1]) === externalId);
  }

  async recordEvent(source: EventSource, externalId: string): Promise<void> {
    await this.api.appendValues(this.sheetId, EVENTS_RANGE, [
      [source, externalId, new Date().toISOString()],
    ]);
  }
}

/** Real Sheets client, authenticated via Application Default Credentials. */
export async function createSheetsApi(): Promise<SheetsApi> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as never });

  return {
    async getValues(sheetId, range) {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
      return res.data.values ?? [];
    },
    async appendValues(sheetId, range, values) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: values as never },
      });
    },
    async updateValues(sheetId, range, values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: values as never },
      });
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- googleSheetStore`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify both stores satisfy the same interface**

Run: `npm run typecheck`
Expected: no errors. If `InMemorySheetStore` and `GoogleSheetStore` have drifted, this is where it surfaces.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/googleSheetStore.ts test/adapters/googleSheetStore.test.ts
git commit -m "feat: implement Google Sheets store with ADC auth"
```

---

## Task 9: WhatsApp Graph API adapter

**Files:**
- Create: `src/adapters/whatsapp.ts`
- Test: `test/adapters/whatsapp.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface WhatsAppClient { sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }> }`
  - `interface SendTemplateInput { to: string; template: string; languageCode: string; bodyParams: string[]; urlButtonSuffix?: string }`
  - `class GraphWhatsAppClient implements WhatsAppClient` with `constructor(opts: { accessToken: string; phoneNumberId: string; fetchImpl?: typeof fetch })`

`bodyParams` is a plain string array rather than the raw Graph `components` structure. Services should not have to know Graph's component schema; the adapter owns that translation.

- [ ] **Step 1: Write the failing test**

Create `test/adapters/whatsapp.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { GraphWhatsAppClient } from '../../src/adapters/whatsapp.js';

function okResponse(wamid = 'wamid.XYZ') {
  return new Response(JSON.stringify({ messages: [{ id: wamid }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

describe('GraphWhatsAppClient', () => {
  it('posts a template to the right URL with a bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });

    await client.sendTemplate({
      to: '919876543210', template: 'order_confirm_cod', languageCode: 'en',
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
      to: '919876543210', template: 'order_confirm_cod', languageCode: 'en',
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
      { type: 'body', parameters: [{ type: 'text', text: 'Aarav' }, { type: 'text', text: '#1042' }] },
    ]);
  });

  it('omits the components array when there are no body params', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    await client.sendTemplate({ to: '919876543210', template: 'hello_world', languageCode: 'en_US', bodyParams: [] });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.template.components).toBeUndefined();
  });

  it('adds a URL button component when a suffix is supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });

    await client.sendTemplate({
      to: '919876543210', template: 'pay_early_link', languageCode: 'en',
      bodyParams: ['Aarav', '1849', '50'], urlButtonSuffix: 'abc123',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.template.components).toContainEqual({
      type: 'button', sub_type: 'url', index: '0',
      parameters: [{ type: 'text', text: 'abc123' }],
    });
  });

  it('returns the wamid from the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('wamid.HELLO'));
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    const result = await client.sendTemplate({ to: '9', template: 't', languageCode: 'en', bodyParams: [] });
    expect(result.wamid).toBe('wamid.HELLO');
  });

  it('throws with the Meta error message on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Template name does not exist', code: 132001 } }), { status: 400 }),
    );
    const client = new GraphWhatsAppClient({ accessToken: 'tok', phoneNumberId: '123', fetchImpl });
    await expect(
      client.sendTemplate({ to: '9', template: 'nope', languageCode: 'en', bodyParams: [] }),
    ).rejects.toThrow(/Template name does not exist/);
  });

  it('never puts the access token in the thrown error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const client = new GraphWhatsAppClient({ accessToken: 'super-secret-token', phoneNumberId: '123', fetchImpl });
    await expect(
      client.sendTemplate({ to: '9', template: 't', languageCode: 'en', bodyParams: [] }),
    ).rejects.toThrow(/^(?!.*super-secret-token).*$/s);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- adapters/whatsapp`
Expected: FAIL — `Cannot find module '../../src/adapters/whatsapp.js'`

- [ ] **Step 3: Implement `src/adapters/whatsapp.ts`**

```ts
const GRAPH_VERSION = 'v21.0';

export interface SendTemplateInput {
  to: string;
  template: string;
  languageCode: string;
  bodyParams: string[];
  /** Dynamic suffix appended to a URL button, if the template has one. */
  urlButtonSuffix?: string;
}

export interface WhatsAppClient {
  sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }>;
}

interface Component {
  type: string;
  sub_type?: string;
  index?: string;
  parameters: Array<{ type: 'text'; text: string }>;
}

export class GraphWhatsAppClient implements WhatsAppClient {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { accessToken: string; phoneNumberId: string; fetchImpl?: typeof fetch }) {
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }> {
    const components: Component[] = [];

    if (input.bodyParams.length > 0) {
      components.push({
        type: 'body',
        parameters: input.bodyParams.map((text) => ({ type: 'text' as const, text })),
      });
    }

    if (input.urlButtonSuffix) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: input.urlButtonSuffix }],
      });
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.template,
        language: { code: input.languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    const res = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: number } };
        if (parsed.error?.message) detail = `${parsed.error.message} (code ${parsed.error.code})`;
      } catch {
        // Non-JSON error body; fall through with the raw text.
      }
      throw new Error(`WhatsApp send failed [${res.status}] template=${input.template}: ${detail}`);
    }

    const parsed = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    const wamid = parsed.messages?.[0]?.id;
    if (!wamid) throw new Error(`WhatsApp send returned no message id for template=${input.template}`);
    return { wamid };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- adapters/whatsapp`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/whatsapp.ts test/adapters/whatsapp.test.ts
git commit -m "feat: add WhatsApp Graph API template sender"
```

---

## Task 10: Cashfree payment links and Shopify order tagging

**Files:**
- Create: `src/adapters/cashfree.ts`, `src/adapters/shopifyAdmin.ts`
- Test: `test/adapters/cashfree.test.ts`, `test/adapters/shopifyAdmin.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface PaymentLinkClient { createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }> }`
  - `interface CreateLinkInput { linkId: string; amount: number; customerName: string; customerPhone: string; purpose: string; expiryHours: number }`
  - `class CashfreeClient implements PaymentLinkClient` with `constructor(opts: { appId: string; secretKey: string; env: 'TEST' | 'PROD'; fetchImpl?: typeof fetch; now?: () => Date })`
  - `interface OrderTagger { addTag(orderId: string, tag: string): Promise<void> }`
  - `class ShopifyAdminClient implements OrderTagger` with `constructor(opts: { storeDomain: string; adminToken: string; fetchImpl?: typeof fetch })`

- [ ] **Step 1: Write the failing Cashfree test**

Create `test/adapters/cashfree.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { CashfreeClient } from '../../src/adapters/cashfree.js';

function okResponse(linkUrl = 'https://payments-test.cashfree.com/links/abc123') {
  return new Response(JSON.stringify({ link_id: 'urbnmyth-1042', link_url: linkUrl }), { status: 200 });
}

const input = {
  linkId: 'urbnmyth-1042', amount: 1849, customerName: 'Aarav',
  customerPhone: '919876543210', purpose: 'Order #1042', expiryHours: 24,
};

describe('CashfreeClient', () => {
  it('posts to the sandbox host in TEST mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(input);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://sandbox.cashfree.com/pg/links');
  });

  it('posts to the production host in PROD mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'PROD', fetchImpl }).createLink(input);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.cashfree.com/pg/links');
  });

  it('sends the client credential and version headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'app-1', secretKey: 'sec-1', env: 'TEST', fetchImpl }).createLink(input);
    const headers = fetchImpl.mock.calls[0]![1].headers;
    expect(headers['x-client-id']).toBe('app-1');
    expect(headers['x-client-secret']).toBe('sec-1');
    expect(headers['x-api-version']).toBe('2023-08-01');
  });

  it('sends the amount in rupees with INR currency', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(input);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.link_amount).toBe(1849);
    expect(body.link_currency).toBe('INR');
    expect(body.link_id).toBe('urbnmyth-1042');
    expect(body.link_purpose).toBe('Order #1042');
    expect(body.customer_details).toEqual({ customer_name: 'Aarav', customer_phone: '919876543210' });
  });

  it('computes the expiry from the injected clock', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const now = () => new Date('2026-08-16T10:00:00.000Z');
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl, now }).createLink(input);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.link_expiry_time).toBe('2026-08-17T10:00:00.000Z');
  });

  it('disables Cashfree auto-reminders so our WhatsApp flow owns them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(input);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.link_auto_reminders).toBe(false);
  });

  it('returns the link url and id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('https://cf/links/zzz'));
    const result = await new CashfreeClient({ appId: 'a', secretKey: 's', env: 'TEST', fetchImpl }).createLink(input);
    expect(result).toEqual({ linkUrl: 'https://cf/links/zzz', linkId: 'urbnmyth-1042' });
  });

  it('throws with the Cashfree message on failure, without leaking the secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'link_id already exists' }), { status: 409 }),
    );
    const client = new CashfreeClient({ appId: 'a', secretKey: 'top-secret', env: 'TEST', fetchImpl });
    await expect(client.createLink(input)).rejects.toThrow(/link_id already exists/);
    await expect(client.createLink(input)).rejects.toThrow(/^(?!.*top-secret).*$/s);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- adapters/cashfree`
Expected: FAIL — `Cannot find module '../../src/adapters/cashfree.js'`

- [ ] **Step 3: Implement `src/adapters/cashfree.ts`**

```ts
export interface CreateLinkInput {
  /** Stable, caller-supplied id — makes link creation idempotent on Cashfree's side. */
  linkId: string;
  amount: number;
  customerName: string;
  customerPhone: string;
  purpose: string;
  expiryHours: number;
}

export interface PaymentLinkClient {
  createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }>;
}

const HOSTS = {
  TEST: 'https://sandbox.cashfree.com',
  PROD: 'https://api.cashfree.com',
} as const;

export class CashfreeClient implements PaymentLinkClient {
  private readonly appId: string;
  private readonly secretKey: string;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: {
    appId: string;
    secretKey: string;
    env: 'TEST' | 'PROD';
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.appId = opts.appId;
    this.secretKey = opts.secretKey;
    this.host = HOSTS[opts.env];
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }> {
    const expiry = new Date(this.now().getTime() + input.expiryHours * 3600_000).toISOString();

    const res = await this.fetchImpl(`${this.host}/pg/links`, {
      method: 'POST',
      headers: {
        'x-client-id': this.appId,
        'x-client-secret': this.secretKey,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        link_id: input.linkId,
        link_amount: input.amount,
        link_currency: 'INR',
        link_purpose: input.purpose,
        customer_details: {
          customer_name: input.customerName,
          customer_phone: input.customerPhone,
        },
        link_expiry_time: expiry,
        // Our WhatsApp flow owns reminders; Cashfree's would double-message the customer.
        link_auto_reminders: false,
        link_notify: { send_sms: false, send_email: false },
      }),
    });

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // Non-JSON error body; fall through with the raw text.
      }
      throw new Error(`Cashfree link creation failed [${res.status}] linkId=${input.linkId}: ${detail}`);
    }

    const parsed = JSON.parse(text) as { link_url?: string; link_id?: string };
    if (!parsed.link_url) throw new Error(`Cashfree returned no link_url for linkId=${input.linkId}`);
    return { linkUrl: parsed.link_url, linkId: parsed.link_id ?? input.linkId };
  }
}
```

- [ ] **Step 4: Run the Cashfree test**

Run: `npm test -- adapters/cashfree`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing Shopify Admin test**

Create `test/adapters/shopifyAdmin.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ShopifyAdminClient } from '../../src/adapters/shopifyAdmin.js';

function graphqlOk(existingTags = 'vip') {
  return vi.fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { order: { id: 'gid://shopify/Order/55443', tags: existingTags.split(',') } } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } }), { status: 200 }),
    );
}

describe('ShopifyAdminClient', () => {
  it('calls the Admin GraphQL endpoint with the access token', async () => {
    const fetchImpl = graphqlOk();
    await new ShopifyAdminClient({ storeDomain: 'urbnmyth.myshopify.com', adminToken: 'shpat_x', fetchImpl })
      .addTag('55443', 'paid-early');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://urbnmyth.myshopify.com/admin/api/2025-01/graphql.json');
    expect(init.headers['X-Shopify-Access-Token']).toBe('shpat_x');
  });

  it('sends a tagsAdd mutation with the order GID and tag', async () => {
    const fetchImpl = graphqlOk();
    await new ShopifyAdminClient({ storeDomain: 'urbnmyth.myshopify.com', adminToken: 'shpat_x', fetchImpl })
      .addTag('55443', 'paid-early');

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.query).toContain('tagsAdd');
    expect(body.variables).toEqual({ id: 'gid://shopify/Order/55443', tags: ['paid-early'] });
  });

  it('throws when Shopify returns userErrors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [{ message: 'Order not found' }] } } }), { status: 200 }),
    );
    await expect(
      new ShopifyAdminClient({ storeDomain: 'd', adminToken: 't', fetchImpl }).addTag('1', 'paid-early'),
    ).rejects.toThrow(/Order not found/);
  });

  it('throws on a non-2xx response without leaking the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    await expect(
      new ShopifyAdminClient({ storeDomain: 'd', adminToken: 'shpat_supersecret', fetchImpl }).addTag('1', 'paid-early'),
    ).rejects.toThrow(/^(?!.*shpat_supersecret).*$/s);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npm test -- adapters/shopifyAdmin`
Expected: FAIL — `Cannot find module '../../src/adapters/shopifyAdmin.js'`

- [ ] **Step 7: Implement `src/adapters/shopifyAdmin.ts`**

```ts
const API_VERSION = '2025-01';

const TAGS_ADD = `
  mutation addTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export interface OrderTagger {
  addTag(orderId: string, tag: string): Promise<void>;
}

export class ShopifyAdminClient implements OrderTagger {
  private readonly storeDomain: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { storeDomain: string; adminToken: string; fetchImpl?: typeof fetch }) {
    this.storeDomain = opts.storeDomain;
    this.adminToken = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async addTag(orderId: string, tag: string): Promise<void> {
    const res = await this.fetchImpl(
      `https://${this.storeDomain}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': this.adminToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: TAGS_ADD,
          variables: { id: `gid://shopify/Order/${orderId}`, tags: [tag] },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`Shopify tagsAdd failed [${res.status}] orderId=${orderId}`);
    }

    const parsed = (await res.json()) as {
      data?: { tagsAdd?: { userErrors?: Array<{ message?: string }> } };
      errors?: Array<{ message?: string }>;
    };

    const errors = [
      ...(parsed.errors ?? []),
      ...(parsed.data?.tagsAdd?.userErrors ?? []),
    ].map((e) => e.message ?? 'unknown error');

    if (errors.length > 0) {
      throw new Error(`Shopify tagsAdd rejected orderId=${orderId}: ${errors.join('; ')}`);
    }
  }
}
```

- [ ] **Step 8: Run both adapter tests**

Run: `npm test -- adapters`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/cashfree.ts src/adapters/shopifyAdmin.ts test/adapters/cashfree.test.ts test/adapters/shopifyAdmin.test.ts
git commit -m "feat: add Cashfree payment link and Shopify order tagging adapters"
```

---

## Task 11: Order intake service and the Shopify webhook route

**Files:**
- Create: `src/services/orderIntake.ts`, `src/routes/shopify.ts`
- Create: `test/fakes/stubClients.ts`
- Modify: `src/server.ts`, `src/index.ts`
- Test: `test/services/orderIntake.test.ts`, `test/routes/shopify.test.ts`

**Interfaces:**
- Consumes: `parseShopifyOrder`, `computePricing`, `SheetStore`, `WhatsAppClient`, `verifyShopifyHmac`
- Produces:
  - `type IntakeResult = 'processed' | 'duplicate' | 'skipped_no_phone'`
  - `class OrderIntakeService` with `handle(payload: unknown): Promise<IntakeResult>`
  - `createShopifyRouter(deps: { intake: OrderIntakeService; webhookSecret: string }): express.Router`
  - `interface StubWhatsAppClient`, `StubPaymentLinkClient`, `StubOrderTagger` in `test/fakes/stubClients.ts`

- [ ] **Step 1: Create the stub clients**

Create `test/fakes/stubClients.ts`:

```ts
import type { SendTemplateInput, WhatsAppClient } from '../../src/adapters/whatsapp.js';
import type { CreateLinkInput, PaymentLinkClient } from '../../src/adapters/cashfree.js';
import type { OrderTagger } from '../../src/adapters/shopifyAdmin.js';

export class StubWhatsAppClient implements WhatsAppClient {
  sent: SendTemplateInput[] = [];
  failWith: Error | null = null;
  private counter = 0;

  async sendTemplate(input: SendTemplateInput): Promise<{ wamid: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    this.counter += 1;
    return { wamid: `wamid.STUB${this.counter}` };
  }

  get lastTemplate(): string | undefined {
    return this.sent.at(-1)?.template;
  }
}

export class StubPaymentLinkClient implements PaymentLinkClient {
  created: CreateLinkInput[] = [];
  failWith: Error | null = null;

  async createLink(input: CreateLinkInput): Promise<{ linkUrl: string; linkId: string }> {
    if (this.failWith) throw this.failWith;
    this.created.push(input);
    return { linkUrl: `https://cf.test/links/${input.linkId}`, linkId: input.linkId };
  }
}

export class StubOrderTagger implements OrderTagger {
  tagged: Array<{ orderId: string; tag: string }> = [];
  failWith: Error | null = null;

  async addTag(orderId: string, tag: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.tagged.push({ orderId, tag });
  }
}
```

- [ ] **Step 2: Write the failing service test**

Create `test/services/orderIntake.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { OrderIntakeService } from '../../src/services/orderIntake.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient } from '../fakes/stubClients.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';

const NOW = new Date('2026-08-16T10:00:00.000Z');

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const service = new OrderIntakeService({
    store,
    whatsapp,
    codFeeInr: 50,
    codGatewayNames: ['cash on delivery', 'cod'],
    templateLang: 'en',
    now: () => NOW,
  });
  return { store, whatsapp, service };
}

describe('OrderIntakeService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });

  it('writes a PENDING order row with waived-fee pricing', async () => {
    const result = await ctx.service.handle(shopifyOrderPayload());
    expect(result).toBe('processed');

    const row = await ctx.store.findOrderByNo('#1042');
    expect(row).toMatchObject({
      orderNo: '#1042', orderId: '5544332211', phone: '919876543210',
      amount: 1899, codFee: 50, payable: 1849, isCod: true,
      confirmStatus: 'PENDING', paymentLink: '',
      createdAt: NOW.toISOString(), confirmedAt: '', paidAt: '',
    });
  });

  it('sends order_confirm_cod for a COD order with the right body params', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    expect(ctx.whatsapp.sent).toHaveLength(1);
    expect(ctx.whatsapp.sent[0]).toMatchObject({
      to: '919876543210',
      template: 'order_confirm_cod',
      languageCode: 'en',
      bodyParams: ['Aarav', '#1042', 'Oversized Tee — Black x2, Cargo Pants — Olive x1', '1899'],
    });
  });

  it('sends order_confirm_prepaid for a prepaid order and charges no fee', async () => {
    await ctx.service.handle(shopifyOrderPayload({
      payment_gateway_names: ['Razorpay Secure'], financial_status: 'paid',
    }));
    expect(ctx.whatsapp.lastTemplate).toBe('order_confirm_prepaid');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row).toMatchObject({ isCod: false, codFee: 0, payable: 1899 });
  });

  it('logs the send to the messages tab', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    expect(ctx.store.messages[0]).toEqual({
      orderNo: '#1042', template: 'order_confirm_cod', wamid: 'wamid.STUB1',
      direction: 'out', status: 'sent', timestamp: NOW.toISOString(),
    });
  });

  it('ignores a duplicate webhook — one row, one message', async () => {
    await ctx.service.handle(shopifyOrderPayload());
    const second = await ctx.service.handle(shopifyOrderPayload());

    expect(second).toBe('duplicate');
    expect(await ctx.store.listOrders()).toHaveLength(1);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('skips an order with no usable phone but still records it', async () => {
    const result = await ctx.service.handle(shopifyOrderPayload({
      shipping_address: { phone: '12345' },
      customer: { first_name: 'Aarav', phone: null },
      billing_address: { phone: null },
    }));

    expect(result).toBe('skipped_no_phone');
    expect(ctx.whatsapp.sent).toHaveLength(0);
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.phone).toBe('');
    expect(row?.confirmStatus).toBe('NO_RESPONSE');
  });

  it('records the event before sending, so a send failure is not retried into a double-send', async () => {
    ctx.whatsapp.failWith = new Error('Meta 500');
    await expect(ctx.service.handle(shopifyOrderPayload())).rejects.toThrow('Meta 500');
    expect(await ctx.store.hasEvent('shopify', '5544332211')).toBe(true);
    expect(await ctx.store.listOrders()).toHaveLength(1);
  });

  it('propagates a parse failure so the route can answer 500', async () => {
    await expect(ctx.service.handle({ name: '#1042' })).rejects.toThrow(/id/);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- orderIntake`
Expected: FAIL — `Cannot find module '../../src/services/orderIntake.js'`

- [ ] **Step 4: Implement `src/services/orderIntake.ts`**

Note the ordering in `handle`: the event is recorded and the row written *before* the message is sent. If the send throws, the route returns 500 and the sender retries — and the retry is caught by the dedupe check, so the customer never gets two messages. Losing one message is recoverable; double-messaging a customer is not.

```ts
import { computePricing } from '../core/incentive.js';
import { parseShopifyOrder } from '../core/shopifyOrder.js';
import type { OrderRow, SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import { log } from '../logger.js';

export type IntakeResult = 'processed' | 'duplicate' | 'skipped_no_phone';

export interface OrderIntakeDeps {
  store: SheetStore;
  whatsapp: WhatsAppClient;
  codFeeInr: number;
  codGatewayNames: string[];
  templateLang: string;
  now?: () => Date;
}

export const TEMPLATE_COD = 'order_confirm_cod';
export const TEMPLATE_PREPAID = 'order_confirm_prepaid';

export class OrderIntakeService {
  private readonly now: () => Date;

  constructor(private readonly deps: OrderIntakeDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async handle(payload: unknown): Promise<IntakeResult> {
    const { store, whatsapp, codFeeInr, codGatewayNames, templateLang } = this.deps;

    const parsed = parseShopifyOrder(payload, codGatewayNames);

    if (await store.hasEvent('shopify', parsed.orderId)) {
      log('info', 'shopify webhook ignored as duplicate', { order_no: parsed.orderNo });
      return 'duplicate';
    }
    await store.recordEvent('shopify', parsed.orderId);

    const pricing = computePricing(parsed.amount, parsed.isCod, codFeeInr);
    const timestamp = this.now().toISOString();
    const hasPhone = parsed.phone !== null;

    const row: OrderRow = {
      orderNo: parsed.orderNo,
      orderId: parsed.orderId,
      customerName: parsed.customerName,
      phone: parsed.phone ?? '',
      amount: parsed.amount,
      codFee: pricing.codFee,
      payable: pricing.payable,
      isCod: parsed.isCod,
      // No phone means no message can ever arrive, so the order starts terminal.
      confirmStatus: hasPhone ? 'PENDING' : 'NO_RESPONSE',
      paymentLink: '',
      createdAt: timestamp,
      confirmedAt: '',
      paidAt: '',
    };
    await store.appendOrder(row);

    if (!hasPhone) {
      log('warn', 'order has no usable phone, no message sent', { order_no: parsed.orderNo });
      return 'skipped_no_phone';
    }

    const template = parsed.isCod ? TEMPLATE_COD : TEMPLATE_PREPAID;
    const { wamid } = await whatsapp.sendTemplate({
      to: row.phone,
      template,
      languageCode: templateLang,
      bodyParams: [
        parsed.customerName,
        parsed.orderNo,
        parsed.itemsSummary,
        String(parsed.amount),
      ],
    });

    await store.appendMessage({
      orderNo: parsed.orderNo,
      template,
      wamid,
      direction: 'out',
      status: 'sent',
      timestamp,
    });

    log('info', 'order confirmation sent', { order_no: parsed.orderNo, template });
    return 'processed';
  }
}
```

- [ ] **Step 5: Run the service test**

Run: `npm test -- orderIntake`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write the failing route test**

Create `test/routes/shopify.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { OrderIntakeService } from '../../src/services/orderIntake.js';
import { createShopifyRouter } from '../../src/routes/shopify.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient } from '../fakes/stubClients.js';
import { shopifyOrderPayload } from '../fixtures/shopifyOrder.js';

const SECRET = 'shop-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
}

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const intake = new OrderIntakeService({
    store, whatsapp, codFeeInr: 50,
    codGatewayNames: ['cash on delivery', 'cod'], templateLang: 'en',
  });
  const app = createApp({ routers: [createShopifyRouter({ intake, webhookSecret: SECRET })] });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, whatsapp, server, url: `http://127.0.0.1:${port}/webhook/shopify` };
}

describe('POST /webhook/shopify', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });
  afterEach(() => { ctx.server.close(); });

  async function post(body: string, signature: string | null) {
    return fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Shopify-Hmac-Sha256': signature } : {}),
      },
      body,
    });
  }

  it('accepts a correctly signed order and sends a message', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('rejects a bad signature with 401 and sends nothing', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    const res = await post(body, 'not-a-signature');
    expect(res.status).toBe(401);
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('rejects a missing signature with 401', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    expect((await post(body, null)).status).toBe(401);
  });

  it('rejects a signature computed over different bytes', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    const res = await post(body, sign(JSON.stringify(shopifyOrderPayload({ total_price: '1.00' }))));
    expect(res.status).toBe(401);
  });

  it('returns 200 and sends once when the same webhook is delivered twice', async () => {
    const body = JSON.stringify(shopifyOrderPayload());
    await post(body, sign(body));
    const second = await post(body, sign(body));
    expect(second.status).toBe(200);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('returns 500 when the send fails, so Shopify retries', async () => {
    ctx.whatsapp.failWith = new Error('Meta down');
    const body = JSON.stringify(shopifyOrderPayload());
    expect((await post(body, sign(body))).status).toBe(500);
  });

  it('returns 200 for an order with no usable phone', async () => {
    const body = JSON.stringify(shopifyOrderPayload({
      shipping_address: { phone: null }, customer: { first_name: 'A', phone: null }, billing_address: { phone: null },
    }));
    expect((await post(body, sign(body))).status).toBe(200);
  });
});
```


- [ ] **Step 7: Run it to confirm it fails**

Run: `npm test -- routes/shopify`
Expected: FAIL — `Cannot find module '../../src/routes/shopify.js'`

- [ ] **Step 8: Implement `src/routes/shopify.ts`**

```ts
import { Router } from 'express';
import { verifyShopifyHmac } from '../core/signatures.js';
import type { OrderIntakeService } from '../services/orderIntake.js';
import { log } from '../logger.js';

export function createShopifyRouter(deps: {
  intake: OrderIntakeService;
  webhookSecret: string;
}): Router {
  const router = Router();

  router.post('/webhook/shopify', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('X-Shopify-Hmac-Sha256');

    if (!verifyShopifyHmac(rawBody, signature, deps.webhookSecret)) {
      log('warn', 'shopify webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    try {
      const result = await deps.intake.handle(req.body);
      res.status(200).json({ result });
    } catch (error) {
      log('error', 'shopify webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
```

- [ ] **Step 9: Update `src/server.ts` to accept routers**

Replace the `AppDeps` interface and the `createApp` body:

```ts
import express from 'express';
import type { Request, Response, Router } from 'express';

export interface AppDeps {
  routers?: Router[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.use(
    express.json({
      limit: '2mb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  for (const router of deps.routers ?? []) app.use(router);

  return app;
}
```

- [ ] **Step 10: Wire the real dependencies in `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { createApp } from './server.js';
import { createSheetsApi, GoogleSheetStore } from './adapters/googleSheetStore.js';
import { GraphWhatsAppClient } from './adapters/whatsapp.js';
import { OrderIntakeService } from './services/orderIntake.js';
import { createShopifyRouter } from './routes/shopify.js';

const config = loadConfig(process.env);

const store = new GoogleSheetStore(await createSheetsApi(), config.sheetId);
const whatsapp = new GraphWhatsAppClient({
  accessToken: config.metaAccessToken,
  phoneNumberId: config.metaPhoneNumberId,
});

const intake = new OrderIntakeService({
  store,
  whatsapp,
  codFeeInr: config.codFeeInr,
  codGatewayNames: config.codGatewayNames,
  templateLang: config.templateLang,
});

const app = createApp({
  routers: [
    createShopifyRouter({ intake, webhookSecret: config.shopifyWebhookSecret }),
  ],
});

app.listen(config.port, () => {
  log('info', 'hub started', { port: config.port });
});
```

- [ ] **Step 11: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/services/orderIntake.ts src/routes/shopify.ts src/server.ts src/index.ts test/
git commit -m "feat: handle Shopify order webhooks and send confirmation templates"
```

---

## Task 12: Confirmation service and the Meta webhook routes

**Files:**
- Create: `src/services/confirmation.ts`, `src/routes/meta.ts`
- Modify: `src/index.ts`
- Test: `test/services/confirmation.test.ts`, `test/routes/meta.test.ts`

**Interfaces:**
- Consumes: `MetaEvent`, `matchesConfirm`, `matchesCancel`, `SheetStore`, `WhatsAppClient`, `PaymentLinkClient`, `verifyMetaSignature`
- Produces:
  - `type ConfirmResult = 'confirmed' | 'cancelled' | 'duplicate' | 'no_match' | 'status_logged' | 'ignored'`
  - `class ConfirmationService` with `handleEvent(event: MetaEvent): Promise<ConfirmResult>`
  - `createMetaRouter(deps: { confirmation: ConfirmationService; appSecret: string; verifyToken: string }): express.Router`
  - `TEMPLATE_PAY_LINK = 'pay_early_link'`

- [ ] **Step 1: Write the failing service test**

Create `test/services/confirmation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfirmationService } from '../../src/services/confirmation.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient, StubPaymentLinkClient } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';
import type { MetaEvent } from '../../src/core/metaWebhook.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
    amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'PENDING',
    paymentLink: '', createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '', paidAt: '',
    ...overrides,
  };
}

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const payments = new StubPaymentLinkClient();
  const service = new ConfirmationService({
    store, whatsapp, payments, templateLang: 'en', linkExpiryHours: 24, now: () => NOW,
  });
  return { store, whatsapp, payments, service };
}

const confirmEvent: MetaEvent = {
  kind: 'button', messageId: 'wamid.IN1', from: '919876543210', buttonText: 'I Confirm',
};

describe('ConfirmationService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order());
  });

  it('flips the order to CONFIRMED and stamps confirmedAt', async () => {
    expect(await ctx.service.handleEvent(confirmEvent)).toBe('confirmed');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.confirmStatus).toBe('CONFIRMED');
    expect(row?.confirmedAt).toBe(NOW.toISOString());
  });

  it('creates a payment link for the stored payable, not a recomputed amount', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.payments.created[0]).toMatchObject({
      amount: 1849,
      customerName: 'Aarav',
      customerPhone: '919876543210',
      purpose: 'Order #1042',
      expiryHours: 24,
    });
  });

  it('uses a deterministic link id derived from the order number', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.payments.created[0]?.linkId).toBe('urbnmyth-1042');
  });

  it('stores the payment link on the order row', async () => {
    await ctx.service.handleEvent(confirmEvent);
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.paymentLink).toBe('https://cf.test/links/urbnmyth-1042');
  });

  it('sends pay_early_link with amount and savings, and the link id as button suffix', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.whatsapp.sent[0]).toMatchObject({
      to: '919876543210',
      template: 'pay_early_link',
      languageCode: 'en',
      bodyParams: ['Aarav', '1849', '50'],
      urlButtonSuffix: 'urbnmyth-1042',
    });
  });

  it('logs the inbound tap and the outbound link to the messages tab', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(ctx.store.messages).toEqual([
      { orderNo: '#1042', template: 'button:I Confirm', wamid: 'wamid.IN1', direction: 'in', status: 'received', timestamp: NOW.toISOString() },
      { orderNo: '#1042', template: 'pay_early_link', wamid: 'wamid.STUB1', direction: 'out', status: 'sent', timestamp: NOW.toISOString() },
    ]);
  });

  it('ignores a duplicate delivery of the same message id', async () => {
    await ctx.service.handleEvent(confirmEvent);
    expect(await ctx.service.handleEvent(confirmEvent)).toBe('duplicate');
    expect(ctx.payments.created).toHaveLength(1);
    expect(ctx.whatsapp.sent).toHaveLength(1);
  });

  it('does not downgrade an order that is already PAID_EARLY', async () => {
    await ctx.store.updateOrder('#1042', { confirmStatus: 'PAID_EARLY' });
    const late: MetaEvent = { ...confirmEvent, messageId: 'wamid.LATE' };
    expect(await ctx.service.handleEvent(late)).toBe('no_match');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PAID_EARLY');
    expect(ctx.payments.created).toHaveLength(0);
  });

  it('does not throw when the phone matches no pending order', async () => {
    const unknown: MetaEvent = { ...confirmEvent, messageId: 'wamid.UNK', from: '919000000000' };
    expect(await ctx.service.handleEvent(unknown)).toBe('no_match');
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('handles Cancel Order by marking CANCELLED with no payment link', async () => {
    const cancel: MetaEvent = { ...confirmEvent, messageId: 'wamid.CAN', buttonText: 'Cancel Order' };
    expect(await ctx.service.handleEvent(cancel)).toBe('cancelled');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CANCELLED');
    expect(ctx.payments.created).toHaveLength(0);
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('records delivery statuses against the message log', async () => {
    await ctx.store.appendMessage({
      orderNo: '#1042', template: 'order_confirm_cod', wamid: 'wamid.OUT1',
      direction: 'out', status: 'sent', timestamp: '2026-08-16T10:00:00.000Z',
    });
    const status: MetaEvent = { kind: 'status', wamid: 'wamid.OUT1', status: 'delivered' };
    expect(await ctx.service.handleEvent(status)).toBe('status_logged');
    expect(ctx.store.messages[0]?.status).toBe('delivered');
  });

  it('ignores plain text messages', async () => {
    const text: MetaEvent = { kind: 'text', messageId: 'wamid.TXT', from: '919876543210', text: 'where is my order' };
    expect(await ctx.service.handleEvent(text)).toBe('ignored');
    expect(ctx.whatsapp.sent).toHaveLength(0);
  });

  it('ignores an unrecognised button label', async () => {
    const other: MetaEvent = { ...confirmEvent, messageId: 'wamid.OTH', buttonText: 'Track Order' };
    expect(await ctx.service.handleEvent(other)).toBe('ignored');
  });

  it('leaves the order CONFIRMED when link creation fails, so a retry can finish the job', async () => {
    ctx.payments.failWith = new Error('Cashfree 503');
    await expect(ctx.service.handleEvent(confirmEvent)).rejects.toThrow('Cashfree 503');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- services/confirmation`
Expected: FAIL — `Cannot find module '../../src/services/confirmation.js'`

- [ ] **Step 3: Implement `src/services/confirmation.ts`**

Two details worth understanding before you write this:

The Cashfree link id is derived from the order number (`#1042` → `urbnmyth-1042`) rather than generated randomly. Cashfree rejects a duplicate `link_id`, which gives a second layer of protection against creating two links for one order.

The payment amount comes from `row.payable`, written at intake. The customer was quoted that number in the confirmation message; recomputing it here would let a config change produce a link that contradicts what they were told.

```ts
import { matchesCancel, matchesConfirm, type MetaEvent } from '../core/metaWebhook.js';
import type { SheetStore } from '../adapters/sheets.js';
import type { WhatsAppClient } from '../adapters/whatsapp.js';
import type { PaymentLinkClient } from '../adapters/cashfree.js';
import { log } from '../logger.js';

export type ConfirmResult =
  | 'confirmed' | 'cancelled' | 'duplicate' | 'no_match' | 'status_logged' | 'ignored';

export const TEMPLATE_PAY_LINK = 'pay_early_link';

export interface ConfirmationDeps {
  store: SheetStore;
  whatsapp: WhatsAppClient;
  payments: PaymentLinkClient;
  templateLang: string;
  linkExpiryHours: number;
  now?: () => Date;
}

/** '#1042' -> 'urbnmyth-1042'. Deterministic, so Cashfree rejects a duplicate link. */
export function paymentLinkId(orderNo: string): string {
  return `urbnmyth-${orderNo.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export class ConfirmationService {
  private readonly now: () => Date;

  constructor(private readonly deps: ConfirmationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async handleEvent(event: MetaEvent): Promise<ConfirmResult> {
    const { store } = this.deps;

    if (event.kind === 'status') {
      await store.updateMessageStatus(event.wamid, event.status);
      return 'status_logged';
    }

    if (await store.hasEvent('meta', event.messageId)) {
      return 'duplicate';
    }
    await store.recordEvent('meta', event.messageId);

    if (event.kind === 'text') {
      log('info', 'inbound text message ignored', { from: event.from });
      return 'ignored';
    }

    const isConfirm = matchesConfirm(event.buttonText);
    const isCancel = matchesCancel(event.buttonText);
    if (!isConfirm && !isCancel) {
      log('info', 'unrecognised button ignored', { button: event.buttonText });
      return 'ignored';
    }

    const order = await store.findLatestPendingByPhone(event.from);
    if (!order) {
      log('warn', 'button reply matched no pending order', { from: event.from });
      return 'no_match';
    }

    const timestamp = this.now().toISOString();

    await store.appendMessage({
      orderNo: order.orderNo,
      template: `button:${event.buttonText}`,
      wamid: event.messageId,
      direction: 'in',
      status: 'received',
      timestamp,
    });

    if (isCancel) {
      await store.updateOrder(order.orderNo, { confirmStatus: 'CANCELLED' });
      log('info', 'order cancelled by customer', { order_no: order.orderNo });
      return 'cancelled';
    }

    await store.updateOrder(order.orderNo, {
      confirmStatus: 'CONFIRMED',
      confirmedAt: timestamp,
    });

    const linkId = paymentLinkId(order.orderNo);
    const link = await this.deps.payments.createLink({
      linkId,
      amount: order.payable,
      customerName: order.customerName,
      customerPhone: order.phone,
      purpose: `Order ${order.orderNo}`,
      expiryHours: this.deps.linkExpiryHours,
    });

    await store.updateOrder(order.orderNo, { paymentLink: link.linkUrl });

    const { wamid } = await this.deps.whatsapp.sendTemplate({
      to: order.phone,
      template: TEMPLATE_PAY_LINK,
      languageCode: this.deps.templateLang,
      bodyParams: [order.customerName, String(order.payable), String(order.codFee)],
      urlButtonSuffix: link.linkId,
    });

    await store.appendMessage({
      orderNo: order.orderNo,
      template: TEMPLATE_PAY_LINK,
      wamid,
      direction: 'out',
      status: 'sent',
      timestamp,
    });

    log('info', 'order confirmed and payment link sent', {
      order_no: order.orderNo, payable: order.payable,
    });
    return 'confirmed';
  }
}
```

- [ ] **Step 4: Run the service test**

Run: `npm test -- services/confirmation`
Expected: PASS, 14 tests.

- [ ] **Step 5: Write the failing route test**

Create `test/routes/meta.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createMetaRouter } from '../../src/routes/meta.js';
import { ConfirmationService } from '../../src/services/confirmation.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubWhatsAppClient, StubPaymentLinkClient } from '../fakes/stubClients.js';

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'my-verify-token';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex')}`;
}

function build() {
  const store = new InMemorySheetStore();
  const whatsapp = new StubWhatsAppClient();
  const payments = new StubPaymentLinkClient();
  const confirmation = new ConfirmationService({
    store, whatsapp, payments, templateLang: 'en', linkExpiryHours: 24,
  });
  const app = createApp({
    routers: [createMetaRouter({ confirmation, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN })],
  });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, whatsapp, payments, server, base: `http://127.0.0.1:${port}/webhook/meta` };
}

function buttonPayload(from = '919876543210', messageId = 'wamid.IN1') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'w1',
      changes: [{
        field: 'messages',
        value: { messages: [{ id: messageId, from, type: 'button', button: { text: 'I Confirm' } }] },
      }],
    }],
  };
}

describe('GET /webhook/meta', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });
  afterEach(() => { ctx.server.close(); });

  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await fetch(
      `${ctx.base}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('returns 403 for a wrong verify token', async () => {
    const res = await fetch(`${ctx.base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const res = await fetch(`${ctx.base}?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`);
    expect(res.status).toBe(403);
  });
});

describe('POST /webhook/meta', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder({
      orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
      amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'PENDING',
      paymentLink: '', createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '', paidAt: '',
    });
  });
  afterEach(() => { ctx.server.close(); });

  async function post(body: string, signature: string | null) {
    return fetch(ctx.base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
      },
      body,
    });
  }

  it('processes a signed button reply', async () => {
    const body = JSON.stringify(buttonPayload());
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
    expect(ctx.payments.created).toHaveLength(1);
  });

  it('rejects a bad signature with 401 and changes nothing', async () => {
    const body = JSON.stringify(buttonPayload());
    expect((await post(body, 'sha256=deadbeef')).status).toBe(401);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PENDING');
  });

  it('rejects a missing signature with 401', async () => {
    const body = JSON.stringify(buttonPayload());
    expect((await post(body, null)).status).toBe(401);
  });

  it('returns 200 for a payload with no recognisable events', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect((await post(body, sign(body))).status).toBe(200);
  });

  it('returns 200 and acts once when the same event is delivered twice', async () => {
    const body = JSON.stringify(buttonPayload());
    await post(body, sign(body));
    expect((await post(body, sign(body))).status).toBe(200);
    expect(ctx.payments.created).toHaveLength(1);
  });

  it('returns 500 when link creation fails, so Meta retries', async () => {
    ctx.payments.failWith = new Error('Cashfree down');
    const body = JSON.stringify(buttonPayload());
    expect((await post(body, sign(body))).status).toBe(500);
  });

  it('processes every event in a multi-event payload', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'w1',
        changes: [{
          field: 'messages',
          value: {
            messages: [{ id: 'wamid.IN1', from: '919876543210', type: 'button', button: { text: 'I Confirm' } }],
            statuses: [{ id: 'wamid.OUT1', status: 'delivered' }],
          },
        }],
      }],
    };
    const body = JSON.stringify(payload);
    expect((await post(body, sign(body))).status).toBe(200);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npm test -- routes/meta`
Expected: FAIL — `Cannot find module '../../src/routes/meta.js'`

- [ ] **Step 7: Implement `src/routes/meta.ts`**

```ts
import { Router } from 'express';
import { verifyMetaSignature } from '../core/signatures.js';
import { parseMetaWebhook } from '../core/metaWebhook.js';
import type { ConfirmationService } from '../services/confirmation.js';
import { log } from '../logger.js';

export function createMetaRouter(deps: {
  confirmation: ConfirmationService;
  appSecret: string;
  verifyToken: string;
}): Router {
  const router = Router();

  router.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === deps.verifyToken && typeof challenge === 'string') {
      log('info', 'meta webhook verified');
      res.status(200).send(challenge);
      return;
    }

    log('warn', 'meta webhook verification rejected');
    res.sendStatus(403);
  });

  router.post('/webhook/meta', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('X-Hub-Signature-256');

    if (!verifyMetaSignature(rawBody, signature, deps.appSecret)) {
      log('warn', 'meta webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    try {
      const events = parseMetaWebhook(req.body);
      for (const event of events) {
        await deps.confirmation.handleEvent(event);
      }
      res.status(200).json({ handled: events.length });
    } catch (error) {
      log('error', 'meta webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
```

- [ ] **Step 8: Wire it into `src/index.ts`**

Add these imports and the service, then add the router to the `createApp` array:

```ts
import { CashfreeClient } from './adapters/cashfree.js';
import { ConfirmationService } from './services/confirmation.js';
import { createMetaRouter } from './routes/meta.js';

const payments = new CashfreeClient({
  appId: config.cashfreeAppId,
  secretKey: config.cashfreeSecretKey,
  env: config.cashfreeEnv,
});

const confirmation = new ConfirmationService({
  store,
  whatsapp,
  payments,
  templateLang: config.templateLang,
  linkExpiryHours: 24,
});
```

The `createApp` call becomes:

```ts
const app = createApp({
  routers: [
    createShopifyRouter({ intake, webhookSecret: config.shopifyWebhookSecret }),
    createMetaRouter({
      confirmation,
      appSecret: config.metaAppSecret,
      verifyToken: config.metaVerifyToken,
    }),
  ],
});
```

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/services/confirmation.ts src/routes/meta.ts src/index.ts test/
git commit -m "feat: confirm orders from button replies and send payment links"
```

---

## Task 13: Payment service and the Cashfree webhook route

**Files:**
- Create: `src/services/payment.ts`, `src/routes/cashfree.ts`
- Modify: `src/index.ts`
- Test: `test/services/payment.test.ts`, `test/routes/cashfree.test.ts`

**Interfaces:**
- Consumes: `SheetStore`, `OrderTagger`, `verifyCashfreeSignature`, `paymentLinkId` from Task 12
- Produces:
  - `type PaymentResult = 'paid' | 'duplicate' | 'no_match' | 'ignored'`
  - `class PaymentService` with `handle(payload: unknown): Promise<PaymentResult>`
  - `createCashfreeRouter(deps: { payment: PaymentService; secretKey: string }): express.Router`
  - `PAID_EARLY_TAG = 'paid-early'`

- [ ] **Step 1: Write the failing service test**

Create `test/services/payment.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PaymentService } from '../../src/services/payment.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubOrderTagger } from '../fakes/stubClients.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const NOW = new Date('2026-08-16T13:00:00.000Z');

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
    amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'CONFIRMED',
    paymentLink: 'https://cf.test/links/urbnmyth-1042',
    createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '2026-08-16T12:00:00.000Z', paidAt: '',
    ...overrides,
  };
}

function successPayload(linkId = 'urbnmyth-1042') {
  return {
    type: 'PAYMENT_LINK_EVENT',
    data: {
      link_id: linkId,
      link_status: 'PAID',
      link_amount_paid: 1849,
      order: { order_id: 'cf-order-99' },
    },
  };
}

function build() {
  const store = new InMemorySheetStore();
  const tagger = new StubOrderTagger();
  const service = new PaymentService({ store, tagger, now: () => NOW });
  return { store, tagger, service };
}

describe('PaymentService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order());
  });

  it('marks the order PAID_EARLY and stamps paidAt', async () => {
    expect(await ctx.service.handle(successPayload())).toBe('paid');
    const row = await ctx.store.findOrderByNo('#1042');
    expect(row?.confirmStatus).toBe('PAID_EARLY');
    expect(row?.paidAt).toBe(NOW.toISOString());
  });

  it('tags the Shopify order paid-early', async () => {
    await ctx.service.handle(successPayload());
    expect(ctx.tagger.tagged).toEqual([{ orderId: '5544332211', tag: 'paid-early' }]);
  });

  it('still marks the order paid when Shopify tagging throws', async () => {
    ctx.tagger.failWith = new Error('Shopify 500');
    expect(await ctx.service.handle(successPayload())).toBe('paid');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PAID_EARLY');
  });

  it('ignores a duplicate webhook for the same link', async () => {
    await ctx.service.handle(successPayload());
    expect(await ctx.service.handle(successPayload())).toBe('duplicate');
    expect(ctx.tagger.tagged).toHaveLength(1);
  });

  it('ignores a non-PAID link status', async () => {
    const pending = { ...successPayload(), data: { ...successPayload().data, link_status: 'PARTIALLY_PAID' } };
    expect(await ctx.service.handle(pending)).toBe('ignored');
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });

  it('ignores a payload with no link id', async () => {
    expect(await ctx.service.handle({ type: 'PAYMENT_LINK_EVENT', data: {} })).toBe('ignored');
  });

  it('returns no_match for a link id with no matching order', async () => {
    expect(await ctx.service.handle(successPayload('urbnmyth-9999'))).toBe('no_match');
  });

  it('does not downgrade an order that is already PAID_EARLY', async () => {
    await ctx.store.updateOrder('#1042', { confirmStatus: 'PAID_EARLY', paidAt: 'earlier' });
    const result = await ctx.service.handle({ ...successPayload(), data: { ...successPayload().data, order: { order_id: 'cf-order-100' } } });
    expect(result).toBe('duplicate');
    expect((await ctx.store.findOrderByNo('#1042'))?.paidAt).toBe('earlier');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- services/payment`
Expected: FAIL — `Cannot find module '../../src/services/payment.js'`

- [ ] **Step 3: Implement `src/services/payment.ts`**

The order is matched by reversing `paymentLinkId()`: the link id was derived from the order number at confirmation time, so the service scans orders for the one whose derived id matches. That avoids storing a second lookup key.

Tagging failure is caught and logged rather than rethrown — the payment already succeeded at Cashfree, and a 500 here would make Cashfree retry a webhook for money that is already collected.

```ts
import { paymentLinkId } from './confirmation.js';
import type { SheetStore } from '../adapters/sheets.js';
import type { OrderTagger } from '../adapters/shopifyAdmin.js';
import { log } from '../logger.js';

export type PaymentResult = 'paid' | 'duplicate' | 'no_match' | 'ignored';

export const PAID_EARLY_TAG = 'paid-early';

export interface PaymentDeps {
  store: SheetStore;
  tagger: OrderTagger;
  now?: () => Date;
}

interface CashfreePayload {
  data?: {
    link_id?: unknown;
    link_status?: unknown;
    order?: { order_id?: unknown } | null;
  } | null;
}

export class PaymentService {
  private readonly now: () => Date;

  constructor(private readonly deps: PaymentDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async handle(payload: unknown): Promise<PaymentResult> {
    const { store, tagger } = this.deps;
    const data = (payload as CashfreePayload)?.data ?? {};

    const linkId = typeof data.link_id === 'string' ? data.link_id : null;
    if (!linkId) {
      log('info', 'cashfree webhook has no link_id, ignored');
      return 'ignored';
    }

    if (data.link_status !== 'PAID') {
      log('info', 'cashfree webhook is not a completed payment, ignored', {
        link_id: linkId, link_status: String(data.link_status),
      });
      return 'ignored';
    }

    const externalId = typeof data.order?.order_id === 'string' ? data.order.order_id : linkId;
    if (await store.hasEvent('cashfree', externalId)) {
      return 'duplicate';
    }
    await store.recordEvent('cashfree', externalId);

    const orders = await store.listOrders();
    const order = orders.find((row) => paymentLinkId(row.orderNo) === linkId);

    if (!order) {
      log('warn', 'cashfree payment matched no order', { link_id: linkId });
      return 'no_match';
    }

    if (order.confirmStatus === 'PAID_EARLY') {
      log('info', 'order already marked paid', { order_no: order.orderNo });
      return 'duplicate';
    }

    await store.updateOrder(order.orderNo, {
      confirmStatus: 'PAID_EARLY',
      paidAt: this.now().toISOString(),
    });

    try {
      await tagger.addTag(order.orderId, PAID_EARLY_TAG);
    } catch (error) {
      // The money is already collected. A 500 here would make Cashfree retry
      // a webhook for a payment that succeeded, so this failure is logged only.
      log('error', 'shopify tagging failed after payment', {
        order_no: order.orderNo,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log('info', 'order paid early', { order_no: order.orderNo, amount: order.payable });
    return 'paid';
  }
}
```

- [ ] **Step 4: Run the service test**

Run: `npm test -- services/payment`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing route test**

Create `test/routes/cashfree.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createCashfreeRouter } from '../../src/routes/cashfree.js';
import { PaymentService } from '../../src/services/payment.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import { StubOrderTagger } from '../fakes/stubClients.js';

const SECRET = 'cf-secret';
const TIMESTAMP = '1755300000';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(TIMESTAMP + body).digest('base64');
}

function build() {
  const store = new InMemorySheetStore();
  const tagger = new StubOrderTagger();
  const payment = new PaymentService({ store, tagger });
  const app = createApp({ routers: [createCashfreeRouter({ payment, secretKey: SECRET })] });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, tagger, server, url: `http://127.0.0.1:${port}/webhook/cashfree` };
}

const payload = JSON.stringify({
  type: 'PAYMENT_LINK_EVENT',
  data: { link_id: 'urbnmyth-1042', link_status: 'PAID', order: { order_id: 'cf-99' } },
});

describe('POST /webhook/cashfree', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder({
      orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
      amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'CONFIRMED',
      paymentLink: 'https://cf.test/links/urbnmyth-1042',
      createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '2026-08-16T12:00:00.000Z', paidAt: '',
    });
  });
  afterEach(() => { ctx.server.close(); });

  async function post(body: string, signature: string | null, timestamp: string | null = TIMESTAMP) {
    return fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'x-webhook-signature': signature } : {}),
        ...(timestamp ? { 'x-webhook-timestamp': timestamp } : {}),
      },
      body,
    });
  }

  it('marks the order paid on a correctly signed webhook', async () => {
    expect((await post(payload, sign(payload))).status).toBe(200);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('PAID_EARLY');
  });

  it('rejects a bad signature with 401 and changes nothing', async () => {
    expect((await post(payload, 'bogus')).status).toBe(401);
    expect((await ctx.store.findOrderByNo('#1042'))?.confirmStatus).toBe('CONFIRMED');
  });

  it('rejects a missing timestamp with 401', async () => {
    expect((await post(payload, sign(payload), null)).status).toBe(401);
  });

  it('returns 200 for a duplicate delivery', async () => {
    await post(payload, sign(payload));
    expect((await post(payload, sign(payload))).status).toBe(200);
    expect(ctx.tagger.tagged).toHaveLength(1);
  });

  it('returns 200 for an unrelated Cashfree event', async () => {
    const other = JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: 'x', link_status: 'EXPIRED' } });
    expect((await post(other, sign(other))).status).toBe(200);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npm test -- routes/cashfree`
Expected: FAIL — `Cannot find module '../../src/routes/cashfree.js'`

- [ ] **Step 7: Implement `src/routes/cashfree.ts`**

```ts
import { Router } from 'express';
import { verifyCashfreeSignature } from '../core/signatures.js';
import type { PaymentService } from '../services/payment.js';
import { log } from '../logger.js';

export function createCashfreeRouter(deps: {
  payment: PaymentService;
  secretKey: string;
}): Router {
  const router = Router();

  router.post('/webhook/cashfree', async (req, res) => {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = req.get('x-webhook-signature');
    const timestamp = req.get('x-webhook-timestamp');

    if (!verifyCashfreeSignature(rawBody, signature, timestamp, deps.secretKey)) {
      log('warn', 'cashfree webhook signature rejected');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    try {
      const result = await deps.payment.handle(req.body);
      res.status(200).json({ result });
    } catch (error) {
      log('error', 'cashfree webhook processing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'processing failed' });
    }
  });

  return router;
}
```

- [ ] **Step 8: Wire it into `src/index.ts`**

Add the imports and service, then add `createCashfreeRouter({ payment, secretKey: config.cashfreeSecretKey })` to the routers array:

```ts
import { ShopifyAdminClient } from './adapters/shopifyAdmin.js';
import { PaymentService } from './services/payment.js';
import { createCashfreeRouter } from './routes/cashfree.js';

const tagger = new ShopifyAdminClient({
  storeDomain: config.shopifyStoreDomain,
  adminToken: config.shopifyAdminToken,
});

const payment = new PaymentService({ store, tagger });
```

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/services/payment.ts src/routes/cashfree.ts src/index.ts test/
git commit -m "feat: mark orders paid early from Cashfree webhooks"
```

---

## Task 14: Dashboard metrics, JSON API, and the dashboard page

**Files:**
- Create: `src/core/metrics.ts`, `src/routes/api.ts`, `src/routes/dashboard.ts`, `src/views/dashboard.ts`
- Modify: `src/index.ts`
- Test: `test/core/metrics.test.ts`, `test/routes/api.test.ts`

**Interfaces:**
- Consumes: `OrderRow`, `SheetStore`
- Produces:
  - `interface Metrics { total: number; codOrders: number; pending: number; confirmed: number; cancelled: number; paidEarly: number; noResponse: number; confirmRate: number; earlyPayRate: number; revenueCollectedEarly: number }`
  - `computeMetrics(orders: OrderRow[]): Metrics`
  - `createApiRouter(deps: { store: SheetStore; dashboardToken: string }): express.Router`
  - `createDashboardRouter(): express.Router`
  - `renderDashboard(): string`

- [ ] **Step 1: Write the failing metrics test**

Create `test/core/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/core/metrics.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1', orderId: '1', customerName: 'A', phone: '919876543210',
    amount: 1000, codFee: 50, payable: 950, isCod: true, confirmStatus: 'PENDING',
    paymentLink: '', createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '', paidAt: '',
    ...overrides,
  };
}

describe('computeMetrics', () => {
  it('returns zeroes for an empty list without dividing by zero', () => {
    expect(computeMetrics([])).toEqual({
      total: 0, codOrders: 0, pending: 0, confirmed: 0, cancelled: 0,
      paidEarly: 0, noResponse: 0, confirmRate: 0, earlyPayRate: 0,
      revenueCollectedEarly: 0,
    });
  });

  it('counts each status', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'PENDING' }),
      order({ orderNo: '#2', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#3', confirmStatus: 'PAID_EARLY' }),
      order({ orderNo: '#4', confirmStatus: 'CANCELLED' }),
      order({ orderNo: '#5', confirmStatus: 'NO_RESPONSE' }),
    ]);
    expect(metrics).toMatchObject({
      total: 5, pending: 1, confirmed: 1, paidEarly: 1, cancelled: 1, noResponse: 1,
    });
  });

  it('treats PAID_EARLY as also confirmed when computing confirm rate', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#2', confirmStatus: 'PAID_EARLY' }),
      order({ orderNo: '#3', confirmStatus: 'PENDING' }),
      order({ orderNo: '#4', confirmStatus: 'PENDING' }),
    ]);
    expect(metrics.confirmRate).toBe(50);
  });

  it('computes early-pay rate against confirmed orders, not all orders', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#2', confirmStatus: 'PAID_EARLY' }),
      order({ orderNo: '#3', confirmStatus: 'PENDING' }),
    ]);
    // 1 paid out of 2 confirmed
    expect(metrics.earlyPayRate).toBe(50);
  });

  it('sums payable across paid-early orders only', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'PAID_EARLY', payable: 950 }),
      order({ orderNo: '#2', confirmStatus: 'PAID_EARLY', payable: 1500 }),
      order({ orderNo: '#3', confirmStatus: 'CONFIRMED', payable: 800 }),
    ]);
    expect(metrics.revenueCollectedEarly).toBe(2450);
  });

  it('counts COD orders separately from prepaid', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', isCod: true }),
      order({ orderNo: '#2', isCod: false }),
      order({ orderNo: '#3', isCod: true }),
    ]);
    expect(metrics.codOrders).toBe(2);
  });

  it('rounds rates to one decimal place', () => {
    const metrics = computeMetrics([
      order({ orderNo: '#1', confirmStatus: 'CONFIRMED' }),
      order({ orderNo: '#2', confirmStatus: 'PENDING' }),
      order({ orderNo: '#3', confirmStatus: 'PENDING' }),
    ]);
    expect(metrics.confirmRate).toBe(33.3);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- metrics`
Expected: FAIL — `Cannot find module '../../src/core/metrics.js'`

- [ ] **Step 3: Implement `src/core/metrics.ts`**

```ts
import type { OrderRow } from '../adapters/sheets.js';

export interface Metrics {
  total: number;
  codOrders: number;
  pending: number;
  confirmed: number;
  cancelled: number;
  paidEarly: number;
  noResponse: number;
  /** Share of all orders that reached CONFIRMED or beyond, as a percentage. */
  confirmRate: number;
  /** Share of confirmed orders that were paid early, as a percentage. */
  earlyPayRate: number;
  revenueCollectedEarly: number;
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function computeMetrics(orders: OrderRow[]): Metrics {
  const count = (status: OrderRow['confirmStatus']) =>
    orders.filter((row) => row.confirmStatus === status).length;

  const paidEarly = count('PAID_EARLY');
  const confirmed = count('CONFIRMED');
  // A paid order was necessarily confirmed first.
  const reachedConfirmed = confirmed + paidEarly;

  return {
    total: orders.length,
    codOrders: orders.filter((row) => row.isCod).length,
    pending: count('PENDING'),
    confirmed,
    cancelled: count('CANCELLED'),
    paidEarly,
    noResponse: count('NO_RESPONSE'),
    confirmRate: pct(reachedConfirmed, orders.length),
    earlyPayRate: pct(paidEarly, reachedConfirmed),
    revenueCollectedEarly: orders
      .filter((row) => row.confirmStatus === 'PAID_EARLY')
      .reduce((sum, row) => sum + row.payable, 0),
  };
}
```

- [ ] **Step 4: Run the metrics test**

Run: `npm test -- metrics`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing API test**

Create `test/routes/api.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server.js';
import { createApiRouter } from '../../src/routes/api.js';
import { InMemorySheetStore } from '../fakes/inMemorySheetStore.js';
import type { OrderRow } from '../../src/adapters/sheets.js';

const TOKEN = 'dash-token';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderNo: '#1042', orderId: '5544332211', customerName: 'Aarav', phone: '919876543210',
    amount: 1899, codFee: 50, payable: 1849, isCod: true, confirmStatus: 'PENDING',
    paymentLink: '', createdAt: '2026-08-16T10:00:00.000Z', confirmedAt: '', paidAt: '',
    ...overrides,
  };
}

function build() {
  const store = new InMemorySheetStore();
  const app = createApp({ routers: [createApiRouter({ store, dashboardToken: TOKEN })] });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { store, server, url: `http://127.0.0.1:${port}/api/orders` };
}

describe('GET /api/orders', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.store.appendOrder(order());
    await ctx.store.appendOrder(order({ orderNo: '#1043', confirmStatus: 'PAID_EARLY', createdAt: '2026-08-16T11:00:00.000Z' }));
  });
  afterEach(() => { ctx.server.close(); });

  it('returns orders and metrics with a valid bearer token', async () => {
    const res = await fetch(ctx.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(2);
    expect(body.metrics.total).toBe(2);
    expect(body.metrics.paidEarly).toBe(1);
  });

  it('returns the newest order first', async () => {
    const res = await fetch(ctx.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json();
    expect(body.orders[0].orderNo).toBe('#1043');
  });

  it('accepts the token as a query parameter', async () => {
    expect((await fetch(`${ctx.url}?token=${TOKEN}`)).status).toBe(200);
  });

  it('rejects a missing token with 401', async () => {
    expect((await fetch(ctx.url)).status).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    expect((await fetch(ctx.url, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('never exposes the customer phone in full', async () => {
    const res = await fetch(ctx.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json();
    expect(body.orders[0].phone).toBe('9198****3210');
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npm test -- routes/api`
Expected: FAIL — `Cannot find module '../../src/routes/api.js'`

- [ ] **Step 7: Implement `src/routes/api.ts`**

Phone numbers are masked in the API response. The dashboard needs to identify an order, not to dial it, and the page is reachable by anyone holding the token.

```ts
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { computeMetrics } from '../core/metrics.js';
import type { SheetStore } from '../adapters/sheets.js';

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** '919876543210' -> '9198****3210' */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}

export function createApiRouter(deps: { store: SheetStore; dashboardToken: string }): Router {
  const router = Router();

  router.get('/api/orders', async (req, res) => {
    const header = req.get('Authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;

    if (!tokenMatches(bearer ?? queryToken, deps.dashboardToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const orders = await deps.store.listOrders();
    const sorted = [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({
      orders: sorted.map((row) => ({ ...row, phone: maskPhone(row.phone) })),
      metrics: computeMetrics(orders),
    });
  });

  return router;
}
```

- [ ] **Step 8: Run the API test**

Run: `npm test -- routes/api`
Expected: PASS, 6 tests.

- [ ] **Step 9: Implement `src/views/dashboard.ts`**

No client build step, no framework, no external requests. The page reads the token from the URL, keeps it in `sessionStorage`, and polls the API every 60 seconds.

```ts
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>URBNMYTH — Orders & Confirmations</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --card:#171a21; --fg:#e8eaed; --muted:#9aa0a6; --line:#262b35; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .tile .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.04em; }
  .tile .value { font-size:26px; font-weight:600; margin-top:4px; font-variant-numeric:tabular-nums; }
  .wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  table { border-collapse:collapse; width:100%; min-width:760px; }
  th,td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.04em; }
  tbody tr:last-child td { border-bottom:none; }
  .chip { display:inline-block; padding:2px 9px; border-radius:99px; font-size:12px; font-weight:500; }
  .PENDING { background:#3a2f10; color:#f2c94c; }
  .CONFIRMED { background:#10303a; color:#4cc9f0; }
  .PAID_EARLY { background:#10331d; color:#4ade80; }
  .CANCELLED { background:#3a1414; color:#f87171; }
  .NO_RESPONSE { background:#26262b; color:#9aa0a6; }
  .num { font-variant-numeric:tabular-nums; }
  .err { background:#3a1414; color:#f87171; padding:12px 16px; border-radius:10px; }
</style>
</head>
<body>
<h1>Orders &amp; Confirmations</h1>
<div class="sub" id="updated">Loading…</div>
<div id="error"></div>
<div class="tiles" id="tiles"></div>
<div class="wrap"><table>
  <thead><tr>
    <th>Order</th><th>Customer</th><th>Phone</th><th>Amount</th>
    <th>Payable</th><th>Type</th><th>Status</th><th>Created</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<script>
const params = new URLSearchParams(location.search);
const urlToken = params.get('token');
if (urlToken) { sessionStorage.setItem('dashToken', urlToken); history.replaceState({}, '', location.pathname); }
const token = sessionStorage.getItem('dashToken') || '';

const rupees = (n) => '\\u20b9' + Number(n || 0).toLocaleString('en-IN');
const when = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' }) : '—';

function tile(label, value) {
  return '<div class="tile"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

async function load() {
  try {
    const res = await fetch('/api/orders', { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) {
      document.getElementById('error').innerHTML =
        '<div class="err">Unauthorized. Open this page as /dashboard?token=YOUR_DASHBOARD_TOKEN</div>';
      document.getElementById('updated').textContent = '';
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { orders, metrics } = await res.json();
    document.getElementById('error').innerHTML = '';

    document.getElementById('tiles').innerHTML = [
      tile('Orders', metrics.total),
      tile('COD orders', metrics.codOrders),
      tile('Confirm rate', metrics.confirmRate + '%'),
      tile('Early-pay rate', metrics.earlyPayRate + '%'),
      tile('Collected early', rupees(metrics.revenueCollectedEarly)),
      tile('Awaiting reply', metrics.pending),
    ].join('');

    document.getElementById('rows').innerHTML = orders.map((o) =>
      '<tr>' +
      '<td>' + o.orderNo + '</td>' +
      '<td>' + o.customerName + '</td>' +
      '<td class="num">' + o.phone + '</td>' +
      '<td class="num">' + rupees(o.amount) + '</td>' +
      '<td class="num">' + rupees(o.payable) + '</td>' +
      '<td>' + (o.isCod ? 'COD' : 'Prepaid') + '</td>' +
      '<td><span class="chip ' + o.confirmStatus + '">' + o.confirmStatus.replace('_', ' ') + '</span></td>' +
      '<td>' + when(o.createdAt) + '</td>' +
      '</tr>').join('') || '<tr><td colspan="8">No orders yet.</td></tr>';

    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN');
  } catch (err) {
    document.getElementById('error').innerHTML = '<div class="err">' + err.message + '</div>';
  }
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}
```

- [ ] **Step 10: Implement `src/routes/dashboard.ts`**

```ts
import { Router } from 'express';
import { renderDashboard } from '../views/dashboard.js';

export function createDashboardRouter(): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    res.type('html').send(renderDashboard());
  });

  return router;
}
```

- [ ] **Step 11: Wire both routers into `src/index.ts`**

Add to the imports and to the routers array:

```ts
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';
```

```ts
createApiRouter({ store, dashboardToken: config.dashboardToken }),
createDashboardRouter(),
```

- [ ] **Step 12: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 13: Commit**

```bash
git add src/core/metrics.ts src/routes/api.ts src/routes/dashboard.ts src/views/dashboard.ts src/index.ts test/
git commit -m "feat: add confirmation dashboard with metrics API"
```

---

## Task 15: Operator scripts, template copy, deployment, and README

**Files:**
- Create: `scripts/send-hello.ts`, `scripts/fake-order.ts`, `docs/templates.md`, `deploy.sh`, `README.md`

**Interfaces:**
- Consumes: `GraphWhatsAppClient`, `loadConfig`
- Produces: no importable code — these are operator tools and documentation.

These are run by hand against live services, so they are not covered by the test suite. Every module they import is already tested.

- [ ] **Step 1: Write `scripts/send-hello.ts`**

```ts
/**
 * Phase 0 exit test. Sends the pre-approved `hello_world` template to a phone number,
 * proving the access token, phone number id, and Meta account all work.
 *
 * Usage: npm run send:hello -- 919876543210
 */
import { loadConfig } from '../src/config.js';
import { GraphWhatsAppClient } from '../src/adapters/whatsapp.js';

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run send:hello -- 919876543210');
  process.exit(1);
}

const config = loadConfig(process.env);
const client = new GraphWhatsAppClient({
  accessToken: config.metaAccessToken,
  phoneNumberId: config.metaPhoneNumberId,
});

const { wamid } = await client.sendTemplate({
  to,
  template: 'hello_world',
  languageCode: 'en_US',
  bodyParams: [],
});

console.log(`Sent. wamid=${wamid}`);
console.log('Check the phone. If nothing arrives within a minute, check WhatsApp Manager > Insights.');
```

- [ ] **Step 2: Write `scripts/fake-order.ts`**

```ts
/**
 * Posts a correctly signed fake Shopify order webhook at a running hub.
 * Use this to exercise the full Phase 1 path without placing a real order.
 *
 * Usage: npm run send:fake-order -- http://localhost:8080 919876543210
 */
import { createHmac } from 'node:crypto';

const hubUrl = process.argv[2];
const phone = process.argv[3];
const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

if (!hubUrl || !phone || !secret) {
  console.error('Usage: npm run send:fake-order -- http://localhost:8080 919876543210');
  console.error('SHOPIFY_WEBHOOK_SECRET must be set in the environment.');
  process.exit(1);
}

const orderNumber = Math.floor(1000 + Math.random() * 9000);

const payload = {
  id: Date.now(),
  name: `#TEST${orderNumber}`,
  total_price: '1899.00',
  financial_status: 'pending',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  customer: { first_name: 'Test', last_name: 'Buyer', phone: null },
  shipping_address: { phone, first_name: 'Test' },
  billing_address: { phone: null },
  line_items: [
    { title: 'Oversized Tee — Black', quantity: 2 },
    { title: 'Cargo Pants — Olive', quantity: 1 },
  ],
};

const body = JSON.stringify(payload);
const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');

const res = await fetch(`${hubUrl}/webhook/shopify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': signature },
  body,
});

console.log(`${res.status} ${await res.text()}`);
console.log(`Order ${payload.name} — check WhatsApp on ${phone} and the dashboard.`);
```

- [ ] **Step 3: Verify the scripts typecheck**

`tsconfig.json` already includes `scripts/**/*.ts` from Task 1, so no config change is needed.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Write `docs/templates.md`**

```markdown
# WhatsApp Templates — Phase 1

Create these in WhatsApp Manager → Account tools → Message templates.
All three are **Utility** category. Language: **English** (code `en`) — this must match
`TEMPLATE_LANG` in the environment.

Variable order below matches `bodyParams` in the code exactly. Changing the order in
Meta without changing the code will send the wrong values into the wrong slots.

---

## 1. `order_confirm_cod`

**Category:** Utility
**Buttons:** two Quick Reply buttons — `I Confirm` and `Cancel Order` (exact labels; the
code matches on them, case-insensitively, ignoring emoji and punctuation)

**Body:**

```
Hi {{1}}, thanks for ordering from URBNMYTH.

Order {{2}}
{{3}}
Total: ₹{{4}} (Cash on Delivery)

Please confirm so we can pack and ship it today.
```

**Variables:** `{{1}}` customer first name · `{{2}}` order number · `{{3}}` items summary · `{{4}}` order total

**Sample values for Meta's review form:** `Aarav`, `#1042`, `Oversized Tee — Black x2, Cargo Pants — Olive x1`, `1899`

---

## 2. `order_confirm_prepaid`

**Category:** Utility
**Buttons:** none

**Body:**

```
Hi {{1}}, your URBNMYTH order is confirmed.

Order {{2}}
{{3}}
Paid: ₹{{4}}

We're packing it now and will share tracking as soon as it ships.
```

**Variables:** identical to `order_confirm_cod` — same four, same order.

**Sample values:** `Aarav`, `#1042`, `Oversized Tee — Black x2, Cargo Pants — Olive x1`, `1899`

---

## 3. `pay_early_link`

**Category:** Utility
**Buttons:** one **URL button**, label `Pay Now`, type **Dynamic**
Base URL: `https://payments.cashfree.com/links/{{1}}`
(In sandbox, use `https://payments-test.cashfree.com/links/{{1}}`.)
The code passes the Cashfree `link_id` as the dynamic suffix.

**Body:**

```
Great, {{1}} — your order is confirmed.

Pay ₹{{2}} online now and we'll waive the ₹{{3}} cash-on-delivery charge.
The link is valid for 24 hours. Prefer COD? Just ignore this, nothing changes.
```

**Variables:** `{{1}}` customer first name · `{{2}}` payable amount · `{{3}}` COD fee waived

**Sample values:** `Aarav`, `1849`, `50`

---

## Notes on approval

- Write sentence case. ALL CAPS and excessive punctuation draw rejections.
- The URL button's base URL must be a real, reachable domain.
- Approval is usually minutes, occasionally up to 24 hours. A rejection tells you which
  policy was hit — fix and resubmit rather than creating a new template name.
- After approval, confirm the template name is spelled exactly as above. A mismatch
  surfaces as Meta error code 132001 in the hub logs.
```

- [ ] **Step 5: Write `deploy.sh`**

```bash
#!/usr/bin/env bash
# Deploys the hub to Cloud Run. Run this yourself — it creates billable resources.
#
#   PROJECT_ID=my-project SA_EMAIL=hub@my-project.iam.gserviceaccount.com ./deploy.sh
#
# Secrets are read from Secret Manager, never baked into the image.
set -euo pipefail

SERVICE="${SERVICE:-urbnmyth-hub}"
REGION="${REGION:-asia-south1}"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
SA_EMAIL="${SA_EMAIL:?set SA_EMAIL (the service account shared with the CRM Sheet)}"

echo "Deploying ${SERVICE} to ${REGION} in ${PROJECT_ID}…"

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --service-account "${SA_EMAIL}" \
  --set-env-vars "SHOPIFY_STORE_DOMAIN=${SHOPIFY_STORE_DOMAIN:?},CASHFREE_ENV=${CASHFREE_ENV:-TEST},COD_FEE_INR=${COD_FEE_INR:-50},TEMPLATE_LANG=${TEMPLATE_LANG:-en},COD_GATEWAY_NAMES=${COD_GATEWAY_NAMES:-cash on delivery,cod}" \
  --set-secrets "META_ACCESS_TOKEN=meta-access-token:latest,META_PHONE_NUMBER_ID=meta-phone-number-id:latest,META_WABA_ID=meta-waba-id:latest,META_VERIFY_TOKEN=meta-verify-token:latest,META_APP_SECRET=meta-app-secret:latest,SHOPIFY_WEBHOOK_SECRET=shopify-webhook-secret:latest,SHOPIFY_ADMIN_TOKEN=shopify-admin-token:latest,CASHFREE_APP_ID=cashfree-app-id:latest,CASHFREE_SECRET_KEY=cashfree-secret-key:latest,SHEET_ID=sheet-id:latest,DASHBOARD_TOKEN=dashboard-token:latest"

URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"

cat <<EOF

Deployed: ${URL}

Paste these into the matching consoles:
  Meta      → ${URL}/webhook/meta      (verify token = META_VERIFY_TOKEN)
  Shopify   → ${URL}/webhook/shopify   (Order creation, JSON)
  Cashfree  → ${URL}/webhook/cashfree  (Payment Link events)
  Dashboard → ${URL}/dashboard?token=YOUR_DASHBOARD_TOKEN
EOF
```

Then: `chmod +x deploy.sh`

- [ ] **Step 6: Write `README.md`**

```markdown
# URBNMYTH Hub — Phase 0 + Phase 1

WhatsApp automation for Shopify orders: order confirmation with an "I Confirm" button,
an early-payment link that waives the ₹50 COD fee, and a dashboard over the whole pipeline.

## Run locally

```bash
npm install
cp .env.example .env      # fill it in
npm test                  # everything is faked; no network needed
npm run dev
```

Dashboard: `http://localhost:8080/dashboard?token=$DASHBOARD_TOKEN`

## Test without a real order

```bash
npm run send:hello -- 919876543210                       # Phase 0 exit test
npm run send:fake-order -- http://localhost:8080 919876543210
```

For end-to-end webhook testing against a local hub, expose it with any tunnel
(`gcloud run deploy` is simpler for anything beyond a smoke test).

## Deploy

```bash
PROJECT_ID=… SA_EMAIL=… SHOPIFY_STORE_DOMAIN=… ./deploy.sh
```

## Endpoints

| Path | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /webhook/meta` | Meta webhook verification |
| `POST /webhook/meta` | inbound messages, button taps, delivery statuses |
| `POST /webhook/shopify` | order creation |
| `POST /webhook/cashfree` | payment link events |
| `GET /api/orders` | JSON orders + metrics (token required) |
| `GET /dashboard` | the dashboard page |

## Architecture

`routes/` → `services/` → `core/` + `adapters/`, dependencies pointing one way only.
`core/` is pure and exhaustively tested. Adapters are interfaces with in-memory fakes,
so the test suite never touches the network.

See `docs/superpowers/specs/` for the design and `docs/templates.md` for the WhatsApp
template copy to paste into WhatsApp Manager.
```

- [ ] **Step 7: Run the whole suite one final time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass, no type errors, `dist/` produced.

- [ ] **Step 8: Commit**

```bash
chmod +x deploy.sh
git add scripts/ docs/templates.md deploy.sh README.md
git commit -m "feat: add operator scripts, template copy, deploy script, and README"
```

---

## Operator checklist (outside the code)

Run through this after Task 15. None of it can be automated from here.

**Phase 0**
- [ ] Business verification submitted on Meta (slowest step — start first)
- [ ] Dedicated phone number registered on the API, not in use by the WhatsApp Business app
- [ ] Permanent system-user token generated with `whatsapp_business_messaging` + `whatsapp_business_management`
- [ ] Payment method attached in WhatsApp Manager
- [ ] GCP: Cloud Run API, Cloud Build API, Google Sheets API enabled
- [ ] Service account created; `URBNMYTH-CRM` Sheet shared with it as Editor
- [ ] Sheet has three tabs — `orders`, `messages`, `events` — with the header rows from the spec
- [ ] Secrets loaded into Secret Manager with the names `deploy.sh` expects
- [ ] `./deploy.sh` run; hub URL recorded
- [ ] `npm run send:hello` delivered a message to a real phone

**Phase 1**
- [ ] All three templates from `docs/templates.md` submitted and approved
- [ ] Shopify `Order creation` webhook pointed at `/webhook/shopify`, secret in Secret Manager
- [ ] Cashfree Payment Links API enabled; webhook pointed at `/webhook/cashfree`
- [ ] Cashfree auto-reminders switched OFF (the hub owns reminders)
- [ ] Phone number set to required at Shopify checkout
- [ ] Meta webhook subscribed to the `messages` field
- [ ] Real COD test order placed end to end; all four Phase 1 exit criteria met
