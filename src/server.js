import { once } from 'node:events';
import { resolve } from 'node:path';
import { createApp } from './app.js';

const demo = process.argv.includes('--demo');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.ROBOLAB_HOST ?? '127.0.0.1';
const proxyHops = Number(process.env.ROBOLAB_PROXY_HOPS ?? 0);
const email = process.env.ROBOLAB_ADMIN_EMAIL;
const password = process.env.ROBOLAB_ADMIN_PASSWORD;

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT harus di antara 1 dan 65535.');
  if (!Number.isInteger(proxyHops) || proxyHops < 0) throw new Error('ROBOLAB_PROXY_HOPS harus bilangan bulat nonnegatif.');
  if (!demo && Boolean(email) !== Boolean(password)) {
    throw new Error('Isi ROBOLAB_ADMIN_EMAIL dan ROBOLAB_ADMIN_PASSWORD bersama-sama.');
  }

  const databasePath = resolve(demo
    ? process.env.ROBOLAB_DEMO_DATABASE_PATH || '.data/demo.sqlite'
    : process.env.ROBOLAB_DATABASE_PATH || '.data/robolab.sqlite');

  const { app, close } = await createApp({
    databasePath, demo, proxyHops,
    admin: email && password ? { email, password } : undefined,
    secureCookies: process.env.ROBOLAB_SECURE_COOKIES === '1',
  });

  const server = app.listen(port, host);
  try {
    await once(server, 'listening');
  } catch (error) {
    close();
    throw error;
  }
  console.log(`RoboLab (${demo ? 'demo' : 'inventaris klub'}) berjalan di http://${host}:${port}`);

  function shutdown() {
    server.close(() => close());
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error('Gagal menjalankan RoboLab:', error.message);
  process.exitCode = 1;
}
