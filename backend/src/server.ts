import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import { gradescopeRouter } from './routes/gradescope.js';
import { coursesRouter } from './routes/courses.js';
import { analysesRouter } from './routes/analyses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CROPS_DIR = path.resolve(__dirname, '../data/gs-crops');

const PORT = Number(process.env.PORT ?? 3001);
const DFLASH_BASE = process.env.DFLASH_BASE_URL ?? 'http://127.0.0.1:8000/v1';
console.log(
  `[regrader] LLM endpoint: ${DFLASH_BASE} (model: ${process.env.DFLASH_MODEL ?? 'mlx-community/Qwen3.5-9B-MLX-4bit'})`,
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/crops', express.static(CROPS_DIR));
app.use('/api/gradescope', gradescopeRouter);
app.use('/api', coursesRouter);
app.use('/api', analysesRouter);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[regrader] error:', err);
    res.status(500).json({ error: err.message });
  },
);

app.listen(PORT, () => {
  console.log(`[regrader] backend listening on http://localhost:${PORT}`);
});
