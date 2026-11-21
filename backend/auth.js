"use strict";
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const router = express.Router();
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = String(process.env.JWT_SECRET || "");
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || "15m";
const REFRESH_DAYS = Math.max(1, Math.min(90, Number(process.env.REFRESH_TOKEN_DAYS || 30)));
const REGISTRATION_ENABLED = String(process.env.ENABLE_REGISTRATION || "false").toLowerCase() === "true";
if (!DATABASE_URL) throw new Error("DATABASE_URL is required for secure authentication");
if (JWT_SECRET.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
});
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function cleanEmail(value) { return String(value || "").trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254; }
function passwordValid(value) {
  const bytes = Buffer.byteLength(String(value || ""), "utf8");
  return bytes >= 10 && bytes <= 72;
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function publicUser(row) {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at, active: row.active };
}
function signAccess(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, typ: "access" },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL, issuer: "khmer-ai-translator", audience: "khmer-ai-app" }
  );
}
async function issueTokens(user) {
  const accessToken = signAccess(user);
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000);
  await pool.query("INSERT INTO auth_refresh_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
    [hashToken(refreshToken), user.id, expiresAt]);
  return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: ACCESS_TTL,
    refreshExpiresAt: expiresAt.toISOString(), user: publicUser(user) };
}
function rateLimitLogin(req, res, next) {
  const key = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const old = loginAttempts.get(key);
  if (!old || now - old.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { startedAt: now, count: 1 });
    return next();
  }
  old.count += 1;
  if (old.count > MAX_LOGIN_ATTEMPTS) {
    const waitSeconds = Math.ceil((LOGIN_WINDOW_MS - (now - old.startedAt)) / 1000);
    res.setHeader("Retry-After", String(waitSeconds));
    return res.status(429).json({ ok: false, error: "អ្នកបានសាកល្បងចូលច្រើនដងពេក។ សូមរង់ចាំ ១៥ នាទី រួចសាកល្បងម្ដងទៀត។" });
  }
  next();
}
async function initializeAuth() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS auth_users (" +
    "id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL," +
    "role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))," +
    "active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()," +
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    "CREATE TABLE IF NOT EXISTS auth_refresh_tokens (" +
    "token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE," +
    "expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    "CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_idx ON auth_refresh_tokens(user_id);" +
    "CREATE INDEX IF NOT EXISTS auth_refresh_tokens_expiry_idx ON auth_refresh_tokens(expires_at);"
  );
  const adminEmail = cleanEmail(process.env.ADMIN_EMAIL);
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");
  if (adminEmail || adminPassword) {
    if (!validEmail(adminEmail) || !passwordValid(adminPassword)) {
      throw new Error("Set both ADMIN_EMAIL and ADMIN_PASSWORD; admin password must be 10-72 UTF-8 bytes");
    }
    const existing = await pool.query("SELECT id FROM auth_users WHERE email=$1", [adminEmail]);
    if (existing.rowCount) {
      await pool.query("UPDATE auth_users SET role='admin',active=TRUE,updated_at=NOW() WHERE email=$1", [adminEmail]);
    } else {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      await pool.query("INSERT INTO auth_users (id,email,password_hash,role) VALUES ($1,$2,$3,'admin')",
        [crypto.randomUUID(), adminEmail, passwordHash]);
      console.log("[AUTH] Initial administrator account created");
    }
  }
  await pool.query("DELETE FROM auth_refresh_tokens WHERE expires_at < NOW()");
  console.log("[AUTH] PostgreSQL authentication schema is ready");
}
async function authenticate(req, res, next) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "សូមចូលគណនីជាមុនសិន។" });
  try {
    const payload = jwt.verify(match[1], JWT_SECRET, { issuer: "khmer-ai-translator", audience: "khmer-ai-app" });
    if (payload.typ !== "access" || !payload.sub) throw new Error("Invalid token type");
    const result = await pool.query("SELECT id,email,role,active,created_at FROM auth_users WHERE id=$1", [payload.sub]);
    const user = result.rows[0];
    if (!user || !user.active) return res.status(401).json({ ok: false, code: "ACCOUNT_DISABLED", error: "គណនីនេះមិនមានសិទ្ធិប្រើប្រាស់ទេ។" });
    req.user = publicUser(user);
    next();
  } catch (_) {
    return res.status(401).json({ ok: false, code: "TOKEN_INVALID", error: "Session ផុតកំណត់ ឬមិនត្រឹមត្រូវ។ សូមចូលគណនីម្ដងទៀត។" });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ ok: false, error: "មុខងារនេះអនុញ្ញាតតែអ្នកគ្រប់គ្រងប៉ុណ្ណោះ។" });
  next();
}

