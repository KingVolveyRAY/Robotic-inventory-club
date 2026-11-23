import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { agendaData, agendaDay, agendaTime, eventKinds, eventVisibility } from './agenda.js';
import { checkCsrf, createSessions, hashPassword, matchesPassword, validPassword } from './auth.js';
import { openInventory } from './database.js';
import {
  ADMIN_USERNAME, AppError, asText, categories, categoryById, clubDate, formatDate, historyStatuses,
  MAX_ADVANCE_DAYS, MAX_LOAN_DAYS, memberTabs, normalizeEmail, recordId, shiftDate,
  staffTabs, statuses, validEmail, validateEquipment, validateLoan,
} from './domain.js';
import { addMissingEquipment, missingEquipment } from './equipment-samples.js';
import { mountLabRoutes, parseProjectPhoto } from './lab-routes.js';
import {
  catalogData, icon, initials, inventoryPageNumber, inventoryPageQuery, inventoryPagination, sorts,
} from './presentation.js';
import { demoAccounts, prepareData } from './seed.js';

const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const publicPath = file('../public');
const motionScripts = new Map([
  ['gsap.min.js', readFileSync(new URL('../node_modules/gsap/dist/gsap.min.js', import.meta.url))],
  ['ScrollTrigger.min.js', readFileSync(new URL('../node_modules/gsap/dist/ScrollTrigger.min.js', import.meta.url))],
  ['motion.js', readFileSync(new URL('../node_modules/motion/dist/motion.js', import.meta.url))],
  ['lenis.min.js', readFileSync(new URL('../node_modules/lenis/dist/lenis.min.js', import.meta.url))],
]);
const feedback = new Map([
  ['diajukan', 'Pengajuan terkirim. Kamu bisa memantau statusnya di sini.'],
  ['cancelled', 'Peminjaman dibatalkan.'],
  ['approved', 'Pengajuan disetujui. Stok sudah dipesan untuk anggota.'],
  ['declined', 'Pengajuan ditolak.'],
  ['borrowed', 'Pengambilan alat tercatat.'],
  ['returned', 'Pengembalian tercatat. Unit yang lolos pemeriksaan kembali tersedia.'],
  ['disimpan', 'Data alat berhasil disimpan.'],
  ['paket-draf', 'Paket alat disimpan sebagai draf. Isi stok dan tampilkan alat yang tersedia.'],
  ['paket-lengkap', 'Semua alat di paket sudah ada di inventaris.'],
  ['kit-disimpan', 'Kit proyek berhasil disimpan.'],
  ['rakitan-terbit', 'Rakitanmu sudah terbit di Galeri Rakitan.'],
  ['rakitan-dihapus', 'Rakitan sudah dihapus dari galeri.'],
  ['servis-selesai', 'Pemeriksaan selesai. Unit kembali ke stok siap dipinjam.'],
  ['kegiatan-disimpan', 'Rencana kegiatan berhasil disimpan.'],
  ['kebutuhan-disimpan', 'Kebutuhan tim sudah dicatat.'],
  ['kebutuhan-dihapus', 'Kebutuhan alat sudah dihapus dari rencana.'],
]);

