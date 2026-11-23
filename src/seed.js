import { readFileSync } from 'node:fs';
import { eventForm } from './agenda.js';
import { hashPassword, validPassword } from './auth.js';
import { ADMIN_USERNAME, clubDate, normalizeEmail, shiftDate, validEmail } from './domain.js';
import { addMissingEquipment, equipmentSamples, expandedEquipment, starterEquipment } from './equipment-samples.js';

export const demoAccounts = {
  member: { name: 'Alya Pratama', email: 'anggota@robolab.test', password: 'Demo-Anggota-2026!' },
  admin: {
    name: 'Pengurus RoboLab',
    email: 'pengurus@robolab.test',
    username: ADMIN_USERNAME,
    password: 'Rakit-Robot-Bareng',
    passwordRevision: 1,
  },
};

const starterImages = new Set(starterEquipment.map((item) => item.image));

export async function prepareData(inventory, { demo, admin, sampleInventory }) {
  const modeKey = demo ? 'mode:demo' : 'mode:live';
  const otherMode = demo ? 'mode:live' : 'mode:demo';
  await inventory.transaction(async (database) => {
    if (await database.hasMetadata(otherMode)) {
      throw new Error('Gunakan database terpisah untuk mode demo dan inventaris klub.');
    }
    if (!await database.hasMetadata(modeKey)) await database.setMetadata(modeKey, '1');
  });

  if (demo) await seedDemo(inventory);
  else if (admin) await seedAdmin(inventory, admin);

  if (demo || sampleInventory) {
    await seedSampleCatalog(inventory, demo);
    await seedLabExamples(inventory, demo);
  }
  if (demo) await seedAgenda(inventory);
}

async function seedLabExamples(inventory, demo) {
  await inventory.transaction(async (database) => {
    if (await database.hasMetadata('sample-projects:v1')) return;
    const items = new Map((await database.inventory()).map((item) => [item.image, item]));
    const kits = [
      {
        title: 'Robot Hindar Rintangan',
        description: 'Rangkai rover yang membaca jarak di depannya dan mencoba jalur lain ketika menemui rintangan.',
        images: ['chassis-4wd.webp', 'arduino-uno.webp', 'sensor-hc-sr04.webp', 'driver-tb6612fng.webp', 'kabel-jumper-dupont.webp'],
      },
      {
        title: 'Stasiun Pemantauan Suhu',
        description: 'Buat prototipe pemantau suhu dan kelembapan ruangan dengan mikrokontroler dan sensor digital.',
        images: ['sensor-dht22.webp', 'esp32-devkit.webp', 'breadboard-830.webp', 'kabel-jumper-dupont.webp'],
      },
    ];
    if (!(await database.listKits(false)).length) {
      for (const kit of kits) {
        const components = kit.images.map((image) => items.get(image));
        if (!components.every((item) => item?.active)) continue;
        const parts = components.map((item) => ({ equipmentId: item.id, quantity: 1 }));
        await database.saveKit(null, { ...kit, active: 1, parts });
      }
    }
    if (demo) {
      const member = await database.userByEmail(demoAccounts.member.email);
      const exampleKit = kits[0];
      const components = exampleKit.images.map((image) => items.get(image));
      const today = clubDate();
      if (components.every(Boolean)) {
        const group = await database.addLoanGroup(exampleKit.title);
        const ids = [];
        for (const item of components) {
          ids.push(await database.addLoan(item.id, member.id, {
            quantity: 1, start: shiftDate(today, -7), due: shiftDate(today, -3), purpose: 'Uji navigasi rover di meja praktik',
          }, 'returned', group));
        }
        await database.addProject(ids[0], {
          title: 'Rover untuk lintasan rintangan',
          description: 'Contoh rakitan klub. Kelompok pertama menguji posisi sensor pada bagian depan rover dan mencatat keberhasilan robot melewati tiga rintangan di lintasan latihan.',
          photo: readFileSync(new URL('../public/images/rover-lab.webp', import.meta.url)),
          photoType: 'image/webp',
        }, today);
      }
      const distanceSensor = items.get('sensor-hc-sr04.webp');
      if (distanceSensor) {
        const event = await database.saveEvent(null, eventForm({ name: 'Praktikum Robot Bergerak', date: shiftDate(today, 7) }));
        await database.addEventNeed(event, 'Tim Rover', distanceSensor.id, 5);
        await database.addEventNeed(event, 'Tim Sensor', distanceSensor.id, 4);
      }
    }
    await database.setMetadata('sample-projects:v1', '1');
  });
}

