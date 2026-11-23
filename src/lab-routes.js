import multer from 'multer';
import QRCode from 'qrcode';
import { agendaData, eventForm, validateEvent } from './agenda.js';
import { AppError, asText, MAX_ADVANCE_DAYS, MAX_LOAN_DAYS, recordId, shiftDate, validateLoan } from './domain.js';

const kitSlots = 8;
const photoLimit = 2 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: photoLimit, files: 1, fields: 5, fieldSize: 4096 },
}).single('photo');

export function parseProjectPhoto(req, res, next) {
  upload(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      return next(new AppError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 422, 'Unggah satu foto JPEG, PNG, atau WebP maksimal 2 MB.'));
    }
    if (error) return next(new AppError(400, 'Formulir foto tidak dapat dibaca.'));
    next();
  });
}

function photoFields(file) {
  if (!file) return {};
  const { buffer } = file;
  let photoType;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) photoType = 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) photoType = 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') photoType = 'image/webp';
  if (!photoType) throw new AppError(422, 'Pilih foto JPEG, PNG, atau WebP.');
  return { photo: buffer, photoType };
}

function kitValues(body) {
  const parts = Array.from({ length: kitSlots }, (_, index) => ({
    equipmentId: asText(body[`alat-${index}`]),
    quantity: asText(body[`jumlah-${index}`]),
  }));
  return { title: asText(body.title), description: asText(body.description), active: body.active === '1' ? 1 : 0, parts };
}

function validateKit(values, equipment) {
  const { title, description, parts } = values;
  if (title.length < 3 || title.length > 90 || description.length < 10 || description.length > 500) {
    throw new AppError(422, 'Isi nama kit (3–90 karakter) dan deskripsi (10–500 karakter).');
  }
  const picked = parts.filter((part) => part.equipmentId);
  if (picked.length < 2 || new Set(picked.map((part) => part.equipmentId)).size !== picked.length) {
    throw new AppError(422, 'Pilih minimal dua jenis alat yang berbeda. Jumlah setiap alat bisa diatur di barisnya.');
  }
  const validated = picked.map((part) => {
    const equipmentId = Number(part.equipmentId);
    if (!equipment.some((item) => String(item.id) === part.equipmentId) || !/^\d{1,3}$/.test(part.quantity) || !Number(part.quantity)) {
      throw new AppError(422, 'Pilih alat dari inventaris dan isi jumlah antara 1–999 unit.');
    }
    return { equipmentId, quantity: Number(part.quantity) };
  });
  return { ...values, parts: validated };
}

function loanForm(today, values = {}) {
  return {
    lastStart: shiftDate(today, MAX_ADVANCE_DAYS),
    lastDue: shiftDate(today, MAX_ADVANCE_DAYS + MAX_LOAN_DAYS - 1),
    values: {
      quantity: asText(values.quantity) || '1',
      start: asText(values.start) || today,
      due: asText(values.due) || shiftDate(today, 6),
      purpose: asText(values.purpose).slice(0, 300),
    },
  };
}

function eventTotals(needs) {
  const tools = new Map();
  for (const row of needs) {
    if (!tools.has(row.equipment_id)) tools.set(row.equipment_id, { ...row, quantity: 0 });
    tools.get(row.equipment_id).quantity += row.quantity;
  }
  return [...tools.values()].map((item) => ({ ...item, shortage: Math.max(0, item.quantity - item.available) }))
    .sort((a, b) => b.shortage - a.shortage || a.equipment_name.localeCompare(b.equipment_name, 'id'));
}

