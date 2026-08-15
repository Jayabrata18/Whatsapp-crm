import express from 'express';
import type { Request, Response, Router } from 'express';

export interface AppDeps {
  routers?: Router[];
}

declare global {
  namespace Express {
    interface Request {
      /**
       * The exact bytes of the request body, stashed before JSON parsing.
       * Shopify, Meta, and Cashfree all sign the raw bytes — re-serializing
       * the parsed object produces different bytes and a failed signature check.
       */
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
