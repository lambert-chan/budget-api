const router = require('express').Router();
const { pool } = require('../db/connection');

function monthBounds(month) {
  const start = month ? `${month}-01` : new Date().toISOString().slice(0, 7) + '-01';
  const end   = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end: end.toISOString().slice(0, 10) };
}

// ── GET /api/summary/household?month=2025-01 ─────────────────────────────────
// Shared income, shared expenses, each user's allocation, and remainder
router.get('/household', async (req, res) => {
  try {
    const { start, end } = monthBounds(req.query.month);

    // Pooled income (all income transactions are shared)
    const [[income]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE type='income' AND scope='shared' AND date >= ? AND date < ?`,
      [start, end]
    );

    // Shared expenses
    const [[sharedExp]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE type='expense' AND scope='shared' AND date >= ? AND date < ?`,
      [start, end]
    );

    // Shared expenses by category
    const [byCategory] = await pool.execute(
      `SELECT c.name, c.color, COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.type='expense' AND t.scope='shared' AND t.date >= ? AND t.date < ?
       GROUP BY c.id ORDER BY total DESC`,
      [start, end]
    );

    // Each user's allocation + how much of their fund they spent this month
    const [userFunds] = await pool.execute(
      `SELECT u.id, u.name,
              COALESCE(a.amount, 0) AS fund_amount,
              COALESCE(SUM(t.amount), 0) AS fund_spent
       FROM users u
       LEFT JOIN allocations a ON a.user_id = u.id
       LEFT JOIN transactions t
         ON t.created_by = u.id
         AND t.scope = 'personal'
         AND t.type = 'expense'
         AND t.date >= ? AND t.date < ?
       GROUP BY u.id`,
      [start, end]
    );

    const totalAllocations = userFunds.reduce((s, u) => s + parseFloat(u.fund_amount), 0);
    const pooledIncome     = parseFloat(income.total);
    const sharedExpenses   = parseFloat(sharedExp.total);
    const remainder        = pooledIncome - sharedExpenses - totalAllocations;

    return res.json({
      month:            start.slice(0, 7),
      pooled_income:    pooledIncome,
      shared_expenses:  sharedExpenses,
      total_allocations: totalAllocations,
      remainder,
      by_category:      byCategory,
      user_funds:       userFunds.map(u => ({
        ...u,
        fund_amount:    parseFloat(u.fund_amount),
        fund_spent:     parseFloat(u.fund_spent),
        fund_remaining: parseFloat(u.fund_amount) - parseFloat(u.fund_spent),
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch household summary' });
  }
});

// ── GET /api/summary/personal?month=2025-01 ──────────────────────────────────
// Current user's personal fund: allocation, spent, remaining, breakdown
router.get('/personal', async (req, res) => {
  try {
    const { start, end } = monthBounds(req.query.month);
    const userId = req.user.id;

    const [[allocation]] = await pool.execute(
      'SELECT COALESCE(amount, 0) AS fund_amount FROM allocations WHERE user_id = ?',
      [userId]
    );

    const [[spent]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE created_by=? AND scope='personal' AND type='expense' AND date >= ? AND date < ?`,
      [userId, start, end]
    );

    const [transactions] = await pool.execute(
      `SELECT t.*, c.name AS category_name, c.color AS category_color, a.name AS account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts   a ON t.account_id  = a.id
       WHERE t.created_by=? AND t.scope='personal' AND t.date >= ? AND t.date < ?
       ORDER BY t.date DESC`,
      [userId, start, end]
    );

    const [byCategory] = await pool.execute(
      `SELECT c.name, c.color, COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.created_by=? AND t.scope='personal' AND t.type='expense'
         AND t.date >= ? AND t.date < ?
       GROUP BY c.id ORDER BY total DESC`,
      [userId, start, end]
    );

    const fundAmount = parseFloat(allocation.fund_amount);
    const fundSpent  = parseFloat(spent.total);

    return res.json({
      month:          start.slice(0, 7),
      user:           { id: req.user.id, name: req.user.name },
      fund_amount:    fundAmount,
      fund_spent:     fundSpent,
      fund_remaining: fundAmount - fundSpent,
      by_category:    byCategory,
      transactions,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch personal summary' });
  }
});

// ── GET /api/summary/full?month=2025-01 ──────────────────────────────────────
// Complete picture: pooled income, shared expenses, all personal spending, net
router.get('/full', async (req, res) => {
  try {
    const { start, end } = monthBounds(req.query.month);

    const [[income]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
       WHERE type='income' AND date >= ? AND date < ?`,
      [start, end]
    );

    const [[sharedExp]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
       WHERE type='expense' AND scope='shared' AND date >= ? AND date < ?`,
      [start, end]
    );

    const [[personalExp]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
       WHERE type='expense' AND scope='personal' AND date >= ? AND date < ?`,
      [start, end]
    );

    // Per-user personal spending (visible to all for the full picture)
    const [perUser] = await pool.execute(
      `SELECT u.name, COALESCE(SUM(t.amount), 0) AS spent
       FROM users u
       LEFT JOIN transactions t
         ON t.created_by = u.id AND t.scope = 'personal'
         AND t.type = 'expense' AND t.date >= ? AND t.date < ?
       GROUP BY u.id`,
      [start, end]
    );

    const [accounts] = await pool.execute(
      'SELECT name, type, balance, currency FROM accounts ORDER BY name'
    );

    const totalIncome   = parseFloat(income.total);
    const totalShared   = parseFloat(sharedExp.total);
    const totalPersonal = parseFloat(personalExp.total);

    return res.json({
      month:            start.slice(0, 7),
      total_income:     totalIncome,
      shared_expenses:  totalShared,
      personal_expenses: totalPersonal,
      total_expenses:   totalShared + totalPersonal,
      net:              totalIncome - totalShared - totalPersonal,
      per_user_personal: perUser.map(u => ({ ...u, spent: parseFloat(u.spent) })),
      accounts,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch full summary' });
  }
});

module.exports = router;
