import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { openInventory } from '../src/database.js';
import { clubDate, shiftDate } from '../src/domain.js';
import { starterEquipment } from '../src/equipment-samples.js';
import { demoAccounts } from '../src/seed.js';

async function tempDatabase(t) {
  const folder = await mkdtemp(join(tmpdir(), 'robolab-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, 'test.sqlite');
}

async function startSite(databasePath, config) {
  const { app, close } = await createApp({ databasePath, ...config });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await close();
    },
  };
}

class Client {
  constructor(site) {
    this.base = site.url;
  }

  async request(path, fields) {
    const response = await fetch(this.base + path, {
      redirect: 'manual',
      headers: this.cookie ? { Cookie: this.cookie } : {},
      method: fields ? 'POST' : 'GET',
      body: fields ? new URLSearchParams(fields) : undefined,
    });
    const cookie = response.headers.getSetCookie()[0];
    if (cookie) this.cookie = cookie.split(';')[0];
    const html = await response.text();
    const csrf = html.match(/name="_csrf" value="([a-f0-9]{64})"/);
    if (csrf) this.csrf = csrf[1];
    return { status: response.status, location: response.headers.get('location'), html, cookie };
  }

  async login({ email, password }) {
    assert.equal((await this.request('/masuk')).status, 200);
    return this.post('/masuk', { email, password });
  }

  post(path, fields = {}) {
    return this.request(path, { _csrf: this.csrf, ...fields });
  }
}

async function register(client, name, email) {
  assert.equal((await client.request('/daftar')).status, 200);
  const response = await client.post('/daftar', { name, email, password: 'Password-Testing-123!' });
  assert.equal(response.status, 303, response.html);
  const loans = await client.request('/peminjaman');
  assert.match(loans.html, /Belum ada peminjaman/);
}

function loanId(html) {
  return Number(html.match(/id="pinjaman-(\d+)"/)?.[1]);
}

test('catalog supports search, categories, sorting, and accurate availability', async (t) => {
  const site = await startSite(await tempDatabase(t), { demo: true });
  try {
    const guest = new Client(site);
    const catalog = await guest.request('/');
    assert.equal(catalog.status, 200);
    assert.equal((catalog.html.match(/class="equipment-card"/g) ?? []).length, 30);
    const result = await guest.request('/?kategori=sensor&q=hc-sr04&urut=nama');
    assert.match(result.html, /Sensor Ultrasonik HC-SR04/);
    assert.doesNotMatch(result.html, /Arduino Uno R3/);
    const ordered = await guest.request('/?urut=stok');
    assert.ok(ordered.html.indexOf('Sensor Ultrasonik HC-SR04') < ordered.html.indexOf('Arduino Uno R3'));
    assert.match((await guest.request('/?q=tidak-ada')).html, /Alat tidak ditemukan/);
    assert.match((await guest.request('/alat/4')).html, /Stok habis/);
    assert.equal((await guest.request('/alat/500')).status, 404);
    assert.equal((await guest.request('/peminjaman')).location, '/masuk?lanjut=%2Fpeminjaman');
  } finally {
    await site.stop();
  }
});

