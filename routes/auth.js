const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { pool } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   7 * 24 * 60 * 60 * 1000,
};

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [rows] = await pool.execute(
      'SELECT id, name, email, password_hash, role FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '7d' }
    );

    res.cookie('token', token, COOKIE_OPTIONS);
    return res.json({
      message: 'Logged in',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', { ...COOKIE_OPTIONS, maxAge: 0 });
  return res.json({ message: 'Logged out' });
});

// GET /api/auth/me — returns current user + allocation
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.role,
              COALESCE(a.amount, 0) AS personal_fund_amount,
              a.currency
       FROM users u
       LEFT JOIN allocations a ON a.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT /api/auth/me — update name or password
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, current_password, new_password } = req.body;

    if (new_password) {
      const [rows] = await pool.execute(
        'SELECT password_hash FROM users WHERE id = ?', [req.user.id]
      );
      const valid = await bcrypt.compare(current_password || '', rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
      if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

      const hash = await bcrypt.hash(new_password, 12);
      await pool.execute(
        'UPDATE users SET name = ?, password_hash = ? WHERE id = ?',
        [name || req.user.name, hash, req.user.id]
      );
    } else if (name) {
      await pool.execute('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
    }

    return res.json({ message: 'Profile updated' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
