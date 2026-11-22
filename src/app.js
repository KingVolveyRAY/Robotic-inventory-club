import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { checkCsrf, createSessions, hashPassword, matchesPassword, validPassword } from './auth.js';
import { openInventory } from './database.js';
import {
  AppError, asText, categories, categoryById, clubDate, formatDate, historyStatuses,
  MAX_ADVANCE_DAYS, MAX_LOAN_DAYS, memberTabs, normalizeEmail, recordId, shiftDate,
  staffTabs, statuses, validEmail, validateEquipment, validateLoan,
} from './domain.js';
import { catalogData, icon, initials, sorts } from './presentation.js';
import { demoAccounts, prepareData } from './seed.js';

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const publicPath = file('../public');
const fonts = new Map([
  ['plus-jakarta-sans', file('../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2')],
  ['space-grotesk', file('../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2')],
]);

const feedback = new Map([
  ['diajukan', 'Pengajuan terkirim. Kamu bisa memantau statusnya di sini.'],
  ['cancelled', 'Peminjaman dibatalkan.'],
  ['approved', 'Pengajuan disetujui. Stok sudah dipesan untuk anggota.'],
  ['declined', 'Pengajuan ditolak.'],
  ['borrowed', 'Pengambilan alat tercatat.'],
  ['returned', 'Pengembalian tercatat dan stok tersedia kembali.'],
  ['disimpan', 'Data alat berhasil disimpan.'],
]);

function safeNext(value) {
  if (value === '/peminjaman' || (typeof value === 'string' && /^\/alat\/[1-9]\d{0,9}$/.test(value))) {
    return value;
  }
  return '';
}

function requireUser(req, res, next) {
  if (!res.locals.user) {
    return res.redirect(303, '/masuk?lanjut=' + encodeURIComponent(safeNext(req.path) || '/peminjaman'));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user) return res.redirect(303, '/masuk');
  if (res.locals.user.role !== 'admin') {
    throw new AppError(403, 'Halaman ini khusus untuk pengurus klub.');
  }
  next();
}

function filterValue(query, tabs) {
  return tabs.some((tab) => tab.id === query) ? query : tabs[0].id;
}

function formValues(body, keys) {
  return Object.fromEntries(keys.map((key) => [key, asText(body[key]).slice(0, 500)]));
}

