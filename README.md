# BudgetWise API v2

Household finance backend — pooled income, shared expenses, and personal spending funds.

---

## Finance model

```
Pooled income (both salaries)
  ├── Shared expenses    scope='shared'   → visible to both users
  ├── Person A fund      scope='personal' → visible to Person A only
  ├── Person B fund      scope='personal' → visible to Person B only
  └── Remainder                           → savings / buffer
```

- **Income** is always `scope='shared'` (pooled)
- **Expenses** are tagged `scope='shared'` (household) or `scope='personal'` (own fund)
- Personal transactions are invisible to the other user

---

## First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DB credentials and both users' names/emails/passwords

# 3. Run seed (creates users, default account, default categories)
npm run seed

# 4. Set each user's monthly personal fund amount
# After seeding, call: PUT /api/allocations/:user_id  { "amount": 300 }

# 5. Start dev server
npm run dev
```

---

## Deploying to GlowHost (cPanel)

1. **Subdomain** — cPanel → Subdomains → `budget.yoursite.com` → `/public_html/budget`
2. **MySQL** — cPanel → MySQL Databases → create DB + user, grant ALL privileges
3. **Node.js App** — cPanel → Setup Node.js App → root: this folder, startup: `server.js`
4. **Env vars** — add each `.env` variable in the Node.js App manager UI
5. **npm install** — click "Run NPM Install" in the Node.js App manager
6. **Seed** — SSH or Terminal in cPanel → `node scripts/seed.js`
7. **React build** — upload `/dist` contents to `/public_html/budget`
8. **`.htaccess`** — see below
9. **SSL** — cPanel → Let's Encrypt → issue cert for the subdomain

### .htaccess (place in /public_html/budget)
```apache
Options -MultiViews
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteCond %{REQUEST_URI} !^/api/
RewriteRule ^ index.html [L]
```

---

## API reference

All routes except `/api/auth/login` and `/api/health` require a valid session cookie.

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | `{ email, password }` → sets JWT cookie |
| POST | `/api/auth/logout` | Clears cookie |
| GET  | `/api/auth/me` | Current user + personal fund amount |
| PUT  | `/api/auth/me` | Update name or password |

### Transactions
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/transactions` | List transactions |
| POST | `/api/transactions` | Create transaction |
| GET  | `/api/transactions/:id` | Get single (403 if other user's personal) |
| PUT  | `/api/transactions/:id` | Update (403 if other user's personal) |
| DELETE | `/api/transactions/:id` | Delete (403 if other user's personal) |

**GET query params:**
- `view=household` (default) — shared transactions only
- `view=personal`  — current user's personal transactions
- `view=mine`      — all transactions by current user
- `view=all`       — shared + current user's personal
- `account_id`, `category_id`, `from`, `to`, `limit`, `offset`

**POST body:**
```json
{
  "account_id": 1,
  "category_id": 3,
  "type": "expense",
  "scope": "shared",
  "amount": 120.00,
  "description": "Electricity bill",
  "date": "2025-01-15"
}
```
Note: `type='income'` always forces `scope='shared'`.

### Summary (dashboard endpoints)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/summary/household` | Pooled income, shared expenses, per-user fund usage, remainder |
| GET | `/api/summary/personal`  | Current user's fund: allocation, spent, remaining, breakdown |
| GET | `/api/summary/full`      | Everything combined — net household position |

All accept `?month=YYYY-MM` (defaults to current month).

### Allocations (personal fund amounts)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/allocations` | All users' monthly fund amounts |
| PUT | `/api/allocations/:user_id` | Set/update a user's fund `{ "amount": 300 }` |

### Accounts, Categories, Budgets
| Method | Path | Notes |
|--------|------|-------|
| GET/POST | `/api/accounts` | Household-wide |
| PUT/DELETE | `/api/accounts/:id` | |
| GET/POST | `/api/categories` | Supports `?scope=shared\|personal` filter |
| PUT/DELETE | `/api/categories/:id` | |
| GET/POST | `/api/budgets` | `?month=YYYY-MM&user_id=N` (omit user_id for household) |
| DELETE | `/api/budgets/:id` | |
