"use strict";

const crypto = require("crypto");

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function b64(value) { return Buffer.from(value).toString("base64url"); }
function signToken(payload, secret) {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const input = header + "." + body;
  const signature = crypto.createHmac("sha256", secret).update(input).digest("base64url");
  return input + "." + signature;
}
function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const input = parts[0] + "." + parts[1];
  const expected = crypto.createHmac("sha256", secret).update(input).digest("base64url");
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

module.exports = function installSecurity(app) {
  const secret = process.env.JWT_SECRET || "";
  const username = process.env.ADMIN_USERNAME || "";
  const password = process.env.ADMIN_PASSWORD || "";
  const windowMs = Math.max(60000, Number(process.env.AUTH_RATE_WINDOW_MS || 900000));
  const maxAttempts = Math.max(3, Number(process.env.AUTH_RATE_MAX || 10));
  const attempts = new Map();

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.post("/api/auth/login", (req, res) => {
    if (!secret || secret.length < 32 || !username || !password) {
      return res.status(503).json({ ok: false, error: "ម្ចាស់កម្មវិធីមិនទាន់កំណត់ JWT_SECRET, ADMIN_USERNAME និង ADMIN_PASSWORD នៅ Render ទេ" });
    }
    const key = String(req.ip || req.socket.remoteAddress || "unknown");
    const now = Date.now();
    const entry = attempts.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    if (entry.count >= maxAttempts) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: "សាកល្បងចូលច្រើនដងពេក។ សូមរង់ចាំបន្តិច" });
    }
    entry.count += 1;
    attempts.set(key, entry);
    const valid = safeEqual(req.body && req.body.username, username) &&
      safeEqual(req.body && req.body.password, password);
    if (!valid) return res.status(401).json({ ok: false, error: "ឈ្មោះអ្នកប្រើ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវទេ" });
    attempts.delete(key);
    const issued = Math.floor(now / 1000);
    const token = signToken({ sub: username, iat: issued, exp: issued + 8 * 60 * 60 }, secret);
    res.json({ ok: true, token, tokenType: "Bearer", expiresIn: 28800 });
  });

  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path === "/auth/login") return next();
    if (!secret || secret.length < 32 || !username || !password) {
      return res.status(503).json({ ok: false, error: "ប្រព័ន្ធការពារមិនទាន់បានកំណត់នៅលើ Server ទេ" });
    }
    const header = String(req.headers.authorization || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    const user = match && verifyToken(match[1], secret);
    if (!user) return res.status(401).json({ ok: false, error: "សូម Login មុនប្រើប្រាស់ API" });
    req.auth = { username: user.sub };
    next();
  });
};