async function seedAgenda(inventory) {
  await inventory.transaction(async (database) => {
    if (await database.hasMetadata('sample-agenda:v1')) return;
    const today = clubDate();
    const examples = [
      {
        name: 'Latihan sensor dan kendali motor', kind: 'latihan', date: shiftDate(today, 2),
        start_time: '15:30', end_time: '17:00', repeat_until: shiftDate(today, 30), location: 'Lab Robotik',
        description: 'Bawa laptop dan kabel USB. Kita akan mencoba sensor garis, lalu menguji kendali kecepatan motor bersama tim.',
      },
      {
        name: 'Simulasi lomba robot pengikut garis', kind: 'lomba', date: shiftDate(today, 16),
        start_time: '09:00', end_time: '12:00', location: 'Aula sekolah',
        description: 'Setiap tim membawa robot yang sudah diuji untuk menjalankan dua putaran lintasan.',
      },
      {
        name: 'Pendaftaran tim praktik dibuka', kind: 'pengumuman', date: today,
        description: 'Sampaikan nama tim dan pilihan proyek kepada pengurus saat latihan berikutnya.',
      },
    ];
    for (const example of examples) await database.saveEvent(null, eventForm({ ...example, published: '1' }));
    await database.setMetadata('sample-agenda:v1', '1');
  });
}

async function seedSampleCatalog(inventory, demo) {
  await inventory.transaction(async (database) => {
    if (await database.hasMetadata('sample-catalog:v2')) return;

    const items = await database.inventory();
    const previouslySeeded = await database.hasMetadata('sample-equipment-seeded');
    if (!demo && items.length && !(previouslySeeded && items.some((item) => starterImages.has(item.image)))) {
      return;
    }

    await addMissingEquipment(database, items, {
      samples: items.length ? expandedEquipment : equipmentSamples,
      sampleStock: true,
    });
    if (!demo && !previouslySeeded) await database.setMetadata('sample-equipment-seeded', '1');
    await database.setMetadata('sample-catalog:v2', '1');
  });
}

async function seedAdmin(inventory, { email: configuredEmail, password, passwordRevision = 0 }) {
  const email = normalizeEmail(configuredEmail);
  if (!validEmail(email) || !validPassword(password, 12)) {
    throw new Error('Isi email pengurus yang valid dan kata sandi pengurus minimal 12 karakter (maksimal 128 byte).');
  }

  await inventory.transaction(async (database) => {
    const user = await database.userByEmail(email);
    if (user?.role === 'member') {
      throw new Error('Email pengurus awal sudah terdaftar sebagai anggota. Gunakan email lain.');
    }

    const username = user?.username ?? (await database.adminByUsername(ADMIN_USERNAME) ? null : ADMIN_USERNAME);
    if (!user) {
      await database.createUser('Pengurus RoboLab', email, await hashPassword(password), 'admin', {
        username, passwordRevision,
      });
      return;
    }
    if (username && !user.username) await database.setAdminUsername(user.id, username);
    if (passwordRevision > user.password_revision) {
      await database.setAdminPassword(user.id, await hashPassword(password), passwordRevision);
      await database.deleteUserSessions(user.id);
    }
  });
}

async function seedDemo(inventory) {
  if (await inventory.hasMetadata('demo-seeded')) {
    await seedAdmin(inventory, demoAccounts.admin);
    return;
  }

  const [memberHash, adminHash] = await Promise.all([
    hashPassword(demoAccounts.member.password),
    hashPassword(demoAccounts.admin.password),
  ]);

  await inventory.transaction(async (database) => {
    if (await database.hasMetadata('demo-seeded')) return;
    const member = await database.createUser(demoAccounts.member.name, demoAccounts.member.email, memberHash, 'member');
    await database.createUser(demoAccounts.admin.name, demoAccounts.admin.email, adminHash, 'admin', {
      username: demoAccounts.admin.username,
      passwordRevision: demoAccounts.admin.passwordRevision,
    });
    const ids = [];
    for (const item of starterEquipment) {
      ids.push(await database.addEquipment({ ...item, active: 1 }));
    }
    const date = clubDate();
    const examples = [
      { index: 0, quantity: 2, from: -2, to: 5, status: 'borrowed', purpose: 'Prototipe robot pengikut garis' },
      { index: 1, quantity: 2, from: 2, to: 8, status: 'approved', purpose: 'Pembuatan lengan robot untuk pameran' },
      { index: 3, quantity: 3, from: -5, to: 2, status: 'borrowed', purpose: 'Uji coba robot bergerak 4WD' },
      { index: 4, quantity: 1, from: 0, to: 4, status: 'pending', purpose: 'Memeriksa rangkaian catu daya' },
    ];
    for (const loan of examples) {
      await database.addLoan(ids[loan.index], member, {
        quantity: loan.quantity,
        start: shiftDate(date, loan.from),
        due: shiftDate(date, loan.to),
        purpose: loan.purpose,
      }, loan.status);
    }
    await database.setMetadata('demo-seeded', '1');
  });
}