function safeNext(value) {
  if (value === '/peminjaman' || value === '/galeri/bagikan' || value === '/agenda' ||
    (typeof value === 'string' && (/^\/(alat|kit|galeri)\/[1-9]\d{0,9}$/.test(value) || /^\/admin\?alat=[1-9]\d{0,9}$/.test(value)))) {
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
  if (!res.locals.user) {
    const aim = req.path === '/admin' ? safeNext('/admin?alat=' + asText(req.query.alat)) : '';
    return res.redirect(303, aim ? '/masuk?lanjut=' + encodeURIComponent(aim) : '/masuk');
  }
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

export async function createApp({
  databasePath, databaseUrl, demo = false, sampleInventory = false, catalogOnly = false, admin,
  secureCookies = false, proxyHops = 0,
}) {
  const inventory = await openInventory({ databasePath, databaseUrl });
  try {
    await prepareData(inventory, { demo, admin, sampleInventory });
  } catch (error) {
    await inventory.close();
    throw error;
  }

  const sessions = createSessions(inventory, secureCookies);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', proxyHops);
  app.set('views', file('../views'));
  app.set('view engine', 'ejs');

  Object.assign(app.locals, {
    icon, initials, categories, categoryById, statuses, sorts, demo, demoAccounts, sampleInventory, catalogOnly,
    formatDate, inventoryPageQuery, maxLoanDays: MAX_LOAN_DAYS, maxAdvanceDays: MAX_ADVANCE_DAYS,
    agendaDay, agendaTime, eventKinds, eventVisibility,
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
  app.get('/motion/:script', (req, res, next) => {
    const script = motionScripts.get(req.params.script);
    if (!script) return next();
    res.type('js').set('Cache-Control', 'public, max-age=86400').send(script);
  });
  app.get('/healthz', async (_req, res) => {
    await inventory.ready();
    res.json({ ok: true });
  });

  app.use(async (req, res, next) => {
    req.session = await sessions.read(req);
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
  if (catalogOnly) {
    app.use((req, _res, next) => {
      const catalogPage = ['/', '/panduan', '/kit', '/galeri'].includes(req.path) ||
        /^\/(alat|kit|galeri)\/[1-9]\d{0,9}$/.test(req.path) || /^\/galeri\/[1-9]\d{0,9}\/foto$/.test(req.path);
      if (!catalogPage || !['GET', 'HEAD'].includes(req.method)) {
        throw new AppError(404, 'Pratinjau ini menampilkan katalog dan panduan peminjaman.');
      }
      next();
    });
  }
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 24 }));
  app.post('/galeri/bagikan', requireUser, parseProjectPhoto);
  app.post(/.*/, (req, _res, next) => {
    if (!checkCsrf(req.session, req.body?._csrf)) {
      throw new AppError(403, 'Sesi formulir sudah berakhir. Muat ulang halaman, lalu coba lagi.');
    }
    next();
  });

  async function showAuth(req, res, view, values, error = '', status = 200) {
    if (!req.session) res.locals.csrf = await sessions.start(res, null);
    const nextPath = safeNext(values.lanjut);
    const suffix = nextPath ? '?lanjut=' + encodeURIComponent(nextPath) : '';
    res.status(status).render(view, {
      name: asText(values.name).slice(0, 80),
      email: normalizeEmail(values.email).slice(0, 254),
      login: normalizeEmail(values.login ?? values.email).slice(0, 254),
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

  app.get('/', async (req, res) => {
    const catalog = catalogData(await inventory.catalog(), req.query);
    const kits = catalog.search || catalog.category ? [] : (await inventory.listKits()).slice(0, 2);
    res.render('catalog', { ...catalog, kits, page: 'catalog' });
  });

  app.get('/panduan', (_req, res) => res.render('guide', { page: 'guide' }));

  app.get('/masuk', async (req, res) => {
    if (res.locals.user) return res.redirect(safeNext(req.query.lanjut) || (res.locals.user.role === 'admin' ? '/admin' : '/peminjaman'));
    await showAuth(req, res, 'login', req.query);
  });

  app.post('/masuk', authLimit, async (req, res) => {
    if (res.locals.user) return res.redirect(303, '/peminjaman');
    const identifier = asText(req.body.login ?? req.body.email).toLowerCase();
    let account;
    if (identifier === ADMIN_USERNAME) account = await inventory.adminByUsername(identifier);
    else if (validEmail(identifier)) account = await inventory.userByEmail(identifier);

    const matches = await matchesPassword(req.body.password, account?.password_hash);
    if (!account || !matches || !await sessions.start(res, req.session, account.id, account.password_hash)) {
      return showAuth(req, res, 'login', req.body, 'Email, nama pengguna, atau kata sandi salah.', 401);
    }
    res.redirect(303, safeNext(req.body.lanjut) || (account.role === 'admin' ? '/admin' : '/peminjaman'));
  });

  app.get('/daftar', async (req, res) => {
    if (res.locals.user) return res.redirect(safeNext(req.query.lanjut) || '/peminjaman');
    await showAuth(req, res, 'register', req.query);
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
    const userId = await inventory.transaction(async (database) => {
      if (await database.userByEmail(email)) return null;
      return database.createUser(name, email, passwordHash, 'member');
    });
    if (!userId) return showAuth(req, res, 'register', req.body, 'Email sudah terdaftar. Silakan masuk.', 409);

    await sessions.start(res, req.session, userId);
    res.redirect(303, safeNext(req.body.lanjut) || '/peminjaman');
  });

  app.post('/keluar', async (req, res) => {
    await sessions.end(res, req.session);
    res.redirect(303, '/');
  });

  async function publicEquipment(id) {
    const item = await inventory.equipment(id);
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

  app.get('/alat/:id', async (req, res) => renderDetail(res, await publicEquipment(recordId(req.params.id))));

  app.post('/alat/:id/pinjam', requireUser, async (req, res) => {
    const id = recordId(req.params.id);
    try {
      const form = validateLoan(req.body, res.locals.today);
      await inventory.requestLoan(id, res.locals.user.id, form);
      res.redirect(303, '/peminjaman?hasil=diajukan');
    } catch (error) {
      if (!(error instanceof AppError) || error.status === 404) throw error;
      renderDetail(res, await publicEquipment(id), {
        values: formValues(req.body, ['quantity', 'start', 'due', 'purpose']),
        error: error.message,
        status: error.status,
      });
    }
  });

  app.get('/peminjaman', requireUser, async (req, res) => {
    const allLoans = await inventory.memberLoans(res.locals.user.id);
    const selectedStatus = ['pending', 'approved', 'borrowed'].includes(req.query.status) ? req.query.status : null;
    const filter = selectedStatus ? 'active' : filterValue(req.query.status, memberTabs);
    const loans = allLoans.filter((loan) => selectedStatus ? loan.status === selectedStatus :
      filter === 'all' || (filter === 'history') === historyStatuses.has(loan.status));
    const overview = req.query.status === undefined;
    const timeline = allLoans.filter((loan) => ['approved', 'borrowed'].includes(loan.status))
      .map((loan) => ({ loan, date: loan.status === 'approved' ? loan.start_date : loan.due_date }))
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
    const counts = Object.fromEntries(['pending', 'approved', 'borrowed'].map((status) => [
      status, allLoans.filter((loan) => loan.status === status).length,
    ]));
    res.render('loans', {
      page: 'loans', loans, filter, tabs: memberTabs, overview, timeline, counts, selectedStatus,
      kits: overview ? (await inventory.listKits()).sort((a, b) => b.available - a.available).slice(0, 2) : [],
      projects: overview ? await inventory.listProjects(2) : [],
      agenda: overview ? agendaData(await inventory.publishedEvents(), res.locals.today) : null,
    });
  });

  app.post('/peminjaman/:id/batal', requireUser, async (req, res) => {
    await inventory.cancelLoan(recordId(req.params.id), res.locals.user.id);
    res.redirect(303, '/peminjaman?hasil=cancelled');
  });

  app.get('/admin', requireAdmin, async (req, res) => {
    const filter = filterValue(req.query.status, staffTabs);
    const allLoans = await inventory.adminLoans();
    const counts = Object.fromEntries(staffTabs.map(({ id }) => [
      id, allLoans.filter((loan) => id === 'history' ? historyStatuses.has(loan.status) : loan.status === id).length,
    ]));
    const today = res.locals.today;
    const tasks = {
      ambil: { label: 'Siap diserahkan', loans: allLoans.filter((loan) => loan.status === 'approved' && loan.start_date <= today && loan.due_date >= today) },
      kembali: { label: 'Kembali hari ini', loans: allLoans.filter((loan) => loan.status === 'borrowed' && loan.due_date === today) },
      terlambat: { label: 'Terlambat kembali', loans: allLoans.filter((loan) => loan.status === 'borrowed' && loan.due_date < today) },
    };
    const task = Object.hasOwn(tasks, req.query.hari) ? tasks[req.query.hari] : null;
    const equipment = req.query.alat === undefined ? null : await inventory.equipment(recordId(req.query.alat));
    const overview = !task && !equipment && req.query.status === undefined;
    const loans = equipment
      ? allLoans.filter((loan) => ['approved', 'borrowed'].includes(loan.status) && loan.items.some((line) => line.equipment_id === equipment.id))
      : task?.loans ?? allLoans.filter((loan) => filter === 'history' ? historyStatuses.has(loan.status) : loan.status === filter);
    const serviceUnits = overview ? (await inventory.serviceList()).reduce((total, row) => total + row.service_quantity, 0) : 0;
    res.render('admin', { page: 'admin', overview, tasks, task, equipment, serviceUnits, filter, loans, counts, tabs: staffTabs });
  });

  app.post('/admin/peminjaman/:id/tindakan', requireAdmin, async (req, res) => {
    const action = asText(req.body.action);
    const result = await inventory.advanceLoan(recordId(req.params.id), action, res.locals.today);
    const nextTab = staffTabs.some((tab) => tab.id === result) ? result : 'history';
    res.redirect(303, `/admin?status=${nextTab}&hasil=${result}`);
  });

  app.get('/admin/alat', requireAdmin, async (req, res) => {
    const summary = await inventory.inventorySummary();
    const paging = inventoryPagination(summary.length, req.query.halaman);
    const items = await inventory.inventoryPage(paging.limit, paging.offset);
    res.render('admin-inventory', {
      page: 'admin', items, paging, pageQuery: inventoryPageQuery(paging.number),
      draftCount: missingEquipment(summary).length,
    });
  });

  app.post('/admin/alat/paket', requireAdmin, async (req, res) => {
    const added = await inventory.transaction(async (database) => {
      return addMissingEquipment(database, await database.inventorySummary());
    });
    const result = added ? 'paket-draf' : 'paket-lengkap';
    res.redirect(303, '/admin/alat' + inventoryPageQuery(inventoryPageNumber(req.query.halaman), result));
  });

  function showInventoryForm(req, res, item, values = item, error = '', status = 200) {
    const pageQuery = inventoryPageQuery(inventoryPageNumber(req.query.halaman));
    res.status(status).render('admin-equipment', { page: 'admin', item, values, error, pageQuery });
  }

  app.get('/admin/alat/baru', requireAdmin, (req, res) => {
    showInventoryForm(req, res, null, { name: '', category: '', description: '', total: '', active: 1 });
  });

  app.get('/admin/alat/:id', requireAdmin, async (req, res) => {
    showInventoryForm(req, res, await inventory.equipment(recordId(req.params.id)));
  });

  app.post(['/admin/alat', '/admin/alat/:id'], requireAdmin, async (req, res) => {
    const item = req.params.id ? await inventory.equipment(recordId(req.params.id)) : null;
    try {
      const form = validateEquipment(req.body);
      if (item) await inventory.updateEquipment(item.id, form);
      else await inventory.addEquipment(form);
      res.redirect(303, '/admin/alat' + inventoryPageQuery(inventoryPageNumber(req.query.halaman), 'disimpan'));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const values = formValues(req.body, ['name', 'category', 'description', 'total']);
      values.active = req.body.active === '1' ? 1 : 0;
      showInventoryForm(req, res, item, values, error.message, error.status);
    }
  });

  mountLabRoutes(app, inventory, { requireUser, requireAdmin });

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

  return { app, close: inventory.close };
}