export async function createApp({ databasePath, demo = false, admin, secureCookies = false, proxyHops = 0 }) {
  const inventory = openInventory(databasePath);
  try {
    await prepareData(inventory, { demo, admin });
  } catch (error) {
    inventory.close();
    throw error;
  }

  const sessions = createSessions(inventory, secureCookies);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', proxyHops);
  app.set('views', file('../views'));
  app.set('view engine', 'ejs');

  Object.assign(app.locals, {
    icon, initials, categories, categoryById, statuses, sorts, demo, demoAccounts,
    formatDate, maxLoanDays: MAX_LOAN_DAYS, maxAdvanceDays: MAX_ADVANCE_DAYS,
    user: null, page: '',
  });

  app.use(helmet({
    strictTransportSecurity: secureCookies,
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'"],
        'font-src': ["'self'"],
        'style-src': ["'self'"],
        'upgrade-insecure-requests': null,
      },
    },
  }));
  app.use(express.static(publicPath, { index: false, maxAge: '1h' }));
  app.get('/font/:name.woff2', (req, res, next) => {
    const path = fonts.get(req.params.name);
    if (!path) return next();
    res.sendFile(path, { maxAge: '7d' });
  });
  app.get('/healthz', (_req, res) => {
    inventory.ready();
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    req.session = sessions.read(req);
    const user = req.session?.user_id
      ? { id: req.session.user_id, name: req.session.name, role: req.session.role }
      : null;
    Object.assign(res.locals, {
      user,
      csrf: req.session?.csrf_token,
      today: clubDate(),
      page: '',
      notice: feedback.get(req.query.hasil),
      error: '',
    });
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 24 }));
  app.post(/.*/, (req, _res, next) => {
    if (!checkCsrf(req.session, req.body?._csrf)) {
      throw new AppError(403, 'Sesi formulir sudah berakhir. Muat ulang halaman, lalu coba lagi.');
    }
    next();
  });

  function showAuth(req, res, view, values, error = '', status = 200) {
    if (!req.session) res.locals.csrf = sessions.start(res, null);
    const nextPath = safeNext(values.lanjut);
    const suffix = nextPath ? '?lanjut=' + encodeURIComponent(nextPath) : '';
    res.status(status).render(view, {
      name: asText(values.name).slice(0, 80),
      email: normalizeEmail(values.email).slice(0, 254),
      nextPath, suffix, error,
    });
  }

  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: Boolean(proxyHops) },
    handler: (_req, _res, next) => next(new AppError(429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.')),
  });

  app.get('/', (req, res) => {
    res.render('catalog', { ...catalogData(inventory.catalog(), req.query), page: 'catalog' });
  });

  app.get('/panduan', (_req, res) => res.render('guide', { page: 'guide' }));

  app.get('/masuk', (req, res) => {
    if (res.locals.user) return res.redirect(safeNext(req.query.lanjut) || (res.locals.user.role === 'admin' ? '/admin' : '/peminjaman'));
    showAuth(req, res, 'login', req.query);
  });

  app.post('/masuk', authLimit, async (req, res) => {
    if (res.locals.user) return res.redirect(303, '/peminjaman');
    const email = normalizeEmail(req.body.email);
    const account = validEmail(email) ? inventory.userByEmail(email) : undefined;
    const matches = await matchesPassword(req.body.password, account?.password_hash);
    if (!account || !matches) {
      return showAuth(req, res, 'login', req.body, 'Email atau kata sandi salah.', 401);
    }
    sessions.start(res, req.session, account.id);
    res.redirect(303, safeNext(req.body.lanjut) || (account.role === 'admin' ? '/admin' : '/peminjaman'));
  });

  app.get('/daftar', (req, res) => {
    if (res.locals.user) return res.redirect(safeNext(req.query.lanjut) || '/peminjaman');
    showAuth(req, res, 'register', req.query);
  });

  app.post('/daftar', authLimit, async (req, res) => {
    if (res.locals.user) return res.redirect(303, '/peminjaman');
    const name = asText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (name.length < 2 || name.length > 80 || !validEmail(email) || !validPassword(password, 10)) {
      return showAuth(req, res, 'register', req.body, 'Periksa nama, alamat email, dan panjang kata sandi.', 422);
    }
    const passwordHash = await hashPassword(password);
    const userId = inventory.transaction(() => {
      if (inventory.userByEmail(email)) return null;
      return inventory.createUser(name, email, passwordHash, 'member');
    });
    if (!userId) return showAuth(req, res, 'register', req.body, 'Email sudah terdaftar. Silakan masuk.', 409);

    sessions.start(res, req.session, userId);
    res.redirect(303, safeNext(req.body.lanjut) || '/peminjaman');
  });

  app.post('/keluar', (req, res) => {
    sessions.end(res, req.session);
    res.redirect(303, '/');
  });

  function publicEquipment(id) {
    const item = inventory.equipment(id);
    if (!item.active) throw new AppError(404, 'Alat ini tidak tersedia di katalog.');
    return item;
  }

  function renderDetail(res, item, { values, error, status = 200 } = {}) {
    const today = res.locals.today;
    res.status(status).render('equipment', {
      item,
      page: 'catalog',
      lastStart: shiftDate(today, MAX_ADVANCE_DAYS),
      lastDue: shiftDate(today, MAX_ADVANCE_DAYS + MAX_LOAN_DAYS - 1),
      values: values ?? { quantity: '1', start: today, due: shiftDate(today, 6), purpose: '' },
      error: error ?? '',
    });
  }

  app.get('/alat/:id', (req, res) => renderDetail(res, publicEquipment(recordId(req.params.id))));

  app.post('/alat/:id/pinjam', requireUser, (req, res) => {
    const id = recordId(req.params.id);
    try {
      const form = validateLoan(req.body, res.locals.today);
      inventory.requestLoan(id, res.locals.user.id, form);
      res.redirect(303, '/peminjaman?hasil=diajukan');
    } catch (error) {
      if (!(error instanceof AppError) || error.status === 404) throw error;
      renderDetail(res, publicEquipment(id), {
        values: formValues(req.body, ['quantity', 'start', 'due', 'purpose']),
        error: error.message,
        status: error.status,
      });
    }
  });

  app.get('/peminjaman', requireUser, (req, res) => {
    const allLoans = inventory.memberLoans(res.locals.user.id);
    const filter = filterValue(req.query.status, memberTabs);
    const loans = allLoans.filter((loan) => filter === 'all' ||
      (filter === 'history') === historyStatuses.has(loan.status));
    res.render('loans', { page: 'loans', loans, filter, tabs: memberTabs });
  });

  app.post('/peminjaman/:id/batal', requireUser, (req, res) => {
    inventory.cancelLoan(recordId(req.params.id), res.locals.user.id);
    res.redirect(303, '/peminjaman?hasil=cancelled');
  });

  app.get('/admin', requireAdmin, (req, res) => {
    const filter = filterValue(req.query.status, staffTabs);
    const allLoans = inventory.adminLoans();
    const counts = Object.fromEntries(staffTabs.map(({ id }) => [
      id, allLoans.filter((loan) => id === 'history' ? historyStatuses.has(loan.status) : loan.status === id).length,
    ]));
    const loans = allLoans.filter((loan) => filter === 'history' ? historyStatuses.has(loan.status) : loan.status === filter);
    res.render('admin', { page: 'admin', filter, loans, counts, tabs: staffTabs });
  });

  app.post('/admin/peminjaman/:id/tindakan', requireAdmin, (req, res) => {
    const action = asText(req.body.action);
    const result = inventory.advanceLoan(recordId(req.params.id), action, res.locals.today);
    const nextTab = staffTabs.some((tab) => tab.id === result) ? result : 'history';
    res.redirect(303, `/admin?status=${nextTab}&hasil=${result}`);
  });

  app.get('/admin/alat', requireAdmin, (_req, res) => {
    res.render('admin-inventory', { page: 'admin', items: inventory.inventory() });
  });

  function showInventoryForm(res, item, values = item, error = '', status = 200) {
    res.status(status).render('admin-equipment', { page: 'admin', item, values, error });
  }

  app.get('/admin/alat/baru', requireAdmin, (_req, res) => {
    showInventoryForm(res, null, { name: '', category: '', description: '', total: '', active: 1 });
  });

  app.get('/admin/alat/:id', requireAdmin, (req, res) => {
    showInventoryForm(res, inventory.equipment(recordId(req.params.id)));
  });

  app.post(['/admin/alat', '/admin/alat/:id'], requireAdmin, (req, res) => {
    const item = req.params.id ? inventory.equipment(recordId(req.params.id)) : null;
    try {
      const form = validateEquipment(req.body);
      if (item) inventory.updateEquipment(item.id, form);
      else inventory.addEquipment(form);
      res.redirect(303, '/admin/alat?hasil=disimpan');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const values = formValues(req.body, ['name', 'category', 'description', 'total']);
      values.active = req.body.active === '1' ? 1 : 0;
      showInventoryForm(res, item, values, error.message, error.status);
    }
  });

  app.use((_req, _res, next) => next(new AppError(404, 'Halaman yang kamu cari tidak ditemukan.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const generalMessages = {
      400: 'Format permintaan tidak dapat dibaca.',
      404: 'Halaman yang kamu cari tidak ditemukan.',
      413: 'Isian melebihi batas ukuran formulir.',
      500: 'Terjadi kesalahan. Coba lagi beberapa saat.',
    };
    const status = error instanceof AppError ? error.status : Object.hasOwn(generalMessages, error.status) ? error.status : 500;
    const message = error instanceof AppError ? error.message : generalMessages[status];
    if (status === 500) console.error(error);
    const back = req.path.startsWith('/admin') && res.locals.user?.role === 'admin'
      ? { href: '/admin', label: 'Ke panel pengurus' }
      : { href: '/', label: 'Kembali ke katalog' };
    res.status(status).render('error', { status, message, back });
  });

  return { app, close: () => inventory.close() };
}
