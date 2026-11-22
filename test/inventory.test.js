import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { clubDate, shiftDate } from '../src/domain.js';
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
      close();
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
    assert.equal((catalog.html.match(/class="equipment-card"/g) ?? []).length, 6);
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
    assert.match((await admin.request('/admin/alat')).html, /Modul Driver Motor/);
    assert.equal((await admin.post('/admin/alat/7', { ...item, active: '0' })).status, 303);
    assert.equal((await admin.request('/alat/7')).status, 404);
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
