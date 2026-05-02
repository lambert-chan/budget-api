const router = require('express').Router()
const { pool } = require('../db/connection')

// GET /api/transactions
router.get('/', async (req, res) => {
  try {
    const {
      view = 'household',
      account_id, category_id, from, to,
      limit = 50, offset = 0,
    } = req.query

    let sql = `
      SELECT t.*,
             c.name  AS category_name,
             c.color AS category_color,
             c.scope AS category_scope,
             a.name  AS account_name,
             u.name  AS created_by_name,
             er.rate_to_cad
      FROM transactions t
      LEFT JOIN categories  c  ON t.category_id = c.id
      LEFT JOIN accounts    a  ON t.account_id  = a.id
      LEFT JOIN users       u  ON t.created_by  = u.id
      LEFT JOIN exchange_rates er ON t.currency = er.currency
      WHERE 1=1
    `
    const params = []

    switch (view) {
      case 'personal':
        sql += ' AND t.scope = "personal" AND t.created_by = ?'
        params.push(req.user.id)
        break
      case 'mine':
        sql += ' AND t.created_by = ?'
        params.push(req.user.id)
        break
      case 'all':
        sql += ' AND (t.scope = "shared" OR (t.scope = "personal" AND t.created_by = ?))'
        params.push(req.user.id)
        break
      case 'household':
      default:
        sql += ' AND t.scope = "shared"'
        break
    }

    if (account_id)  { sql += ' AND t.account_id  = ?'; params.push(account_id) }
    if (category_id) { sql += ' AND t.category_id = ?'; params.push(category_id) }
    if (from)        { sql += ' AND t.date >= ?';        params.push(from) }
    if (to)          { sql += ' AND t.date <= ?';        params.push(to) }

    sql += ' ORDER BY t.date DESC, t.created_at DESC LIMIT ? OFFSET ?'
    params.push(parseInt(limit), parseInt(offset))

    const [rows] = await pool.execute(sql, params)
    return res.json(rows)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Failed to fetch transactions' })
  }
})

// GET /api/transactions/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.*, c.name AS category_name, a.name AS account_name, u.name AS created_by_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts   a ON t.account_id  = a.id
       LEFT JOIN users      u ON t.created_by  = u.id
       WHERE t.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' })
    const t = rows[0]
    if (t.scope === 'personal' && t.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    return res.json(t)
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch transaction' })
  }
})

// Helper: look up rate and compute amount_cad
async function resolveAmountCad(currency, amount) {
  const cur = (currency || 'CAD').toUpperCase()
  if (cur === 'CAD') return parseFloat(amount)
  const [rates] = await pool.execute(
    'SELECT rate_to_cad FROM exchange_rates WHERE currency = ?', [cur]
  )
  if (!rates.length) throw new Error(`No exchange rate found for ${cur}. Add it in Settings first.`)
  return parseFloat(amount) * parseFloat(rates[0].rate_to_cad)
}

// POST /api/transactions
router.post('/', async (req, res) => {
  try {
    const {
      account_id, category_id, type, scope = 'shared',
      amount, currency = 'CAD', description, date, is_recurring,
    } = req.body

    if (!account_id || !type || !amount || !date) {
      return res.status(400).json({ error: 'account_id, type, amount, and date are required' })
    }

    const effectiveScope = type === 'income' ? 'shared' : scope
    const cur            = currency.toUpperCase().trim()

    let amount_cad
    try {
      amount_cad = await resolveAmountCad(cur, amount)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const [result] = await pool.execute(
      `INSERT INTO transactions
         (account_id, category_id, created_by, type, scope, amount, currency, amount_cad, description, date, is_recurring)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        account_id, category_id || null, req.user.id,
        type, effectiveScope, amount, cur, amount_cad.toFixed(2),
        description || null, date, is_recurring ? 1 : 0,
      ]
    )

    if (type !== 'transfer') {
      const delta = type === 'income' ? amount_cad : -amount_cad
      await pool.execute(
        'UPDATE accounts SET balance = balance + ? WHERE id = ?',
        [delta.toFixed(2), account_id]
      )
    }

    return res.status(201).json({ id: result.insertId, message: 'Transaction created' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Failed to create transaction' })
  }
})

// PUT /api/transactions/:id
router.put('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM transactions WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' })
    const t = rows[0]
    if (t.scope === 'personal' && t.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const {
      category_id, type, scope, amount,
      currency = t.currency, description, date,
    } = req.body

    const effectiveScope = type === 'income' ? 'shared' : (scope || t.scope)
    const cur            = currency.toUpperCase().trim()

    let amount_cad
    try {
      amount_cad = await resolveAmountCad(cur, amount)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    await pool.execute(
      `UPDATE transactions
       SET category_id=?, type=?, scope=?, amount=?, currency=?, amount_cad=?, description=?, date=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [category_id || null, type, effectiveScope, amount, cur, amount_cad.toFixed(2), description || null, date, req.params.id]
    )

    return res.json({ message: 'Transaction updated' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update transaction' })
  }
})

// DELETE /api/transactions/:id
router.delete('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM transactions WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' })
    const t = rows[0]
    if (t.scope === 'personal' && t.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (t.type !== 'transfer') {
      const delta = t.type === 'income' ? -t.amount_cad : t.amount_cad
      await pool.execute(
        'UPDATE accounts SET balance = balance + ? WHERE id = ?',
        [delta, t.account_id]
      )
    }

    await pool.execute('DELETE FROM transactions WHERE id = ?', [req.params.id])
    return res.json({ message: 'Transaction deleted' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete transaction' })
  }
})

module.exports = router