test('approved requests reserve stock atomically and returns release it', async (t) => {
  const site = await startSite(await tempDatabase(t), { demo: true });
  try {
    const member = new Client(site);
    const other = new Client(site);
    const admin = new Client(site);
    await register(member, 'Anggota Satu', 'satu@example.test');
    await register(other, 'Anggota Dua', 'dua@example.test');
    assert.equal((await admin.login(demoAccounts.admin)).location, '/admin');
    assert.equal((await admin.request('/admin')).status, 200);
    assert.equal((await member.request('/admin')).status, 403);

    const start = clubDate();
    const due = shiftDate(start, 1);
    const form = { quantity: '8', start, due, purpose: 'Proyek pengukuran jarak di lab' };
    assert.equal((await member.post('/alat/3/pinjam', { ...form, _csrf: 'invalid' })).status, 403);
    assert.equal((await member.post('/alat/3/pinjam', { ...form, due: shiftDate(start, 14) })).status, 422);
    const requests = await Promise.all([member.post('/alat/3/pinjam', form), other.post('/alat/3/pinjam', form)]);
    assert.deepEqual(requests.map((r) => r.status), [303, 303]);
    const ids = await Promise.all([member, other].map(async (client) => loanId((await client.request('/peminjaman')).html)));
    assert.ok(ids.every(Number.isSafeInteger));
    assert.notEqual(ids[0], ids[1]);
    assert.equal((await member.post('/peminjaman/' + ids[1] + '/batal')).status, 404);
    assert.equal((await member.post('/admin/peminjaman/' + ids[0] + '/tindakan', { action: 'approve' })).status, 403);

    const action = (id, value) => admin.post('/admin/peminjaman/' + id + '/tindakan', { action: value });
    const decisions = await Promise.all(ids.map((id) => action(id, 'approve')));
    assert.deepEqual(decisions.map((r) => r.status).sort(), [303, 409]);
    const winner = decisions.findIndex((r) => r.status === 303);
    const approvedId = ids[winner];
    assert.match((await member.request('/alat/3')).html, /Stok habis/);
    assert.equal((await action(approvedId, 'pickup')).status, 303);
    assert.equal((await action(approvedId, 'pickup')).status, 409);
    assert.equal((await [member, other][winner].post('/peminjaman/' + approvedId + '/batal')).status, 409);
    assert.equal((await action(approvedId, 'return')).status, 303);
    assert.match((await member.request('/alat/3')).html, /8 unit/);
    assert.match((await [member, other][winner].request('/peminjaman?status=history')).html, /Dikembalikan/);
    assert.equal((await action(ids[1 - winner], 'approve')).status, 303);
    assert.equal((await [member, other][1 - winner].post('/peminjaman/' + ids[1 - winner] + '/batal')).status, 303);
    assert.match((await member.request('/alat/3')).html, /8 unit/);
  } finally {
    await site.stop();
  }
});

test('inventory changes persist and stock edits respect active loans', async (t) => {
  const path = await tempDatabase(t);
  const site = await startSite(path, { demo: true });
  const item = { name: 'Modul Driver Motor', category: 'motor', description: 'Pengendali kecepatan dua motor DC.', total: '4', active: '1' };
  try {
    const admin = new Client(site);
    assert.equal((await admin.login(demoAccounts.admin)).status, 303);
    assert.equal((await admin.request('/admin/alat')).status, 200);
    const lowStock = await admin.post('/admin/alat/1', { ...item, total: '1' });
    assert.equal(lowStock.status, 409);
    assert.match(lowStock.html, /minimal 2 unit/);
    assert.equal((await admin.post('/admin/alat', item)).status, 303);
    assert.match((await admin.request('/?q=Modul+Driver')).html, /Modul Driver Motor/);
  } finally {
    await site.stop();
  }

  const restarted = await startSite(path, { demo: true });
  try {
    const admin = new Client(restarted);
    assert.equal((await admin.login(demoAccounts.admin)).status, 303);
    const catalog = await admin.request('/?q=Modul+Driver');
    const id = catalog.html.match(/href="\/alat\/(\d+)" aria-label="Detail Modul Driver Motor"/)?.[1];
    assert.ok(id);
    assert.equal((await admin.post('/admin/alat/' + id, { ...item, active: '0' })).status, 303);
    assert.equal((await admin.request('/alat/' + id)).status, 404);
    assert.doesNotMatch((await admin.request('/')).html, /Modul Driver Motor/);
  } finally {
    await restarted.stop();
  }
  await assert.rejects(createApp({ databasePath: path, demo: false }), /database terpisah/);
});

test('club mode starts empty and uses configured admin and secure sessions', async (t) => {
  const email = 'pengurus@example.test';
  const password = 'Testing-Password-123!';
  const site = await startSite(await tempDatabase(t), { admin: { email, password }, secureCookies: true });
  try {
    const client = new Client(site);
    assert.match((await client.request('/')).html, /Katalog masih kosong/);
    const signIn = await client.request('/masuk');
    assert.doesNotMatch(signIn.html, /Akun demo/);
    assert.match(signIn.cookie, /__Host-robolab_session=.*HttpOnly; Secure; SameSite=Lax/);
    assert.equal((await client.post('/masuk', demoAccounts.admin)).status, 401);
    const signedIn = await client.post('/masuk', { email, password, lanjut: '//example.test' });
    assert.equal(signedIn.location, '/admin');
    assert.notEqual(signedIn.cookie, signIn.cookie);
    assert.equal((await client.request('/admin')).status, 200);
    assert.equal((await client.post('/keluar')).status, 303);
    assert.equal((await client.request('/admin')).location, '/masuk');
  } finally {
    await site.stop();
  }
});

