import express from 'express';
import { createApp } from './src/app.js';
import { configuredAdmin } from './src/auth.js';

const gateway = express();
gateway.disable('x-powered-by');
let startup;

async function start() {
  const databaseUrl = process.env.DATABASE_URL;
  const catalogOnly = process.env.ROBOLAB_PUBLIC_CATALOG === '1';
  if (catalogOnly) return createApp({ databasePath: ':memory:', sampleInventory: true, catalogOnly });
  if (!databaseUrl) throw new Error('DATABASE_URL is required on Vercel.');

  return createApp({
    databaseUrl,
    secureCookies: true,
    proxyHops: 1,
    sampleInventory: process.env.ROBOLAB_SAMPLE_INVENTORY === '1',
    admin: configuredAdmin(process.env),
  });
}

gateway.use(async (req, res, next) => {
  startup ??= start().catch((error) => {
    startup = undefined;
    throw error;
  });
  const { app } = await startup;
  app(req, res, next);
});

gateway.use((error, _req, res, next) => {
  console.error('RoboLab gagal menginisialisasi layanan.', error.code ?? error.name);
  if (res.headersSent) return next(error);
  res.set('Cache-Control', 'no-store').status(503).type('text').send('RoboLab belum bisa terhubung ke database. Coba lagi nanti.');
});

export default gateway;
