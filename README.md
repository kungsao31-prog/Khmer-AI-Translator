# Khmer AI Translator Pro 🇰🇭

Backend for Khmer video translation, Khmer TTS and subtitle generation.

## Deploy on Render
- Runtime: Node 20+
- Build command: `npm install`
- Start command: `npm start`
- Configure the variables in `.env.example` in Render. Never commit real credentials.
- Set `JWT_SECRET` to a cryptographically random secret of at least 32 characters.
- Set a strong `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
- Set `GEMINI_API_KEY` to a valid Google AI Studio API key.
- Optional: set `CORS_ORIGIN` to exact trusted frontend origins, comma-separated. Leave empty for same-origin use.

## Authentication
All `/api/*` routes except `GET /api/health` and `POST /api/auth/login` require a Bearer JWT.

1. POST JSON to `/api/auth/login`: `{"username":"...","password":"..."}`
2. Receive a signed HS256 token (8-hour expiry).
3. Send `Authorization: Bearer <token>` on protected API requests.
4. Login attempts are rate-limited per client IP. Security headers are added by middleware.

Example:
```sh
curl -X POST https://YOUR-SERVICE.onrender.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"YOUR_ADMIN","password":"YOUR_PASSWORD"}'
```

JWT secret, admin credentials and Gemini key must exist only in Render Environment Variables. If missing, protected APIs fail closed with HTTP 503. Health endpoint does not return secret values.

## Backend routes
- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/translate`
- `POST /api/tts`
- `POST /api/video/translate`
- `POST /api/video/translate-and-dub`
- `GET /api/video/jobs` and job detail/download/subtitle endpoints
- `POST /api/series/jobs` and series status/download endpoints

## Operational limitations
- Job state is held in process memory; restarting/redeploying loses active jobs.
- Temporary files are not durable cloud storage.
- Video length, upload size, Gemini quotas, CPU/RAM and Render plan limits still apply. No unlimited-duration guarantee is made.
- This backend does not yet include a persistent account database, password reset, multi-user roles, durable queue, or permanent media storage.
- The frontend must call login and attach the returned Bearer token. Never place admin passwords or Gemini keys in browser code.
- Run `npm run check` before deploying.