test('public catalog does not allow account access or loan submissions', async (t) => {
  const site = await startSite(await tempDatabase(t), { sampleInventory: true, catalogOnly: true });
  try {
    const guest = new Client(site);
    const catalog = await guest.request('/');
    assert.match(catalog.html, /Pratinjau katalog/);
    assert.match(catalog.html, /Arduino Uno R3/);
    assert.doesNotMatch(catalog.html, /href="\/masuk"/);
    assert.equal((await guest.request('/panduan')).status, 200);
    assert.equal((await guest.request('/alat/1')).status, 200);
    assert.equal((await guest.request('/daftar')).status, 404);
    assert.equal((await guest.request('/admin')).status, 404);
    assert.equal((await guest.request('/alat/1/pinjam', { quantity: '1' })).status, 404);
  } finally {
    await site.stop();
  }
});

test('admin username works and password revisions revoke sessions without resetting on an older deploy', async (t) => {
  const file = await tempDatabase(t);
  const email = 'pengurus-utama@example.test';
  const current = { email, password: 'Testing-Original-Admin-123!' };
  const next = { email, password: 'Testing-New-Admin-Passphrase!', passwordRevision: 1 };
  const identifier = { login: '  ADMINPEMINJAMAN  ' };

  const oldSite = await startSite(file, { admin: current });
  try {
    const prior = new Client(oldSite);
    assert.equal((await prior.request('/masuk')).status, 200);
    assert.equal((await prior.post('/masuk', { ...identifier, password: current.password })).location, '/admin');
    assert.equal((await prior.request('/admin')).status, 200);

    const newSite = await startSite(file, { admin: next });
    try {
      assert.equal((await prior.request('/admin')).location, '/masuk');
      await prior.request('/masuk');
      assert.equal((await prior.post('/masuk', { ...identifier, password: current.password })).status, 401);

      const newSession = new Client(newSite);
      await newSession.request('/masuk');
      assert.equal((await newSession.post('/masuk', { ...identifier, password: next.password })).location, '/admin');
      const staleSite = await startSite(file, { admin: current });
      try {
        assert.equal((await newSession.request('/admin')).status, 200);
        const staleClient = new Client(staleSite);
        assert.equal((await staleClient.login(next)).location, '/admin');
      } finally {
        await staleSite.stop();
      }
    } finally {
      await newSite.stop();
    }
  } finally {
    await oldSite.stop();
  }
});

test('an existing example catalog is expanded once and preserves edited equipment', async (t) => {
  const path = await tempDatabase(t);
  const old = await openInventory({ databasePath: path });
  const edited = {
    ...starterEquipment[0],
    name: 'Arduino utama klub',
    total: 3,
    active: 0,
  };
  let editedId;
  try {
    editedId = await old.addEquipment(edited);
    for (const item of starterEquipment.slice(1)) {
      await old.addEquipment({ ...item, active: 1 });
    }
    await old.setMetadata('sample-equipment-seeded', '1');
  } finally {
    await old.close();
  }

  for (let start = 0; start < 2; start++) {
    const site = await startSite(path, { sampleInventory: true });
    try {
      const guest = new Client(site);
      const catalog = await guest.request('/');
      assert.equal((catalog.html.match(/class="equipment-card"/g) ?? []).length, 29);
      assert.doesNotMatch(catalog.html, /Arduino utama klub|Arduino Uno R3/);
      assert.match((await guest.request('/?kategori=sensor&q=mpu-6050')).html, /sensor-mpu6050\.webp/);
    } finally {
      await site.stop();
    }
  }

  const store = await openInventory({ databasePath: path });
  try {
    assert.equal((await store.inventory()).length, 30);
    const saved = await store.equipment(editedId);
    assert.equal(saved.name, edited.name);
    assert.equal(saved.image, edited.image);
    assert.equal(saved.total, edited.total);
    assert.equal(saved.active, edited.active);
  } finally {
    await store.close();
  }
});

