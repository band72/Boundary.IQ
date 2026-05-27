// ─── Health Route ────────────────────────────────────────────────────────────
import { Router } from 'express';
const router = Router();

router.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Boundary.IQ API', version: '2.0.0-node', utc: new Date().toISOString() });
});

export default router;
