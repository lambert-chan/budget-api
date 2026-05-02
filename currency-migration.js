/**
 * Run once on the server to add currency support.
 * Upload to ~/nodejs/budget-api/ then run:
 *   source ~/nodevenv/nodejs/budget-api/20/bin/activate
 *   node currency-migration.js
 */
require('dotenv').config()
const { pool, testConnection } = require('./db/connection')

async function migrate() {
  await testConnection()

  // 1. exchange_rates table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      currency    VARCHAR(3)    NOT NULL UNIQUE,
      rate_to_cad DECIMAL(12,6) NOT NULL DEFAULT 1.000000,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `)
  console.log('✓ exchange_rates table ready')

  // 2. Seed CAD as base (always 1:1)
  await pool.execute(
    `INSERT IGNORE INTO exchange_rates (currency, rate_to_cad) VALUES ('CAD', 1.000000)`
  )

  // 3. Add currency + amount_cad columns to transactions if missing
  const [cols] = await pool.execute(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
  `)
  const colNames = cols.map(c => c.COLUMN_NAME)

  if (!colNames.includes('currency')) {
    await pool.execute(
      `ALTER TABLE transactions ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'CAD' AFTER amount`
    )
    console.log('✓ Added currency column to transactions')
  } else {
    console.log('  currency column already exists, skipping')
  }

  if (!colNames.includes('amount_cad')) {
    await pool.execute(
      `ALTER TABLE transactions ADD COLUMN amount_cad DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER currency`
    )
    // Backfill — all existing transactions assumed CAD
    await pool.execute(`UPDATE transactions SET amount_cad = amount WHERE 1=1`)
    console.log('✓ Added amount_cad column, backfilled existing rows as CAD')
  } else {
    console.log('  amount_cad column already exists, skipping')
  }

  console.log('\n✓ Migration complete.')
  process.exit(0)
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
