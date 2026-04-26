const jwt = require('jsonwebtoken');

/**
 * requireAuth — verifies JWT cookie, attaches req.user = { id, name, email, role }
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Session expired, please log in again'
      : 'Invalid token';
    return res.status(401).json({ error: msg });
  }
}

/**
 * canViewTransaction — enforces personal scope visibility.
 * Shared transactions are visible to everyone.
 * Personal transactions are visible only to their creator.
 * Attach after requireAuth on routes that return a single transaction.
 */
function canViewTransaction(req, res, next) {
  const t = req.transaction; // set by a prior lookup middleware
  if (!t) return res.status(404).json({ error: 'Transaction not found' });
  if (t.scope === 'personal' && t.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

module.exports = { requireAuth, canViewTransaction };