export function mountLabRoutes(app, inventory, { requireUser, requireAdmin }) {
  app.get('/agenda', requireUser, async (_req, res) => {
    const agenda = agendaData(await inventory.publishedEvents(), res.locals.today);
    res.render('agenda', { page: 'agenda', agenda });
  });

  app.get('/kit', async (_req, res) => {
    res.render('kits', { page: 'kits', kits: await inventory.listKits() });
  });

  app.get('/galeri', async (_req, res) => {
    res.render('gallery', { page: 'gallery', projects: await inventory.listProjects(100) });
  });

  app.get('/galeri/bagikan', requireUser, (req, res) => showPublish(res, { selected: asText(req.query.pinjaman) }));

  function showBundle(res, bundle, source, { status = 200, error = '', values } = {}) {
    res.status(status).render('bundle', {
      page: source === 'kit' ? 'kits' : 'gallery',
      bundle,
      source,
      error,
      ...loanForm(res.locals.today, values),
    });
  }

  for (const [base, source] of [['/kit', 'kit'], ['/galeri', 'project']]) {
    async function findBundle(id) {
      const bundle = source === 'kit' ? await inventory.kit(id) : await inventory.project(id);
      if (!bundle.active) throw new AppError(404, 'Kit proyek ini tidak ditampilkan.');
      return bundle;
    }

    app.get(base + '/:id', async (req, res) => {
      showBundle(res, await findBundle(recordId(req.params.id)), source);
    });

    app.post(base + '/:id/pinjam', requireUser, async (req, res) => {
      const id = recordId(req.params.id);
      try {
        const form = validateLoan(req.body, res.locals.today);
        await inventory.requestBundle(source, id, res.locals.user.id, form);
        res.redirect(303, '/peminjaman?hasil=diajukan');
      } catch (error) {
        if (!(error instanceof AppError) || error.status === 404) throw error;
        showBundle(res, await findBundle(id), source, { status: error.status, error: error.message, values: req.body });
      }
    });
  }

  async function showPublish(res, { selected = '', values = {}, error = '', status = 200 } = {}) {
    const loans = (await inventory.memberLoans(res.locals.user.id))
      .filter((loan) => loan.status === 'returned' && !loan.project_id);
    res.status(status).render('gallery-publish', { page: 'gallery', loans, selected, values, error });
  }

  app.post('/galeri/bagikan', requireUser, async (req, res) => {
    const selected = asText(req.body.pinjaman);
    const title = asText(req.body.title);
    const description = asText(req.body.description);
    try {
      if (title.length < 3 || title.length > 90 || description.length < 10 || description.length > 1200 || req.body.publik !== '1') {
        throw new AppError(422, 'Isi judul, ceritakan rakitanmu (10–1200 karakter), dan konfirmasi publikasi.');
      }
      const fields = { title, description, ...photoFields(req.file) };
      const projectId = await inventory.transaction(async (database) => {
        const loan = await database.loanRequest(recordId(selected));
        if (loan.user_id !== res.locals.user.id || loan.status !== 'returned') {
          throw new AppError(404, 'Pilih peminjamanmu yang sudah dikembalikan.');
        }
        return database.addProject(loan.id, fields, res.locals.today);
      });
      res.redirect(303, '/galeri/' + projectId + '?hasil=rakitan-terbit');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await showPublish(res, { selected, values: { title, description }, error: error.message, status: error.status });
    }
  });

  app.get('/galeri/:id/foto', async (req, res) => {
    const row = await inventory.projectPhoto(recordId(req.params.id));
    if (!row) throw new AppError(404, 'Foto rakitan ini tidak ditemukan.');
    res.type(row.photo_type).send(Buffer.from(row.photo));
  });

  app.post('/galeri/:id/hapus', requireUser, async (req, res) => {
    const id = recordId(req.params.id);
    await inventory.transaction(async (database) => {
      const project = await database.project(id);
      if (project.author_id !== res.locals.user.id && res.locals.user.role !== 'admin') throw new AppError(403, 'Hanya pembuat rakitan atau pengurus yang dapat menghapus publikasi.');
      await database.removeProject(id);
    });
    res.redirect(303, '/galeri?hasil=rakitan-dihapus');
  });

  app.get('/admin/kit', requireAdmin, async (_req, res) => {
    res.render('admin-kits', { page: 'admin', kits: await inventory.listKits(false) });
  });

  async function showKitForm(res, kit, values, error = '', status = 200) {
    const initial = kit ? { ...kit, parts: kit.parts.map((part) => ({ equipmentId: part.equipment_id, quantity: part.quantity })) }
      : { title: '', description: '', active: 1, parts: [] };
    res.status(status).render('admin-kit-form', {
      page: 'admin', kit, values: values ?? initial, equipment: await inventory.inventory(), kitSlots, error,
    });
  }

  app.get('/admin/kit/baru', requireAdmin, (_req, res) => showKitForm(res, null));
  app.get('/admin/kit/:id', requireAdmin, async (req, res) => showKitForm(res, await inventory.kit(recordId(req.params.id))));
  app.post(['/admin/kit', '/admin/kit/:id'], requireAdmin, async (req, res) => {
    const kit = req.params.id ? await inventory.kit(recordId(req.params.id)) : null;
    const values = kitValues(req.body);
    try {
      const form = validateKit(values, await inventory.inventory());
      const id = await inventory.transaction((database) => database.saveKit(kit?.id, form));
      res.redirect(303, '/admin/kit/' + id + '?hasil=kit-disimpan');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await showKitForm(res, kit, values, error.message, error.status);
    }
  });

  app.get('/admin/servis', requireAdmin, async (req, res) => {
    const resolved = req.query.status === 'selesai';
    res.render('admin-service', { page: 'admin', records: await inventory.serviceList(resolved), resolved });
  });
  app.post('/admin/servis/:id/selesai', requireAdmin, async (req, res) => {
    await inventory.transaction((database) => database.completeService(recordId(req.params.id), res.locals.today));
    res.redirect(303, '/admin/servis?hasil=servis-selesai');
  });

  async function showInspection(res, id, { values = {}, error = '', status = 200 } = {}) {
    const loan = await inventory.loanRequest(id);
    if (loan.status !== 'borrowed') throw new AppError(409, 'Pinjaman ini sudah diproses atau belum diambil.');
    res.status(status).render('admin-return', { page: 'admin', loan, values, error });
  }

  app.get('/admin/peminjaman/:id/pengembalian', requireAdmin, (req, res) => showInspection(res, recordId(req.params.id)));
  app.post('/admin/peminjaman/:id/pengembalian', requireAdmin, async (req, res) => {
    const id = recordId(req.params.id);
    try {
      await inventory.advanceLoan(id, 'return', res.locals.today, req.body);
      res.redirect(303, '/admin?status=history&hasil=returned');
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 422) throw error;
      await showInspection(res, id, { status: error.status, error: error.message, values: req.body });
    }
  });

  app.get('/admin/alat/:id/label', requireAdmin, async (req, res) => {
    const item = await inventory.equipment(recordId(req.params.id));
    res.render('admin-qr', { page: 'admin', item });
  });
  app.get('/admin/alat/:id/label.png', requireAdmin, async (req, res) => {
    const item = await inventory.equipment(recordId(req.params.id));
    const target = new URL('/admin?alat=' + item.id, req.protocol + '://' + req.get('host'));
    res.type('png').send(await QRCode.toBuffer(target.href, { width: 300, margin: 3 }));
  });

  async function showEvents(res, { values, error = '', status = 200 } = {}) {
    res.status(status).render('admin-events', {
      page: 'admin', events: await inventory.events(), error,
      values: values ?? eventForm({ date: res.locals.today, kind: 'latihan', published: '1' }),
    });
  }

  app.get('/admin/kegiatan', requireAdmin, (_req, res) => showEvents(res));

  async function showEvent(res, event, { values = event, error = '', status = 200 } = {}) {
    const totals = eventTotals(event.needs);
    res.status(status).render('admin-event', {
      page: 'admin', event, totals, equipment: event.kind === 'pengumuman' ? [] : await inventory.inventory(),
      values, error,
    });
  }

  app.get('/admin/kegiatan/:id', requireAdmin, async (req, res) => showEvent(res, await inventory.event(recordId(req.params.id))));
  app.post(['/admin/kegiatan', '/admin/kegiatan/:id'], requireAdmin, async (req, res) => {
    const event = req.params.id ? await inventory.event(recordId(req.params.id)) : null;
    const values = eventForm(req.body, event);
    try {
      const id = await inventory.saveEvent(event?.id, validateEvent(values));
      res.redirect(303, '/admin/kegiatan/' + id + '?hasil=kegiatan-disimpan');
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 422) throw error;
      const options = { values, status: error.status, error: error.message };
      if (event) await showEvent(res, event, options);
      else await showEvents(res, options);
    }
  });
  app.post('/admin/kegiatan/:id/kebutuhan', requireAdmin, async (req, res) => {
    const id = recordId(req.params.id);
    const team = asText(req.body.team);
    const quantity = asText(req.body.quantity);
    if (team.length < 2 || team.length > 80 || !/^\d{1,3}$/.test(quantity) || !Number(quantity)) {
      throw new AppError(422, 'Isi nama tim (2–80 karakter) dan jumlah 1–999 unit.');
    }
    const item = await inventory.equipment(recordId(asText(req.body.alat)));
    await inventory.event(id);
    await inventory.addEventNeed(id, team, item.id, Number(quantity));
    res.redirect(303, '/admin/kegiatan/' + id + '?hasil=kebutuhan-disimpan');
  });
  app.post('/admin/kegiatan/:id/kebutuhan/:need/hapus', requireAdmin, async (req, res) => {
    const id = recordId(req.params.id);
    await inventory.removeEventNeed(id, recordId(req.params.need));
    res.redirect(303, '/admin/kegiatan/' + id + '?hasil=kebutuhan-dihapus');
  });
}
