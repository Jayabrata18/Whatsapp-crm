import { Router } from 'express';
import { renderDashboard } from '../views/dashboard.js';

export function createDashboardRouter(): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    res.type('html').send(renderDashboard());
  });

  return router;
}
