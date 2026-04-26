require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');

const { testConnection } = require('./db/connection');
const { runMigrations }  = require('./db/schema');
const { requireAuth }    = require('./middleware/auth');

const authRouter         = require('./routes/auth');
const transactionsRouter = require('./routes/transactions');
const summaryRouter      = require('./routes/summary');
const {
  accountsRouter, categoriesRouter,
  budgetsRouter, allocationsRouter,
} = require('./routes/resources');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ── Public ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── Protected ─────────────────────────────────────────────────────────────────
app.use('/api/transactions', requireAuth, transactionsRouter);
app.use('/api/accounts',     requireAuth, accountsRouter);
app.use('/api/categories',   requireAuth, categoriesRouter);
app.use('/api/budgets',      requireAuth, budgetsRouter);
app.use('/api/allocations',  requireAuth, allocationsRouter);
app.use('/api/summary',      requireAuth, summaryRouter);

// ── 404 / error ───────────────────────────────────────────────────────────────
app.use('/api/*', (req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await testConnection();
  await runMigrations();
  app.listen(PORT, () => console.log(`✓ BudgetWise API running on port ${PORT}`));
}

start();
