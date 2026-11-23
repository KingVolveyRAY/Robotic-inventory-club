import * as lucide from 'lucide-static/dist/esm/lucide-static.mjs';
import { categories, categoryById } from './domain.js';

export function icon(name, size = 20) {
  const symbol = name.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return lucide[symbol].replace('<svg', '<svg aria-hidden="true" focusable="false"')
    .replace('width="24"', `width="${size}"`).replace('height="24"', `height="${size}"`);
}

export const sorts = [
  { id: '', label: 'Urutan katalog' },
  { id: 'nama', label: 'Nama A–Z' },
  { id: 'stok', label: 'Stok terbanyak' },
  { id: 'terbaru', label: 'Terbaru' },
];

const compareName = new Intl.Collator('id-ID', { sensitivity: 'base' }).compare;
const inventoryPageSize = 10;

export function catalogData(items, query) {
  const search = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
  const category = typeof query.kategori === 'string' && Object.hasOwn(categoryById, query.kategori) ? query.kategori : '';
  const sort = sorts.find((option) => option.id === query.urut)?.id ?? '';
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = items.filter((item) => {
    if (category && item.category !== category) return false;
    const text = `${item.name} ${item.description} ${categoryById[item.category].name}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });

  if (sort === 'nama') visible.sort((a, b) => compareName(a.name, b.name));
  if (sort === 'stok') visible.sort((a, b) => b.available - a.available);
  if (sort === 'terbaru') visible.sort((a, b) => b.id - a.id);

  return {
    items: visible, search, category, sort,
    filters: [{ id: '', name: 'Semua Alat', icon: 'layout-grid' }, ...categories],
    stats: [
      { name: 'Jenis Alat', value: items.length, icon: 'boxes', tone: 'blue' },
      { name: 'Unit Tersedia', value: items.reduce((sum, item) => sum + item.available, 0), icon: 'package-check', tone: 'green' },
      { name: 'Unit Dipinjam', value: items.reduce((sum, item) => sum + item.borrowed, 0), icon: 'arrow-left-right', tone: 'amber' },
    ],
    catalogLink(nextCategory) {
      const parameters = new URLSearchParams();
      if (search) parameters.set('q', search);
      if (nextCategory) parameters.set('kategori', nextCategory);
      if (sort) parameters.set('urut', sort);
      return (parameters.size ? '/?' + parameters : '/') + '#katalog';
    },
  };
}

export function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join('').toUpperCase();
}

export function inventoryPageNumber(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return 1;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 1;
}

export function inventoryPageQuery(number, result) {
  const parameters = new URLSearchParams();
  if (number > 1) parameters.set('halaman', number);
  if (result) parameters.set('hasil', result);
  return parameters.size ? '?' + parameters : '';
}

export function inventoryPagination(total, requested) {
  const pageCount = Math.max(1, Math.ceil(total / inventoryPageSize));
  const number = Math.min(inventoryPageNumber(requested), pageCount);
  const offset = (number - 1) * inventoryPageSize;
  const numbers = pageCount <= 5
    ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : [...new Set([1, number - 1, number, number + 1, pageCount])]
      .filter((page) => page >= 1 && page <= pageCount);
  return {
    total, number, pageCount, numbers, offset, limit: inventoryPageSize,
    first: total ? offset + 1 : 0,
    last: Math.min(offset + inventoryPageSize, total),
  };
}
