import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export function openSqlite(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  } catch (error) {
    database.close();
    throw error;
  }

  const prepared = new Map();
  const connection = {
    query(sql, parameters = []) {
      if (!prepared.has(sql)) prepared.set(sql, database.prepare(sql));
      return prepared.get(sql).all(...parameters);
    },
    script: (sql) => database.exec(sql),
  };

  let pending = Promise.resolve();
  function enqueue(operation) {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  }

  return {
    dialect: 'sqlite',
    query: (...args) => enqueue(() => connection.query(...args)),
    close: () => enqueue(() => database.close()),
    transaction: (work) => enqueue(async () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(connection);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }),
  };
}

export function openPostgres(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL harus menggunakan protokol PostgreSQL.');
  }
  url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({
    connectionString: url.href,
    max: 3,
    connectionTimeoutMillis: 8000,
    enableChannelBinding: true,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  pool.on('error', (error) => console.error('Koneksi PostgreSQL idle terputus.', error.code ?? error.name));

  function query(client, sql, parameters = []) {
    let index = 0;
    const statement = sql.replace(/\?/g, () => '$' + ++index);
    return client.query(statement, parameters).then((result) => result.rows);
  }

  return {
    dialect: 'postgres',
    query: (...args) => query(pool, ...args),
    close: () => pool.end(),
    async transaction(work) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        // A club inventory is small. Serialize the read-and-write operations across Vercel instances.
        await client.query('SELECT pg_advisory_xact_lock(762311, 1)');
        const result = await work({
          query: (...args) => query(client, ...args),
          script: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
  };
}
