import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './domain.js';

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiration ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('mikrokontroler', 'motor', 'sensor', 'kit', 'perkakas')),
    description TEXT NOT NULL,
    image TEXT,
    total INTEGER NOT NULL CHECK (total BETWEEN 0 AND 999),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
    start_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'borrowed', 'returned', 'declined', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS loans_equipment_status ON loans(equipment_id, status);
  CREATE INDEX IF NOT EXISTS loans_user ON loans(user_id);

  CREATE TABLE IF NOT EXISTS metadata (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE VIEW IF NOT EXISTS inventory AS
    SELECT equipment.*,
      COALESCE(holds.reserved, 0) AS reserved,
      COALESCE(holds.borrowed, 0) AS borrowed,
      equipment.total - COALESCE(holds.reserved, 0) AS available
    FROM equipment
    LEFT JOIN (
      SELECT equipment_id, SUM(quantity) AS reserved,
        SUM(CASE WHEN status = 'borrowed' THEN quantity ELSE 0 END) AS borrowed
      FROM loans
      WHERE status IN ('approved', 'borrowed')
      GROUP BY equipment_id
    ) AS holds ON holds.equipment_id = equipment.id;
`;

const staffActions = new Map([
  ['approve', { from: 'pending', to: 'approved' }],
  ['decline', { from: 'pending', to: 'declined' }],
  ['pickup', { from: 'approved', to: 'borrowed' }],
  ['cancel', { from: 'approved', to: 'cancelled' }],
  ['return', { from: 'borrowed', to: 'returned' }],
]);

const loanDetails = `
  SELECT loans.*, equipment.name AS equipment_name, equipment.category,
    equipment.image, equipment.active AS equipment_active,
    users.name AS borrower, users.email AS borrower_email
  FROM loans
  JOIN equipment ON equipment.id = loans.equipment_id
  JOIN users ON users.id = loans.user_id
`;

export function openInventory(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    db.exec(schema);
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    user: db.prepare('SELECT * FROM users WHERE email = ?'),
    createUser: db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id'),
    session: db.prepare(`
      SELECT sessions.user_id, sessions.csrf_token, users.name, users.role
      FROM sessions LEFT JOIN users ON users.id = sessions.user_id
      WHERE token_hash = ? AND expires_at > ?
    `),
    createSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    expireSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    catalog: db.prepare('SELECT * FROM inventory WHERE active = 1 ORDER BY id'),
    inventory: db.prepare('SELECT * FROM inventory ORDER BY active DESC, name COLLATE NOCASE, id'),
    equipment: db.prepare('SELECT * FROM inventory WHERE id = ?'),
    addEquipment: db.prepare(`
      INSERT INTO equipment (name, category, description, total, active, image)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `),
    updateEquipment: db.prepare(`
      UPDATE equipment SET name = ?, category = ?, description = ?, total = ?, active = ? WHERE id = ?
    `),
    loan: db.prepare('SELECT * FROM loans WHERE id = ?'),
    addLoan: db.prepare(`
      INSERT INTO loans (equipment_id, user_id, quantity, start_date, due_date, purpose, status)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `),
    setLoanStatus: db.prepare('UPDATE loans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
    memberLoans: db.prepare(loanDetails + ' WHERE loans.user_id = ? ORDER BY loans.updated_at DESC, loans.id DESC'),
    adminLoans: db.prepare(loanDetails + ' ORDER BY loans.updated_at DESC, loans.id DESC'),
    metadata: db.prepare('SELECT value FROM metadata WHERE name = ?'),
    setMetadata: db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)'),
  };

  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function findEquipment(id) {
    const item = statements.equipment.get(id);
    if (!item) throw new AppError(404, 'Alat ini tidak ditemukan.');
    return item;
  }

  function findLoan(id) {
    const loan = statements.loan.get(id);
    if (!loan) throw new AppError(404, 'Peminjaman ini tidak ditemukan.');
    return loan;
  }

  function addEquipment(item) {
    return statements.addEquipment.get(
      item.name, item.category, item.description, item.total, item.active, item.image ?? null,
    ).id;
  }

  function addLoan(itemId, userId, form, status = 'pending') {
    return statements.addLoan.get(itemId, userId, form.quantity, form.start, form.due, form.purpose, status).id;
  }

  return {
    close: () => db.close(),
    ready: () => db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get(),
    transaction,
    userByEmail: (email) => statements.user.get(email),
    createUser: (name, email, passwordHash, role) => statements.createUser.get(name, email, passwordHash, role).id,
    findSession: (hash, now) => statements.session.get(hash, now),
    storeSession: (hash, userId, csrf, expires) => statements.createSession.run(hash, userId, csrf, expires),
    deleteSession: (hash) => statements.deleteSession.run(hash),
    expireSessions: (now) => statements.expireSessions.run(now),
    catalog: () => statements.catalog.all(),
    inventory: () => statements.inventory.all(),
    equipment: findEquipment,
    addEquipment,
    updateEquipment(id, form) {
      transaction(() => {
        const item = findEquipment(id);
        if (form.total < item.reserved) {
          throw new AppError(409, `Total stok minimal ${item.reserved} unit karena unit itu sedang dipinjam atau dipesan.`);
        }
        statements.updateEquipment.run(form.name, form.category, form.description, form.total, form.active, id);
      });
    },
    memberLoans: (userId) => statements.memberLoans.all(userId),
    adminLoans: () => statements.adminLoans.all(),
    addLoan,
    requestLoan(itemId, userId, form) {
      return transaction(() => {
        const item = findEquipment(itemId);
        if (!item.active) throw new AppError(404, 'Alat ini tidak tersedia di katalog.');
        if (form.quantity > item.available) {
          throw new AppError(409, 'Stok berubah. Periksa jumlah unit yang tersedia dan coba lagi.');
        }
        return addLoan(itemId, userId, form);
      });
    },
    cancelLoan(id, userId) {
      transaction(() => {
        const loan = findLoan(id);
        if (loan.user_id !== userId) throw new AppError(404, 'Peminjaman ini tidak ditemukan.');
        if (loan.status !== 'pending' && loan.status !== 'approved') {
          throw new AppError(409, 'Pengajuan ini tidak bisa dibatalkan.');
        }
        statements.setLoanStatus.run('cancelled', id);
      });
    },
    advanceLoan(id, action, today) {
      const transition = staffActions.get(action);
      if (!transition) throw new AppError(400, 'Tindakan peminjaman tidak dikenal.');

      transaction(() => {
        const loan = findLoan(id);
        if (loan.status !== transition.from) {
          throw new AppError(409, 'Status pengajuan sudah berubah. Muat ulang daftar peminjaman.');
        }
        if (action === 'approve') {
          const item = findEquipment(loan.equipment_id);
          if (loan.due_date < today) throw new AppError(409, 'Tanggal kembali pengajuan ini sudah lewat.');
          if (!item.active || item.available < loan.quantity) {
            throw new AppError(409, 'Stok yang dapat dipinjam belum cukup untuk menyetujui pengajuan ini.');
          }
        }
        if (action === 'pickup' && (today < loan.start_date || today > loan.due_date)) {
          throw new AppError(409, 'Catat pengambilan dalam rentang tanggal pinjaman.');
        }
        statements.setLoanStatus.run(transition.to, id);
      });
      return transition.to;
    },
    hasMetadata: (name) => Boolean(statements.metadata.get(name)),
    setMetadata: (name, value) => statements.setMetadata.run(name, value),
  };
}
