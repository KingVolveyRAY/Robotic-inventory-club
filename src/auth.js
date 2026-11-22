import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { parseCookie } from 'cookie';

const deriveKey = promisify(scrypt);
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummyHash = '00'.repeat(16) + ':' + '00'.repeat(64);
const hour = 60 * 60 * 1000;
const sessionHash = (token) => createHash('sha256').update(token).digest('hex');

export function validPassword(password, minLength) {
  return typeof password === 'string' && password.trim().length >= minLength &&
    Buffer.byteLength(password, 'utf8') <= 128;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, scryptOptions);
  return salt.toString('hex') + ':' + key.toString('hex');
}

export async function matchesPassword(password, hash = dummyHash) {
  if (!validPassword(password, 1)) return false;
  const [salt, expected] = hash.split(':');
  const actual = await deriveKey(password, Buffer.from(salt, 'hex'), 64, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function createSessions(inventory, secure) {
  const name = secure ? '__Host-robolab_session' : 'robolab_session';
  const options = { path: '/', httpOnly: true, secure, sameSite: 'lax' };

  async function read(req) {
    const token = parseCookie(req.headers.cookie ?? '')[name];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = sessionHash(token);
    const session = await inventory.findSession(hash, Date.now());
    return session ? { ...session, hash } : null;
  }

  async function start(res, previous, userId = null) {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const now = Date.now();
    const maxAge = userId ? 7 * 24 * hour : hour;
    await inventory.transaction(async (database) => {
      await database.expireSessions(now);
      if (previous) await database.deleteSession(previous.hash);
      await database.storeSession(sessionHash(token), userId, csrf, now + maxAge);
    });
    res.cookie(name, token, { ...options, maxAge });
    return csrf;
  }

  async function end(res, session) {
    if (session) await inventory.deleteSession(session.hash);
    res.clearCookie(name, options);
  }

  return { read, start, end };
}

export function checkCsrf(session, submitted) {
  return Boolean(session && typeof submitted === 'string' && /^[a-f0-9]{64}$/.test(submitted) &&
    timingSafeEqual(Buffer.from(session.csrf_token), Buffer.from(submitted)));
}
