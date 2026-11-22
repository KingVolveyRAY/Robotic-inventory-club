import { once } from 'node:events';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { configuredAdmin } from './auth.js';

const demo = process.argv.includes('--demo');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.ROBOLAB_HOST ?? '127.0.0.1';
const proxyHops = Number(process.env.ROBOLAB_PROXY_HOPS ?? 0);

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT harus di antara 1 dan 65535.');
  if (!Number.isInteger(proxyHops) || proxyHops < 0) throw new Error('ROBOLAB_PROXY_HOPS harus bilangan bulat nonnegatif.');

  const databasePath = resolve(demo
    ? process.env.ROBOLAB_DEMO_DATABASE_PATH || '.data/demo.sqlite'
    : process.env.ROBOLAB_DATABASE_PATH || '.data/robolab.sqlite');

  const { app, close } = await createApp({
    databasePath, databaseUrl: demo ? undefined : process.env.DATABASE_URL, demo, proxyHops,
    sampleInventory: process.env.ROBOLAB_SAMPLE_INVENTORY === '1',
    admin: demo ? undefined : configuredAdmin(process.env),
    secureCookies: process.env.ROBOLAB_SECURE_COOKIES === '1',
  });

  const server = app.listen(port, host);
  try {
    await once(server, 'listening');
  } catch (error) {
    await close();
    throw error;
  }
  console.log(`RoboLab (${demo ? 'demo' : 'inventaris klub'}) berjalan di http://${host}:${port}`);

  function shutdown() {
    server.close(() => close().catch((error) => {
      console.error('Gagal menutup database:', error.name);
      process.exitCode = 1;
    }));
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error('Gagal menjalankan RoboLab:', error.message);
  process.exitCode = 1;
}
