import { hashPassword, validPassword } from './auth.js';
import { clubDate, normalizeEmail, shiftDate, validEmail } from './domain.js';

export const demoAccounts = {
  member: { name: 'Alya Pratama', email: 'anggota@robolab.test', password: 'Demo-Anggota-2026!' },
  admin: { name: 'Pengurus RoboLab', email: 'pengurus@robolab.test', password: 'Demo-Pengurus-2026!' },
};

const demoEquipment = [
  {
    name: 'Arduino Uno R3', category: 'mikrokontroler', image: 'arduino-uno.webp', total: 8,
    description: 'Papan pengembangan ATmega328P untuk prototipe, praktik pemrograman, dan integrasi sensor.',
  },
  {
    name: 'Motor Servo MG996R', category: 'motor', image: 'servo-mg996r.webp', total: 6,
    description: 'Servo torsi tinggi dengan roda gigi logam untuk lengan robot dan mekanisme gerak.',
  },
  {
    name: 'Sensor Ultrasonik HC-SR04', category: 'sensor', image: 'sensor-hc-sr04.webp', total: 8,
    description: 'Sensor jarak ultrasonik untuk deteksi objek, navigasi, dan robot penghindar rintangan.',
  },
  {
    name: 'Kit Chassis Robot 4WD', category: 'kit', image: 'chassis-4wd.webp', total: 3,
    description: 'Rangka dasar robot empat roda dengan motor DC untuk proyek robot bergerak.',
  },
  {
    name: 'Multimeter Digital', category: 'perkakas', image: 'multimeter.webp', total: 4,
    description: 'Alat ukur portabel untuk memeriksa tegangan, arus, resistansi, serta kontinuitas rangkaian.',
  },
  {
    name: 'Stasiun Solder', category: 'perkakas', image: 'solder.webp', total: 2,
    description: 'Stasiun solder dengan pengaturan suhu untuk perakitan dan perbaikan komponen elektronik.',
  },
];

export async function prepareData(inventory, { demo, admin }) {
  const modeKey = demo ? 'mode:demo' : 'mode:live';
  const otherMode = demo ? 'mode:live' : 'mode:demo';
  inventory.transaction(() => {
    if (inventory.hasMetadata(otherMode)) {
      throw new Error('Gunakan database terpisah untuk mode demo dan inventaris klub.');
    }
    if (!inventory.hasMetadata(modeKey)) inventory.setMetadata(modeKey, '1');
  });

  if (demo) {
    await seedDemo(inventory);
  } else if (admin) {
    await seedAdmin(inventory, admin);
  }
}

async function seedAdmin(inventory, admin) {
  const email = normalizeEmail(admin.email);
  if (!validEmail(email) || !validPassword(admin.password, 12)) {
    throw new Error('Isi email pengurus yang valid dan kata sandi pengurus minimal 12 karakter (maksimal 128 byte).');
  }

  const existing = inventory.userByEmail(email);
  if (existing?.role === 'admin') return;
  const hash = await hashPassword(admin.password);
  inventory.transaction(() => {
    const user = inventory.userByEmail(email);
    if (user?.role === 'member') {
      throw new Error('Email pengurus awal sudah terdaftar sebagai anggota. Gunakan email lain.');
    }
    if (!user) inventory.createUser('Pengurus RoboLab', email, hash, 'admin');
  });
}

async function seedDemo(inventory) {
  if (inventory.hasMetadata('demo-seeded')) return;

  const [memberHash, adminHash] = await Promise.all([
    hashPassword(demoAccounts.member.password),
    hashPassword(demoAccounts.admin.password),
  ]);

  inventory.transaction(() => {
    if (inventory.hasMetadata('demo-seeded')) return;
    const member = inventory.createUser(demoAccounts.member.name, demoAccounts.member.email, memberHash, 'member');
    inventory.createUser(demoAccounts.admin.name, demoAccounts.admin.email, adminHash, 'admin');
    const ids = demoEquipment.map((item) => inventory.addEquipment({ ...item, active: 1 }));
    const date = clubDate();
    const examples = [
      { index: 0, quantity: 2, from: -2, to: 5, status: 'borrowed', purpose: 'Prototipe robot pengikut garis' },
      { index: 1, quantity: 2, from: 2, to: 8, status: 'approved', purpose: 'Pembuatan lengan robot untuk pameran' },
      { index: 3, quantity: 3, from: -5, to: 2, status: 'borrowed', purpose: 'Uji coba robot bergerak 4WD' },
      { index: 4, quantity: 1, from: 0, to: 4, status: 'pending', purpose: 'Memeriksa rangkaian catu daya' },
    ];
    for (const loan of examples) {
      inventory.addLoan(ids[loan.index], member, {
        quantity: loan.quantity,
        start: shiftDate(date, loan.from),
        due: shiftDate(date, loan.to),
        purpose: loan.purpose,
      }, loan.status);
    }
    inventory.setMetadata('demo-seeded', '1');
  });
}