test('only staff can import missing equipment as hidden drafts with images', async (t) => {
  const path = await tempDatabase(t);
  const account = { email: 'pengurus@example.test', password: 'Testing-Password-123!' };
  const initial = await openInventory({ databasePath: path });
  try {
    await initial.addEquipment({
      name: 'ESP32 DevKit V1', category: 'mikrokontroler', total: 7, active: 1,
      description: 'Papan ESP32 yang sudah terdaftar sebagai stok klub.',
    });
    // An older installation could mark a non-empty club catalog without adding sample equipment.
    await initial.setMetadata('sample-equipment-seeded', '1');
  } finally {
    await initial.close();
  }

  const site = await startSite(path, { admin: account, sampleInventory: true });
  try {
    const member = new Client(site);
    await register(member, 'Anggota Uji', 'anggota@example.test');
    assert.equal((await member.post('/admin/alat/paket')).status, 403);

    const admin = new Client(site);
    assert.equal((await admin.login(account)).location, '/admin');
    assert.match((await admin.request('/admin/alat')).html, /Impor 29 draf alat/);
    const imports = await Promise.all([admin.post('/admin/alat/paket'), admin.post('/admin/alat/paket')]);
    assert.deepEqual(imports.map((response) => response.location).sort(), [
      '/admin/alat?hasil=paket-draf',
      '/admin/alat?hasil=paket-lengkap',
    ]);
    assert.doesNotMatch((await member.request('/')).html, /Sensor IMU MPU-6050/);

    const store = await openInventory({ databasePath: path });
    let sensor;
    try {
      const items = await store.inventory();
      assert.equal(items.length, 30);
      sensor = items.find((item) => item.image === 'sensor-mpu6050.webp');
      assert.equal(sensor.total, 0);
      assert.equal(sensor.active, 0);
      const existing = items.find((item) => item.name === 'ESP32 DevKit V1');
      assert.equal(existing.total, 7);
      assert.equal(existing.active, 1);
    } finally {
      await store.close();
    }

    assert.equal((await admin.post('/admin/alat/' + sensor.id, { ...sensor, total: '2', active: '1' })).status, 303);
    const result = await member.request('/alat/' + sensor.id);
    assert.equal(result.status, 200);
    assert.match(result.html, /sensor-mpu6050\.webp/);
    assert.match(result.html, /2 unit/);
  } finally {
    await site.stop();
  }
});

