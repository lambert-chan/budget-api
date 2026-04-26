const { pool } = require('./connection');

/*
  Finance model:
  - Pooled income tracked as transactions with type='income', scope='shared'
  - Shared household expenses: type='expense', scope='shared'
  - Personal spending: type='expense', scope='personal', visible only to owner
  - Each user has a fixed monthly personal fund via the allocations table
  - Remainder = pooled income - shared expenses - allocations = household savings
*/

const statements = [
  // ── Users ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100)  NOT NULL,
    email         VARCHAR(255)  NOT NULL UNIQUE,
    password_hash VARCHAR(255)  NOT NULL,
    role          ENUM('owner','member') NOT NULL DEFAULT 'member',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  // ── Personal fund allocations (fixed monthly amount per user) ──────────────
  `CREATE TABLE IF NOT EXISTS allocations (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT           NOT NULL UNIQUE,
    amount      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    currency    VARCHAR(3)    NOT NULL DEFAULT 'USD',
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  // ── Accounts (household-wide, shared) ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS accounts (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100)  NOT NULL,
    type        ENUM('checking','savings','credit','cash') NOT NULL DEFAULT 'checking',
    balance     DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    currency    VARCHAR(3)    NOT NULL DEFAULT 'USD',
    created_by  INT           DEFAULT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`,

  // ── Categories (household-wide, shared) ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS categories (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100)  NOT NULL,
    type        ENUM('income','expense') NOT NULL,
    scope       ENUM('shared','personal','any') NOT NULL DEFAULT 'any',
    color       VARCHAR(7)    NOT NULL DEFAULT '#888888',
    icon        VARCHAR(50)   DEFAULT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // ── Transactions ───────────────────────────────────────────────────────────
  /*
    scope:
      'shared'   — household expense or pooled income. Visible to all users.
      'personal' — personal fund spending. Visible only to created_by user.

    type:
      'income'   — money coming in (always shared / pooled)
      'expense'  — money going out (shared or personal)
      'transfer' — between accounts (always shared)
  */
  `CREATE TABLE IF NOT EXISTS transactions (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    account_id    INT           NOT NULL,
    category_id   INT           DEFAULT NULL,
    created_by    INT           NOT NULL,
    type          ENUM('income','expense','transfer') NOT NULL,
    scope         ENUM('shared','personal')           NOT NULL DEFAULT 'shared',
    amount        DECIMAL(12,2) NOT NULL,
    description   VARCHAR(255)  DEFAULT NULL,
    date          DATE          NOT NULL,
    is_recurring  TINYINT(1)    NOT NULL DEFAULT 0,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id)  REFERENCES accounts(id)    ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id)  ON DELETE SET NULL,
    FOREIGN KEY (created_by)  REFERENCES users(id)       ON DELETE CASCADE
  )`,

  // ── Budgets (household-wide) ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS budgets (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    category_id  INT           NOT NULL,
    user_id      INT           DEFAULT NULL COMMENT 'NULL = household budget, set = personal budget',
    month        DATE          NOT NULL     COMMENT 'First day of the month e.g. 2025-01-01',
    amount       DECIMAL(12,2) NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_budget (category_id, user_id, month),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE
  )`,

  // ── Recurring entries ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS recurring_entries (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    account_id   INT           NOT NULL,
    category_id  INT           DEFAULT NULL,
    created_by   INT           NOT NULL,
    type         ENUM('income','expense') NOT NULL,
    scope        ENUM('shared','personal') NOT NULL DEFAULT 'shared',
    amount       DECIMAL(12,2) NOT NULL,
    description  VARCHAR(255)  DEFAULT NULL,
    frequency    ENUM('daily','weekly','monthly','yearly') NOT NULL DEFAULT 'monthly',
    next_date    DATE          NOT NULL,
    active       TINYINT(1)    NOT NULL DEFAULT 1,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id)  REFERENCES accounts(id)   ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by)  REFERENCES users(id)      ON DELETE CASCADE
  )`,
];

// Default categories seeded once
const defaultCategories = [
  // Shared income
  { name: 'Salary',         type: 'income',  scope: 'shared',   color: '#1D9E75' },
  { name: 'Other income',   type: 'income',  scope: 'shared',   color: '#0F6E56' },
  // Shared expenses
  { name: 'Mortgage / Rent',type: 'expense', scope: 'shared',   color: '#378ADD' },
  { name: 'Insurance',      type: 'expense', scope: 'shared',   color: '#185FA5' },
  { name: 'Utilities',      type: 'expense', scope: 'shared',   color: '#534AB7' },
  { name: 'Groceries',      type: 'expense', scope: 'shared',   color: '#7F77DD' },
  { name: 'Transport',      type: 'expense', scope: 'shared',   color: '#BA7517' },
  { name: 'Healthcare',     type: 'expense', scope: 'shared',   color: '#D85A30' },
  { name: 'Subscriptions',  type: 'expense', scope: 'shared',   color: '#0F6E56' },
  { name: 'Dining out',     type: 'expense', scope: 'shared',   color: '#993C1D' },
  { name: 'Holidays',       type: 'expense', scope: 'shared',   color: '#639922' },
  // Personal expenses
  { name: 'Clothing',       type: 'expense', scope: 'personal', color: '#D4537E' },
  { name: 'Hobbies',        type: 'expense', scope: 'personal', color: '#993556' },
  { name: 'Personal care',  type: 'expense', scope: 'personal', color: '#ED93B1' },
  { name: 'Personal misc',  type: 'expense', scope: 'personal', color: '#888780' },
];

async function runMigrations() {
  for (const sql of statements) {
    await pool.execute(sql);
  }

  // Seed default categories if table is empty
  const [existing] = await pool.execute('SELECT COUNT(*) AS cnt FROM categories');
  if (existing[0].cnt === 0) {
    for (const cat of defaultCategories) {
      await pool.execute(
        'INSERT INTO categories (name, type, scope, color) VALUES (?, ?, ?, ?)',
        [cat.name, cat.type, cat.scope, cat.color]
      );
    }
    console.log('✓ Default categories seeded');
  }

  console.log('✓ Database schema ready');
}

module.exports = { runMigrations };
