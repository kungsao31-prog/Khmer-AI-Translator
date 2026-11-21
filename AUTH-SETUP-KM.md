# Khmer AI Translator Pro — Secure Authentication

This branch adds a PostgreSQL-backed account system to the existing Khmer AI Translator Pro service.

## Features
- Khmer login and registration screen.
- Passwords hashed with bcrypt (12 rounds); passwords are never stored as plain text.
- Short-lived JWT access tokens (15 minutes by default).
- Random 48-byte refresh tokens stored only as SHA-256 hashes in PostgreSQL, with rotation on refresh.
- Login attempt throttling (8 attempts per IP per 15-minute window).
- Admin bootstrap from environment variables.
- Admin user list, create user, change role, disable/enable account, and revoke refresh sessions.
- AI, dubbing, video-job polling, and MP4 download routes require authentication.
- Video and series jobs are bound to the user who created them. Other accounts receive 404 when trying to inspect or download those jobs.
- Gemini API key remains server-side in Render Environment.

## Required Render environment variables
- DATABASE_URL: persistent PostgreSQL connection string (Neon or another PostgreSQL host).
- JWT_SECRET: random secret at least 32 characters. Render Blueprint can generate it.
- GEMINI_API_KEY: Google AI Studio key.
- ADMIN_EMAIL: initial administrator email.
- ADMIN_PASSWORD: initial administrator password, 10–72 UTF-8 bytes.
- ENABLE_REGISTRATION: true to allow user self-registration, false to disable it.

Optional:
- JWT_ACCESS_TTL=15m
- REFRESH_TOKEN_DAYS=30
- DATABASE_SSL=false only for a trusted local database that does not use TLS.

## Database setup
1. Create a PostgreSQL database with a persistent free/paid provider such as Neon.
2. Copy its connection string into Render as DATABASE_URL.
3. The service creates auth_users and auth_refresh_tokens tables automatically at startup.
4. Set ADMIN_EMAIL and a strong ADMIN_PASSWORD in Render before deploying.
5. Never add the real database URL, admin password, JWT secret, or Gemini key to GitHub.

Important: Render Free Postgres is temporary: it expires 30 days after creation, then has a 14-day upgrade grace period before deletion. It has no backups. Do not use it for permanent user accounts. Prefer a persistent database provider (for example, a suitable Neon plan) or upgrade Render Postgres before expiry. See https://render.com/docs/free.

## API
- POST /api/auth/register — { email, password }; only when ENABLE_REGISTRATION=true.
- POST /api/auth/login — { email, password }.
- POST /api/auth/refresh — { refreshToken }; rotates the refresh token.
- POST /api/auth/logout — { refreshToken }; revokes that refresh token.
- GET /api/auth/me — authenticated profile.
- GET /api/auth/admin/users — admin only.
- POST /api/auth/admin/users — admin only; create user.
- PATCH /api/auth/admin/users/:id/role — admin only.
- PATCH /api/auth/admin/users/:id/status — admin only; disable revokes refresh tokens.
- POST /api/auth/admin/users/:id/revoke-sessions — admin only.

Send Authorization: Bearer <accessToken> to protected API endpoints.

## Important deployment constraints
- Authentication requires a working PostgreSQL database. Without DATABASE_URL the service intentionally exits rather than silently running without protection.
- Video job state and temporary MP4 files remain in the Render process memory/disk, as before. Keep one Render instance; a restart loses in-progress jobs. For durable multi-instance processing, jobs and media must later move to shared storage/queue.
- The browser frontend stores tokens in localStorage for WebView compatibility. Use HTTPS, keep the UI scripts trusted, and do not add third-party scripts. A native Android secure-storage plugin is recommended for a production APK.
- This change does not make Gemini quota unlimited and does not increase the provider's free API limits.
