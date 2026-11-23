import { AppError, asText, shiftDate, validDate } from './domain.js';

export const eventKinds = {
  latihan: { label: 'Latihan', tone: 'green', glyph: 'cpu' },
  lomba: { label: 'Lomba', tone: 'amber', glyph: 'trophy' },
  kegiatan: { label: 'Kegiatan', tone: 'blue', glyph: 'calendar-days' },
  pengumuman: { label: 'Pengumuman', tone: 'red', glyph: 'megaphone' },
};

const dayLabel = new Intl.DateTimeFormat('id-ID', { weekday: 'long', timeZone: 'UTC' });
const weekMilliseconds = 7 * 86400000;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export function eventForm(body, event) {
  const form = {
    name: asText(body.name ?? event?.name),
    event_date: asText(body.date ?? event?.event_date),
    kind: asText(body.kind ?? event?.kind ?? 'kegiatan'),
    description: asText(body.description ?? event?.description),
    location: asText(body.location ?? event?.location),
    start_time: asText(body.start_time ?? event?.start_time),
    end_time: asText(body.end_time ?? event?.end_time),
    repeat_until: asText(body.repeat_until ?? event?.repeat_until),
    published: Object.hasOwn(body, 'kind') ? Number(body.published === '1') : event?.published ?? 0,
  };
  if (form.kind === 'pengumuman') {
    Object.assign(form, { location: '', start_time: '', end_time: '', repeat_until: '' });
  }
  return form;
}

export function validateEvent(form) {
  if (form.name.length < 3 || form.name.length > 90 || !validDate(form.event_date) || !Object.hasOwn(eventKinds, form.kind)) {
    throw new AppError(422, 'Isi judul (3–90 karakter), jenis agenda, dan tanggal yang valid.');
  }
  if (form.description.length > 1800 || form.location.length > 120) {
    throw new AppError(422, 'Batasi detail agenda hingga 1800 karakter dan lokasi hingga 120 karakter.');
  }
  if (form.kind === 'pengumuman' && form.description.length < 5) {
    throw new AppError(422, 'Tulis isi pengumuman minimal 5 karakter.');
  }
  if ((form.start_time && !timePattern.test(form.start_time)) ||
      (form.end_time && (!timePattern.test(form.end_time) || !form.start_time || form.end_time <= form.start_time))) {
    throw new AppError(422, 'Isi jam mulai yang valid. Jika jam selesai diisi, pilih waktu setelah jam mulai.');
  }
  if (form.repeat_until && (!validDate(form.repeat_until) || form.repeat_until < shiftDate(form.event_date, 7))) {
    throw new AppError(422, 'Tanggal terakhir latihan mingguan harus minimal satu minggu setelah tanggal pertama.');
  }
  return form;
}

export function nextEventDate(event, today) {
  if (event.event_date >= today) return event.event_date;
  if (!event.repeat_until || event.repeat_until < today) return null;
  const weeks = Math.ceil((Date.parse(today) - Date.parse(event.event_date)) / weekMilliseconds);
  const next = shiftDate(event.event_date, weeks * 7);
  return next <= event.repeat_until ? next : null;
}

export function agendaData(events, today) {
  const upcoming = [];
  const announcements = [];
  for (const event of events) {
    if (!event.published) continue;
    if (event.kind === 'pengumuman') {
      if (event.event_date <= today) announcements.push(event);
    } else {
      const date = nextEventDate(event, today);
      if (date) upcoming.push({ ...event, date });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time) || a.id - b.id);
  announcements.sort((a, b) => b.event_date.localeCompare(a.event_date) || b.id - a.id);
  return { upcoming, announcements };
}

export function agendaTime(event) {
  if (!event.start_time) return '';
  const start = event.start_time.replace(':', '.');
  return (event.end_time ? start + '–' + event.end_time.replace(':', '.') : start) + ' WIB';
}

export function agendaDay(date) {
  return dayLabel.format(new Date(date + 'T00:00:00Z'));
}

export function eventVisibility(event, today) {
  if (!event.published) return { label: 'Draf', tone: 'muted' };
  if (event.kind === 'pengumuman' && event.event_date > today) return { label: 'Terjadwal', tone: 'amber' };
  if (event.kind !== 'pengumuman' && !nextEventDate(event, today)) return { label: 'Selesai', tone: 'muted' };
  return { label: 'Tayang', tone: 'green' };
}