test('staff inventory paginates rows and keeps the current page through inventory forms', async (t) => {
  const site = await startSite(await tempDatabase(t), { demo: true });
  try {
    const admin = new Client(site);
    assert.equal((await admin.login(demoAccounts.admin)).location, '/admin');

    const rowIds = (html) => [...html.matchAll(/href="\/admin\/alat\/(\d+)(?:\?halaman=\d+)?" aria-label="Edit /g)]
      .map((match) => match[1]);
    const first = await admin.request('/admin/alat');
    const second = await admin.request('/admin/alat?halaman=2');
    const third = await admin.request('/admin/alat?halaman=3');
    const pages = [first, second, third];
    assert.deepEqual(pages.map((response) => rowIds(response.html).length), [10, 10, 10]);
    assert.equal(new Set(pages.flatMap((response) => rowIds(response.html))).size, 30);
    assert.match(second.html, /Menampilkan <strong>11–20<\/strong> dari <strong>30<\/strong> alat/);
    assert.match(second.html, /aria-label="Halaman 2" aria-current=page/);

    const high = await admin.request('/admin/alat?halaman=999');
    assert.deepEqual(rowIds(high.html), rowIds(third.html));
    const invalid = await admin.request('/admin/alat?halaman=-2');
    assert.deepEqual(rowIds(invalid.html), rowIds(first.html));

    const editPath = '/admin/alat/' + rowIds(second.html)[0] + '?halaman=2';
    const form = await admin.request(editPath);
    assert.equal(form.status, 200);
    assert.match(form.html, /href="\/admin\/alat\?halaman=2">[\s\S]*Kembali ke inventaris/);

    const item = { name: 'Alat dari halaman kedua', description: 'Alat yang diperbarui di halaman kedua.', category: 'kit', active: '1' };
    const rejected = await admin.post(editPath, { ...item, total: '-1' });
    assert.equal(rejected.status, 422);
    assert.ok(rejected.html.includes('action="' + editPath + '"'));

    const saved = await admin.post(editPath, { ...item, total: '4' });
    assert.equal(saved.location, '/admin/alat?halaman=2&hasil=disimpan');

    const add = await admin.request('/admin/alat/baru?halaman=3');
    assert.match(add.html, /action="\/admin\/alat\?halaman=3"/);
    assert.match(add.html, /href="\/admin\/alat\?halaman=3">Batal/);
    const added = await admin.post('/admin/alat?halaman=3', { ...item, name: 'Alat tambahan untuk paginasi', total: '1' });
    assert.equal(added.location, '/admin/alat?halaman=3&hasil=disimpan');

    const last = await admin.request('/admin/alat?halaman=4');
    assert.equal(rowIds(last.html).length, 1);
    assert.match(last.html, /Menampilkan <strong>31<\/strong> dari <strong>31<\/strong> alat/);
  } finally {
    await site.stop();
  }
});

test('a kit reserves all components together and holds damaged returns until service is complete', async (t) => {
  const path = await tempDatabase(t);
  const site = await startSite(path, { demo: true });
  const inventory = await openInventory({ databasePath: path });
  try {
    const member = new Client(site);
    const other = new Client(site);
    const admin = new Client(site);
    await register(member, 'Tim Utama', 'utama@example.test');
    await register(other, 'Tim Cadangan', 'cadangan@example.test');
    assert.equal((await admin.login(demoAccounts.admin)).status, 303);
    assert.match((await admin.request('/admin')).html, /Dashboard Hari Ini/);
    assert.match((await member.request('/peminjaman')).html, /Jadwal saya/);

    const kit = await admin.post('/admin/kit', {
      title: 'Kit Pengukur Jarak',
      description: 'Latihan pengukuran jarak dan pengujian alat ukur di meja praktik.',
      'alat-0': '3', 'jumlah-0': '2', 'alat-1': '5', 'jumlah-1': '1', active: '1',
    });
    assert.equal(kit.status, 303, kit.html);
    const kitId = kit.location.match(/\/admin\/kit\/(\d+)/)[1];
    assert.match((await member.request('/kit/' + kitId)).html, /<strong>4<\/strong> paket lengkap tersedia/);

    const today = clubDate();
    const form = { start: today, due: today, purpose: 'Mengukur jarak di kelas robotik', quantity: '4' };
    for (const client of [member, other]) {
      const request = await client.post('/kit/' + kitId + '/pinjam', form);
      assert.equal(request.status, 303, request.html);
    }
    const memberHistory = await member.request('/peminjaman?status=pending');
    assert.equal((memberHistory.html.match(/id="pinjaman-\d+"/g) ?? []).length, 1);
    const ids = [loanId(memberHistory.html), loanId((await other.request('/peminjaman?status=pending')).html)];
    const action = (id, type) => admin.post('/admin/peminjaman/' + id + '/tindakan', { action: type });
    const decisions = await Promise.all(ids.map((id) => action(id, 'approve')));
    assert.deepEqual(decisions.map((response) => response.status).sort(), [303, 409]);
    const approvedId = ids[decisions.findIndex((response) => response.status === 303)];
    const pendingId = ids[decisions.findIndex((response) => response.status === 409)];
    assert.equal((await inventory.equipment(3)).available, 0);
    assert.equal((await inventory.equipment(5)).available, 0);
    assert.ok((await inventory.loanRequest(pendingId)).items.every((line) => line.status === 'pending'));

    const approved = await inventory.loanRequest(approvedId);
    assert.match((await admin.request('/admin?hari=ambil')).html, /Kit Pengukur Jarak/);
    assert.equal((await action(approved.items[1].id, 'pickup')).status, 303);
    assert.match((await admin.request('/admin?hari=kembali')).html, /Kit Pengukur Jarak/);
    assert.equal((await member.request('/admin?alat=3')).status, 403);
    assert.match((await admin.request('/admin?alat=3')).html, /Kit Pengukur Jarak/);
    const guest = new Client(site);
    assert.equal((await guest.request('/admin?alat=3')).location, '/masuk?lanjut=%2Fadmin%3Falat%3D3');
    await guest.request('/masuk?lanjut=%2Fadmin%3Falat%3D3');
    assert.equal((await guest.post('/masuk', { ...demoAccounts.admin, lanjut: '/admin?alat=3' })).location, '/admin?alat=3');
    const qr = await fetch(site.url + '/admin/alat/3/label.png', { headers: { Cookie: admin.cookie } });
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /^image\/png/);
    assert.equal(Buffer.from(await qr.arrayBuffer()).toString('hex', 0, 8), '89504e470d0a1a0a');

    const returnPath = '/admin/peminjaman/' + approvedId + '/pengembalian';
    assert.match((await admin.request(returnPath)).html, /Kondisi dan kelengkapan semua alat sudah diperiksa/);
    const [sensor, meter] = approved.items;
    const inspection = {
      diperiksa: '1',
      ['servis-' + sensor.id]: '1', ['catatan-' + sensor.id]: 'Satu konektor sensor perlu diganti.',
      ['servis-' + meter.id]: '0', ['catatan-' + meter.id]: 'Kabel lengkap.',
    };
    assert.equal((await admin.post(returnPath, { ...inspection, ['servis-' + meter.id]: '5' })).status, 422);
    assert.equal((await inventory.equipment(3)).available, 0);
    assert.equal((await inventory.equipment(3)).service, 0);
    const returned = await admin.post(returnPath, inspection);
    assert.equal(returned.status, 303, returned.html);
    assert.equal((await admin.post(returnPath, inspection)).status, 409);
    assert.equal((await inventory.equipment(3)).available, 7);
    assert.equal((await inventory.equipment(3)).service, 1);
    assert.equal((await inventory.equipment(5)).available, 4);
    assert.match((await admin.request('/admin/servis')).html, /Satu konektor sensor perlu diganti/);
    assert.equal((await action(pendingId, 'approve')).status, 409);
    const completed = await admin.post('/admin/servis/' + sensor.id + '/selesai');
    assert.equal(completed.status, 303);
    assert.equal((await inventory.equipment(3)).available, 8);
    assert.match((await admin.request('/admin/servis?status=selesai')).html, /Satu konektor sensor perlu diganti/);
    assert.equal((await action(pendingId, 'approve')).status, 303);
  } finally {
    await inventory.close();
    await site.stop();
  }
});

test('members publish a finished project with a photo and staff can plan team needs', async (t) => {
  const site = await startSite(await tempDatabase(t), { demo: true });
  try {
    const admin = new Client(site);
    const member = new Client(site);
    const other = new Client(site);
    await register(member, 'Pembuat Rakitan', 'pembuat@example.test');
    await register(other, 'Anggota Lain', 'lain@example.test');
    assert.equal((await admin.login(demoAccounts.admin)).status, 303);
    assert.equal((await admin.request('/admin')).status, 200);
    const today = clubDate();
    const form = { quantity: '1', start: today, due: today, purpose: 'Sensor kelembapan untuk ruang praktik' };
    assert.equal((await member.post('/alat/3/pinjam', form)).status, 303);
    const id = loanId((await member.request('/peminjaman')).html);
    for (const action of ['approve', 'pickup', 'return']) {
      assert.equal((await admin.post('/admin/peminjaman/' + id + '/tindakan', { action })).status, 303);
    }
    const publication = { pinjaman: String(id), title: 'Pemantau Jarak Klub', description: 'Pengujian jarak pada lintasan latihan klub.', publik: '1' };
    assert.equal((await other.post('/galeri/bagikan', publication)).status, 404);
    const data = new FormData();
    for (const [name, value] of Object.entries({ ...publication, _csrf: member.csrf })) data.append(name, value);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/azru1IAAAAASUVORK5CYII=', 'base64');
    data.append('photo', new File([png], 'rakitan.png', { type: 'image/png' }));
    const created = await fetch(site.url + '/galeri/bagikan', { method: 'POST', redirect: 'manual', headers: { Cookie: member.cookie }, body: data });
    assert.equal(created.status, 303, await created.text());
    const path = created.headers.get('location').split('?')[0];
    assert.match((await other.request(path)).html, /Pinjam alat proyek ini/);
    const image = await fetch(site.url + path + '/foto');
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await other.post(path + '/hapus')).status, 403);
    assert.equal((await other.post(path + '/pinjam', form)).status, 303);
    assert.equal((await member.post(path + '/hapus')).status, 303);
    assert.equal((await other.request(path)).status, 404);
    assert.equal((await other.request(path + '/foto')).status, 404);

    const event = await admin.post('/admin/kegiatan', { name: 'Latihan tim robot', date: shiftDate(today, 7) });
    assert.equal(event.status, 303, event.html);
    const eventPath = event.location.split('?')[0];
    assert.equal((await member.request(eventPath)).status, 403);
    for (const team of ['Tim Alfa', 'Tim Beta']) {
      const need = await admin.post(eventPath + '/kebutuhan', { team, alat: '3', quantity: '5' });
      assert.equal(need.status, 303, need.html);
    }
    const plan = await admin.request(eventPath);
    assert.match(plan.html, /10 dibutuhkan · 8 tersedia/);
    assert.match(plan.html, /Kurang 2 unit/);
    assert.match(plan.html, /Tim Alfa/);
    assert.match(plan.html, /Tim Beta/);
  } finally {
    await site.stop();
  }
});