router.post("/register", async (req, res) => {
  if (!REGISTRATION_ENABLED) return res.status(403).json({ ok: false, error: "ការចុះឈ្មោះថ្មីត្រូវបានបិទ។ សូមទាក់ទងអ្នកគ្រប់គ្រង។" });
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: "អ៊ីមែលមិនត្រឹមត្រូវ។" });
  if (!passwordValid(password)) return res.status(400).json({ ok: false, error: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច ១០ និងមិនលើស ៧២ bytes។" });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO auth_users (id,email,password_hash,role) VALUES ($1,$2,$3,'user') RETURNING id,email,role,active,created_at",
      [crypto.randomUUID(), email, passwordHash]);
    res.status(201).json({ ok: true, ...await issueTokens(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, error: "អ៊ីមែលនេះមានគណនីរួចហើយ។" });
    throw error;
  }
});
router.post("/login", rateLimitLogin, async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!validEmail(email) || !password) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអ៊ីមែល និងពាក្យសម្ងាត់។" });
  const result = await pool.query("SELECT id,email,password_hash,role,active,created_at FROM auth_users WHERE email=$1", [email]);
  const user = result.rows[0];
  const valid = user && user.active && await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: "អ៊ីមែល ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ។" });
  loginAttempts.delete(String(req.ip || req.socket?.remoteAddress || "unknown"));
  res.json({ ok: true, ...await issueTokens(user) });
});
router.post("/refresh", async (req, res) => {
  const refreshToken = String(req.body?.refreshToken || "");
  if (refreshToken.length < 40 || refreshToken.length > 200) return res.status(401).json({ ok: false, error: "Refresh Token មិនត្រឹមត្រូវ។" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT u.id,u.email,u.role,u.active,u.created_at,t.token_hash FROM auth_refresh_tokens t " +
      "JOIN auth_users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.expires_at>NOW() FOR UPDATE",
      [hashToken(refreshToken)]);
    const user = result.rows[0];
    if (!user || !user.active) {
      await client.query("ROLLBACK");
      return res.status(401).json({ ok: false, error: "Refresh Token ផុតកំណត់ ឬត្រូវបានដកហូត។ សូមចូលម្ដងទៀត។" });
    }
    await client.query("DELETE FROM auth_refresh_tokens WHERE token_hash=$1", [hashToken(refreshToken)]);
    const accessToken = signAccess(user);
    const nextRefresh = crypto.randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000);
    await client.query("INSERT INTO auth_refresh_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
      [hashToken(nextRefresh), user.id, expiresAt]);
    await client.query("COMMIT");
    res.json({ ok: true, accessToken, refreshToken: nextRefresh, tokenType: "Bearer",
      expiresIn: ACCESS_TTL, refreshExpiresAt: expiresAt.toISOString(), user: publicUser(user) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
});
router.post("/logout", async (req, res) => {
  const token = String(req.body?.refreshToken || "");
  if (token) await pool.query("DELETE FROM auth_refresh_tokens WHERE token_hash=$1", [hashToken(token)]);
  res.json({ ok: true });
});
router.get("/me", authenticate, (req, res) => res.json({ ok: true, user: req.user }));
router.get("/admin/users", authenticate, requireAdmin, async (req, res) => {
  const result = await pool.query("SELECT id,email,role,active,created_at FROM auth_users ORDER BY created_at DESC LIMIT 500");
  res.json({ ok: true, users: result.rows.map(publicUser) });
});
router.post("/admin/users", authenticate, requireAdmin, async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const role = req.body?.role === "admin" ? "admin" : "user";
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: "អ៊ីមែលមិនត្រឹមត្រូវ។" });
  if (!passwordValid(password)) return res.status(400).json({ ok: false, error: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច ១០ និងមិនលើស ៧២ bytes។" });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query("INSERT INTO auth_users (id,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,email,role,active,created_at",
      [crypto.randomUUID(), email, passwordHash, role]);
    res.status(201).json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, error: "អ៊ីមែលនេះមានគណនីរួចហើយ។" });
    throw error;
  }
});
router.patch("/admin/users/:id/role", authenticate, requireAdmin, async (req, res) => {
  const role = req.body?.role;
  if (!["admin", "user"].includes(role)) return res.status(400).json({ ok: false, error: "Role មិនត្រឹមត្រូវ។" });
  if (req.params.id === req.user.id && role !== "admin") return res.status(400).json({ ok: false, error: "មិនអាចដកសិទ្ធិ Admin របស់គណនីខ្លួនឯងបានទេ។" });
  if (role === "user") {
    const target = await pool.query("SELECT role FROM auth_users WHERE id=$1", [req.params.id]);
    const count = await pool.query("SELECT COUNT(*)::int AS total FROM auth_users WHERE role='admin' AND active=TRUE");
    if (target.rows[0]?.role === "admin" && count.rows[0].total <= 1) return res.status(409).json({ ok: false, error: "ត្រូវរក្សា Admin យ៉ាងតិចម្នាក់។" });
  }
  const result = await pool.query("UPDATE auth_users SET role=$1,updated_at=NOW() WHERE id=$2 RETURNING id,email,role,active,created_at", [role, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ ok: false, error: "រកមិនឃើញគណនី។" });
  res.json({ ok: true, user: publicUser(result.rows[0]) });
});
router.patch("/admin/users/:id/status", authenticate, requireAdmin, async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== "boolean") return res.status(400).json({ ok: false, error: "ស្ថានភាពមិនត្រឹមត្រូវ។" });
  if (req.params.id === req.user.id && !active) return res.status(400).json({ ok: false, error: "មិនអាចបិទគណនីខ្លួនឯងបានទេ។" });
  const result = await pool.query("UPDATE auth_users SET active=$1,updated_at=NOW() WHERE id=$2 RETURNING id,email,role,active,created_at", [active, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ ok: false, error: "រកមិនឃើញគណនី។" });
  if (!active) await pool.query("DELETE FROM auth_refresh_tokens WHERE user_id=$1", [req.params.id]);
  res.json({ ok: true, user: publicUser(result.rows[0]) });
});
router.post("/admin/users/:id/revoke-sessions", authenticate, requireAdmin, async (req, res) => {
  const result = await pool.query("DELETE FROM auth_refresh_tokens WHERE user_id=$1", [req.params.id]);
  res.json({ ok: true, revokedSessions: result.rowCount });
});

module.exports = { router, authenticate, initializeAuth, pool };
