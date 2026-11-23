export const categories = [
  { id: 'mikrokontroler', name: 'Mikrokontroler', icon: 'cpu' },
  { id: 'motor', name: 'Motor & Aktuator', icon: 'cog' },
  { id: 'sensor', name: 'Sensor', icon: 'radio' },
  { id: 'kit', name: 'Kit Robotik', icon: 'bot' },
  { id: 'perkakas', name: 'Perkakas', icon: 'wrench' },
];

export const categoryById = Object.fromEntries(categories.map((category) => [category.id, category]));

export const statuses = {
  pending: { label: 'Menunggu', tone: 'amber', icon: 'clock-3' },
  approved: { label: 'Siap diambil', tone: 'blue', icon: 'calendar-check' },
  borrowed: { label: 'Dipinjam', tone: 'blue', icon: 'hand-helping' },
  returned: { label: 'Dikembalikan', tone: 'green', icon: 'circle-check' },
  declined: { label: 'Ditolak', tone: 'red', icon: 'circle-x' },
  cancelled: { label: 'Dibatalkan', tone: 'muted', icon: 'circle-minus' },
};

export const memberTabs = [
  { id: 'all', label: 'Semua' },
  { id: 'active', label: 'Aktif' },
  { id: 'history', label: 'Riwayat' },
];

export const staffTabs = [
  { id: 'pending', label: 'Menunggu' },
  { id: 'approved', label: 'Siap diambil' },
  { id: 'borrowed', label: 'Dipinjam' },
  { id: 'history', label: 'Riwayat' },
];

export const historyStatuses = new Set(['returned', 'declined', 'cancelled']);
export const ADMIN_USERNAME = 'adminpeminjaman';
export const MAX_LOAN_DAYS = 14;
export const MAX_ADVANCE_DAYS = 30;

const jakartaCalendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' });
const dateLabel = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function clubDate(now = new Date()) {
  return jakartaCalendar.format(now);
}

export function shiftDate(value, days) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function formatDate(value) {
  return dateLabel.format(new Date(value + 'T00:00:00Z'));
}

export function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeEmail(value) {
  return asText(value).toLowerCase();
}

export function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function recordId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) {
    throw new AppError(404, 'Data yang kamu cari tidak ditemukan.');
  }
  return Number(value);
}

export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

export function bundleAvailability(parts) {
  if (!parts.length) return 0;
  return Math.max(0, Math.min(...parts.map((part) => part.equipment_active ? Math.floor(part.available / part.quantity) : 0)));
}

export function validateReturnInspection(line, body) {
  const value = asText(body[`servis-${line.id}`]);
  const note = asText(body[`catatan-${line.id}`]);
  const quantity = Number(value);
  if (!/^\d{1,3}$/.test(value) || quantity > line.quantity) {
    throw new AppError(422, `Isi jumlah unit yang perlu servis untuk ${line.equipment_name} (0–${line.quantity}).`);
  }
  if (note.length > 300 || (quantity && note.length < 3)) {
    throw new AppError(422, `Tulis kondisi atau kelengkapan ${line.equipment_name} (3–300 karakter jika perlu servis).`);
  }
  return { quantity, note };
}

export function validateLoan(body, today) {
  const start = asText(body.start);
  const due = asText(body.due);
  const purpose = asText(body.purpose);
  const quantityText = asText(body.quantity);
  const quantity = Number(quantityText);

  if (!/^\d{1,3}$/.test(quantityText) || quantity < 1) {
    throw new AppError(422, 'Jumlah pinjaman harus berupa angka antara 1 dan 999.');
  }
  if (!validDate(start) || start < today || start > shiftDate(today, MAX_ADVANCE_DAYS)) {
    throw new AppError(422, 'Pilih tanggal ambil dari hari ini hingga 30 hari ke depan.');
  }
  if (!validDate(due) || due < start || due > shiftDate(start, MAX_LOAN_DAYS - 1)) {
    throw new AppError(422, 'Tanggal kembali harus sama atau setelah tanggal ambil, dengan durasi maksimal 14 hari.');
  }
  if (purpose.length < 5 || purpose.length > 300) {
    throw new AppError(422, 'Tulis keperluan peminjaman (5–300 karakter).');
  }
  return { quantity, start, due, purpose };
}

export function validateEquipment(body) {
  const name = asText(body.name);
  const category = asText(body.category);
  const description = asText(body.description);
  const totalText = asText(body.total);
  const total = Number(totalText);
  const active = body.active === '1' ? 1 : 0;

  if (name.length < 2 || name.length > 100) {
    throw new AppError(422, 'Isi nama alat (2–100 karakter).');
  }
  if (!Object.hasOwn(categoryById, category)) {
    throw new AppError(422, 'Pilih kategori alat.');
  }
  if (description.length < 10 || description.length > 500) {
    throw new AppError(422, 'Isi deskripsi alat (10–500 karakter).');
  }
  if (!/^\d{1,3}$/.test(totalText) || total > 999) {
    throw new AppError(422, 'Total stok harus berupa angka antara 0 dan 999.');
  }
  return { name, category, description, total, active };
}
