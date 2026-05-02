const router = require('express').Router()
const { pool } = require('../db/connection')

// GET /api/exchange-rates — list all rates
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM exchange_rates ORDER BY currency'
    )
    return res.json(rows)
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch exchange rates' })
  }
})

// POST /api/exchange-rates — add or update a currency rate
router.post('/', async (req, res) => {
  try {
    const { currency, rate_to_cad } = req.body
    if (!currency || !rate_to_cad) {
      return res.status(400).json({ error: 'currency and rate_to_cad are required' })
    }

    const code = currency.toUpperCase().trim()
    if (!/^[A-Z]{3}$/.test(code)) {
      return res.status(400).json({ error: 'Currency must be a 3-letter ISO code e.g. USD' })
    }
    if (code === 'CAD') {
      return res.status(400).json({ error: 'CAD is the base currency and cannot be changed' })
    }

    await pool.execute(
      `INSERT INTO exchange_rates (currency, rate_to_cad) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE rate_to_cad = VALUES(rate_to_cad), updated_at = CURRENT_TIMESTAMP`,
      [code, parseFloat(rate_to_cad)]
    )
    return res.status(201).json({ message: `Rate for ${code} saved` })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save exchange rate' })
  }
})

// DELETE /api/exchange-rates/:currency
router.delete('/:currency', async (req, res) => {
  try {
    const code = req.params.currency.toUpperCase()
    if (code === 'CAD') {
      return res.status(400).json({ error: 'Cannot delete the base currency CAD' })
    }
    await pool.execute('DELETE FROM exchange_rates WHERE currency = ?', [code])
    return res.json({ message: `Rate for ${code} deleted` })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete exchange rate' })
  }
})

module.exports = router
