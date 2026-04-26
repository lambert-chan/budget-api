const router = require('express').Router();
const { pool } = require('../db/connection');

/*
  Visibility rules:
  - scope='shared'   → visible to ALL authenticated users
  - scope='personal' → visible ONLY to the user who created it (created_by = req.user.id)

  GET /api/transactions accepts:
    ?view=household  — shared transactions only (default)
    ?view=personal   — current user's personal transactions only
    ?view=mine       — all transactions created by current user (shared + personal)
    ?view=all        — shared + current user's personal (full picture for current user)
  Plus standard filters: account_id, category_id, from, to, limit, offset
*/

router.get('/', async (req, res) => {
  try {
    const {
      view = 'household',
      account_id, category_id, from, to,
      limit = 50, offset = 0,
    } = req.query;

    let sql = `
      SELECT t.*,
             c.name  AS category_name,
             c.color AS category_color,
             c.scope AS category_scope,
             a.name  AS account_name,
             u.name  AS created_by_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts   a ON t.account_id  = a.id
      LEFT JOIN users      u ON t.created_by  = u.id
      WHERE 1=1
    `;
    const params = [];

    // Scope visibility
    switch (view) {
      case 'personal':
        sql += ' AND t.scope = "personal" AND t.created_by = ?';
        params.push(req.user.id);
        break;
      case 'mine':
        sql += ' AND t.created_by = ?';
        params.push(req.user.id);
        break;
      case 'all':
        // Shared OR own personal
        sql += ' AND (t.scope = "shared" OR (t.scope = "personal" AND t.created_by = ?))';
        params.push(req.user.id);
        break;
      case 'household':
      default:
        sql += ' AND t.scope = "shared"';
        break;
    }

    if (account_id)  { sql += ' AND t.account_id  = ?'; params.push(account_id); }
    if (category_id) { sql += ' AND t.category_id = ?'; params.push(category_id); }
    if (from)        { sql += ' AND t.date >= ?';        params.push(from); }
    if (to)          { sql += ' AND t.date <= ?';        params.push(to); }

    sql += ' ORDER BY t.date DESC, t.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [rows] = await pool.execute(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

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
    );

    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = rows[0];
    // Personal transactions only visible to their owner
    if (t.scope === 'personal' && t.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json(t);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// POST /api/transactions
router.post('/', async (req, res) => {
  try {
    const {
      account_id, category_id, type, scope = 'shared',
      amount, description, date, is_recurring,
    } = req.body;

    if (!account_id || !type || !amount || !date) {
      return res.status(400).json({ error: 'account_id, type, amount, and date are required' });
    }

    // Income is always shared (pooled)
    const effectiveScope = type === 'income' ? 'shared' : scope;

    const [result] = await pool.execute(
      `INSERT INTO transactions
         (account_id, category_id, created_by, type, scope, amount, description, date, is_recurring)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        account_id, category_id || null, req.user.id,
        type, effectiveScope, amount,
        description || null, date, is_recurring ? 1 : 0,
      ]
    );

    // Update account balance
    if (type !== 'transfer') {
      const delta = type === 'income' ? amount : -amount;
      await pool.execute(
        'UPDATE accounts SET balance = balance + ? WHERE id = ?',
        [delta, account_id]
      );
    }

    return res.status(201).json({ id: result.insertId, message: 'Transaction created' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// PUT /api/transactions/:id
router.put('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM transactions WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = rows[0];
    if (t.scope === 'personal' && t.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const {
      category_id, type, scope, amount, description, date,
    } = req.body;

    const effectiveScope = type === 'income' ? 'shared' : (scope || t.scope);

    await pool.execute(
      `UPDATE transactions
       SET category_id=?, type=?, scope=?, amount=?, description=?, date=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [category_id || null, type, effectiveScope, amount, description || null, date, req.params.id]
    );

    return res.json({ message: 'Transaction updated' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM transactions WHERE id = ?', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const t = rows[0];
    if (t.scope === 'personal' && t.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (t.type !== 'transfer') {
      const delta = t.type === 'income' ? -t.amount : t.amount;
      await pool.execute(
        'UPDATE accounts SET balance = balance + ? WHERE id = ?',
        [delta, t.account_id]
      );
    }

    await pool.execute('DELETE FROM transactions WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Transaction deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

module.exports = router;