test('published club agendas show upcoming weekly dates and release announcements on schedule', async (t) => {
  const site = await startSite(await tempDatabase(t), { demo: true });
  try {
    const member = new Client(site);
    const admin = new Client(site);
    const guest = new Client(site);
    assert.equal((await guest.request('/agenda')).location, '/masuk?lanjut=%2Fagenda');
    await register(member, 'Murid Robotik', 'murid@example.test');
    assert.equal((await admin.login(demoAccounts.admin)).status, 303);
    assert.equal((await admin.request('/admin/kegiatan')).status, 200);

    const today = clubDate();
    const training = {
      name: 'Latihan Mingguan Pengujian Sensor',
      kind: 'latihan',
      date: shiftDate(today, -6),
      repeat_until: shiftDate(today, 8),
      start_time: '15:30',
      end_time: '17:00',
      location: 'Lab Tim Barat',
      description: 'Bawa laptop dan catatan hasil percobaan.',
      published: '1',
    };
    assert.equal((await member.post('/admin/kegiatan', training)).status, 403);
    const invalidTime = await admin.post('/admin/kegiatan', { ...training, end_time: '15:00' });
    assert.equal(invalidTime.status, 422);
    assert.match(invalidTime.html, /pilih waktu setelah jam mulai/);
    assert.equal((await admin.post('/admin/kegiatan', { ...training, repeat_until: today })).status, 422);

    const saved = await admin.post('/admin/kegiatan', training);
    assert.equal(saved.status, 303, saved.html);
    const eventPath = saved.location.split('?')[0];
    const eventId = eventPath.split('/').at(-1);
    const need = await admin.post(eventPath + '/kebutuhan', { team: 'Rencana Internal Tim Barat', alat: '3', quantity: '2' });
    assert.equal(need.status, 303);

    for (const event of [
      { name: 'Lomba Robot Kabupaten', kind: 'lomba', date: shiftDate(today, 9), published: '1' },
      { name: 'Latihan Draf Tim Inti', kind: 'latihan', date: today },
      { name: 'Pengumuman Pendaftaran Besok', kind: 'pengumuman', date: shiftDate(today, 1), description: 'Informasi pendaftaran tim.', published: '1' },
      { name: 'Pengumuman Pertemuan Hari Ini', kind: 'pengumuman', date: today, description: 'Temui pengurus sebelum latihan.', published: '1' },
      { name: 'Lomba Yang Sudah Selesai', kind: 'lomba', date: shiftDate(today, -1), published: '1' },
    ]) {
      const response = await admin.post('/admin/kegiatan', event);
      assert.equal(response.status, 303, response.html);
    }

    const dashboard = await member.request('/peminjaman');
    assert.match(dashboard.html, /Agenda klub/);
    assert.match(dashboard.html, /Latihan Mingguan Pengujian Sensor/);
    assert.match(dashboard.html, /Pengumuman Pertemuan Hari Ini/);
    const agenda = await member.request('/agenda');
    assert.match(agenda.html, new RegExp('id="kegiatan-' + eventId + '"[\\s\\S]*?datetime="' + shiftDate(today, 1) + '"'));
    assert.match(agenda.html, /15\.30–17\.00 WIB/);
    assert.match(agenda.html, /Lab Tim Barat/);
    assert.match(agenda.html, /Lomba Robot Kabupaten/);
    assert.match(agenda.html, /Pengumuman Pertemuan Hari Ini/);
    assert.doesNotMatch(agenda.html, /Latihan Draf Tim Inti|Pengumuman Pendaftaran Besok|Rencana Internal Tim Barat|Lomba Yang Sudah Selesai/);

    assert.equal((await admin.post(eventPath, { ...training, published: '0' })).status, 303);
    assert.doesNotMatch((await member.request('/agenda')).html, /Latihan Mingguan Pengujian Sensor/);
    assert.match((await admin.request(eventPath)).html, /Rencana Internal Tim Barat/);
  } finally {
    await site.stop();
  }
});
