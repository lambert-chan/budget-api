require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, testConnection } = require('../db/connection');
const { runMigrations } = require('../db/schema');

async function seed() {
  await testConnection();
  await runMigrations();

  const users = [
    {
      name:     process.env.SEED_USER_A_NAME,
      email:    process.env.SEED_USER_A_EMAIL,
      password: process.env.SEED_USER_A_PASSWORD,
      role:     'owner',
    },
    {
      name:     process.env.SEED_USER_B_NAME,
      email:    process.env.SEED_USER_B_EMAIL,
      password: process.env.SEED_USER_B_PASSWORD,
      role:     'member',
    },
  ];

  for (const u of users) {
    if (!u.name || !u.email || !u.password) {
      console.error(`✗ Missing env vars for user "${u.name || u.email}" — check your .env`);
      process.exit(1);
    }
    if (u.password.length < 8) {
      console.error(`✗ Password for ${u.email} must be at least 8 characters`);
      process.exit(1);
    }

    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE email = ?', [u.email.toLowerCase()]
    );
    if (existing.length) {
      console.log(`  ↷ User ${u.email} already exists, skipping`);
      continue;
    }

    const hash = await bcrypt.hash(u.password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
      [u.name, u.email.toLowerCase(), hash, u.role]
    );

    // Create a default $0 allocation entry for each user
    await pool.execute(
      'INSERT INTO allocations (user_id, amount) VALUES (?,?)',
      [result.insertId, 0]
    );

    console.log(`✓ Created user: ${u.name} <${u.email}> (${u.role})`);
  }

  // Seed a default household checking account if none exist
  const [accounts] = await pool.execute('SELECT COUNT(*) AS cnt FROM accounts');
  if (accounts[0].cnt === 0) {
    await pool.execute(
      'INSERT INTO accounts (name, type, balance) VALUES (?,?,?)',
      ['Household Checking', 'checking', 0]
    );
    console.log('✓ Created default account: Household Checking');
  }

  console.log('\nSetup complete. Update allocations via PUT /api/allocations/:user_id');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
