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

  if (demo || sampleInventory) await seedSampleCatalog(inventory, demo);
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
