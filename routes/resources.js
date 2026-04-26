const express = require('express');
const { pool } = require('../db/connection');

// ── Accounts ──────────────────────────────────────────────────────────────────
const accountsRouter = express.Router();

accountsRouter.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT a.*, u.name AS created_by_name
       FROM accounts a LEFT JOIN users u ON a.created_by = u.id
       ORDER BY a.name`
    );
    return res.json(rows);
  } catch { return res.status(500).json({ error: 'Failed to fetch accounts' }); }
});

accountsRouter.post('/', async (req, res) => {
  try {
    const { name, type, balance, currency } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
    const [r] = await pool.execute(
      'INSERT INTO accounts (name, type, balance, currency, created_by) VALUES (?,?,?,?,?)',
      [name, type, balance || 0, currency || 'USD', req.user.id]
    );
    return res.status(201).json({ id: r.insertId, message: 'Account created' });
  } catch { return res.status(500).json({ error: 'Failed to create account' }); }
});

accountsRouter.put('/:id', async (req, res) => {
  try {
    const { name, type, currency } = req.body;
    await pool.execute(
      'UPDATE accounts SET name=?, type=?, currency=? WHERE id=?',
      [name, type, currency, req.params.id]
    );
    return res.json({ message: 'Account updated' });
  } catch { return res.status(500).json({ error: 'Failed to update account' }); }
});

accountsRouter.delete('/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM accounts WHERE id=?', [req.params.id]);
    return res.json({ message: 'Account deleted' });
  } catch { return res.status(500).json({ error: 'Failed to delete account' }); }
});

// ── Categories ────────────────────────────────────────────────────────────────
const categoriesRouter = express.Router();

categoriesRouter.get('/', async (req, res) => {
  try {
    const { type, scope } = req.query;
    let sql = 'SELECT * FROM categories WHERE 1=1';
    const params = [];
    if (type)  { sql += ' AND type = ?';  params.push(type); }
    if (scope) { sql += ' AND (scope = ? OR scope = "any")'; params.push(scope); }
    sql += ' ORDER BY scope, name';
    const [rows] = await pool.execute(sql, params);
    return res.json(rows);
  } catch { return res.status(500).json({ error: 'Failed to fetch categories' }); }
});

categoriesRouter.post('/', async (req, res) => {
  try {
    const { name, type, scope = 'any', color, icon } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
    const [r] = await pool.execute(
      'INSERT INTO categories (name, type, scope, color, icon) VALUES (?,?,?,?,?)',
      [name, type, scope, color || '#888888', icon || null]
    );
    return res.status(201).json({ id: r.insertId, message: 'Category created' });
  } catch { return res.status(500).json({ error: 'Failed to create category' }); }
});

categoriesRouter.put('/:id', async (req, res) => {
  try {
    const { name, scope, color, icon } = req.body;
    await pool.execute(
      'UPDATE categories SET name=?, scope=?, color=?, icon=? WHERE id=?',
      [name, scope, color, icon || null, req.params.id]
    );
    return res.json({ message: 'Category updated' });
  } catch { return res.status(500).json({ error: 'Failed to update category' }); }
});

categoriesRouter.delete('/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM categories WHERE id=?', [req.params.id]);
    return res.json({ message: 'Category deleted' });
  } catch { return res.status(500).json({ error: 'Failed to delete category' }); }
});

// ── Budgets ───────────────────────────────────────────────────────────────────
const budgetsRouter = express.Router();

// GET /api/budgets?month=2025-01&user_id=1  (omit user_id for household budgets)
budgetsRouter.get('/', async (req, res) => {
  try {
    const { month, user_id } = req.query;
    const monthStart = month ? `${month}-01` : new Date().toISOString().slice(0, 7) + '-01';

    const params = [monthStart];
    let userFilter = 'b.user_id IS NULL';
    if (user_id) {
      userFilter = 'b.user_id = ?';
      params.push(user_id);
    }

    const [rows] = await pool.execute(
      `SELECT b.*, c.name AS category_name, c.color,
              COALESCE(SUM(t.amount), 0) AS spent
       FROM budgets b
       JOIN categories c ON b.category_id = c.id
       LEFT JOIN transactions t
         ON t.category_id = b.category_id
         AND t.type = 'expense'
         AND (b.user_id IS NULL OR t.created_by = b.user_id)
         AND DATE_FORMAT(t.date, '%Y-%m-01') = b.month
       WHERE b.month = ? AND ${userFilter}
       GROUP BY b.id`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch budgets' });
  }
});

budgetsRouter.post('/', async (req, res) => {
  try {
    const { category_id, month, amount, user_id } = req.body;
    if (!category_id || !month || !amount) {
      return res.status(400).json({ error: 'category_id, month, and amount are required' });
    }
    const monthStart = `${month}-01`;
    await pool.execute(
      `INSERT INTO budgets (category_id, user_id, month, amount) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE amount=VALUES(amount), updated_at=CURRENT_TIMESTAMP`,
      [category_id, user_id || null, monthStart, amount]
    );
    return res.status(201).json({ message: 'Budget saved' });
  } catch { return res.status(500).json({ error: 'Failed to save budget' }); }
});

budgetsRouter.delete('/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM budgets WHERE id=?', [req.params.id]);
    return res.json({ message: 'Budget deleted' });
  } catch { return res.status(500).json({ error: 'Failed to delete budget' }); }
});

// ── Allocations ───────────────────────────────────────────────────────────────
const allocationsRouter = express.Router();

// GET /api/allocations — all users' fund amounts
allocationsRouter.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id AS user_id, u.name, COALESCE(a.amount, 0) AS amount, a.currency
       FROM users u LEFT JOIN allocations a ON a.user_id = u.id
       ORDER BY u.name`
    );
    return res.json(rows);
  } catch { return res.status(500).json({ error: 'Failed to fetch allocations' }); }
});

// PUT /api/allocations/:user_id — set or update a user's monthly fund
allocationsRouter.put('/:user_id', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (amount == null) return res.status(400).json({ error: 'amount is required' });
    await pool.execute(
      `INSERT INTO allocations (user_id, amount, currency) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE amount=VALUES(amount), currency=VALUES(currency), updated_at=CURRENT_TIMESTAMP`,
      [req.params.user_id, amount, currency || 'USD']
    );
    return res.json({ message: 'Allocation updated' });
  } catch { return res.status(500).json({ error: 'Failed to update allocation' }); }
});

module.exports = { accountsRouter, categoriesRouter, budgetsRouter, allocationsRouter };
