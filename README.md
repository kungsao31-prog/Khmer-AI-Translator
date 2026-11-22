# Khmer AI Translator Pro 🇰🇭

Mobile-first Khmer video translation project for Chinese, Thai, English, and Vietnamese source media.

## Working in this first frontend version
- Responsive mobile interface.
- Select and preview a local video.
- Choose a source language or Auto Detect (selection UI only).
- Enter source text and Khmer translation manually.
- Preview Khmer subtitle lines over the video with configurable timing.
- Export UTF-8 Khmer SRT and TXT files.
- Test browser/device speech synthesis if a Khmer voice is installed.

## Not connected yet
Automatic speech recognition from uploaded video, automatic AI translation, OCR of on-screen captions, reliable male/female Khmer MP3 generation, precise speech alignment, and floating overlay above other Android apps require backend services and native Android code. The interface reports these limitations instead of pretending they work.

## Run
Open index.html in a modern browser, or enable GitHub Pages. HTTPS is recommended for mobile testing.

## Next stages
1. Secure backend for speech-to-text, translation, OCR, and Khmer TTS.
2. Timestamped segment alignment and downloadable MP3.
3. Capacitor Android wrapper.
4. Native Android overlay permission and floating subtitle service.
5. Build and test APK on a physical Android phone.

Never commit API keys, passwords, or provider credentials to this public repository.


## Version 1.2 enhancement APIs

The existing video translation and series endpoints are retained. Optional routes are registered by \`backend/server.js\` through \`backend/enhancements.js\`:

- \`GET /api/health/features\` — reports configured feature availability without exposing secrets.
- \`POST /api/groq/transcribe\` — multipart \`video\`; extracts audio with FFmpeg and transcribes using Groq Whisper.
- \`POST /api/groq/batch-transcribe\` — multipart \`videos\` (1–10 files); runs two bounded workers and returns transcripts per file.
- \`POST /api/ai/translate\` — JSON \`{ text, sourceLanguage?, provider?: "groq"|"external" }\`.
- \`POST /api/video/merge\` — multipart \`videos\` (2–10 files); normalizes clips then merges them into MP4.
- \`POST /api/video/thumbnail\` — multipart \`video\` and optional \`timeSeconds\`; returns a JPEG thumbnail.

### Server environment variables

Required for Groq transcription and Groq translation:
- \`GROQ_API_KEY\` — secret Groq API key.

Optional:
- \`GROQ_STT_MODEL\` — defaults to \`whisper-large-v3-turbo\`.
- \`GROQ_TRANSLATION_MODEL\` — defaults to \`llama-3.3-70b-versatile\`.
- \`AI_API_KEY\`, \`AI_BASE_URL\`, \`AI_MODEL\` — external OpenAI-compatible provider for \`provider: "external"\`.
- \`MAX_VIDEO_MB\` — per-file upload limit (defaults to 200 MB).

Do not put provider keys in the frontend, APK, GitHub source, or screenshots. Set them in the backend host's Environment/Secrets panel. The new Groq and external provider features are optional; existing Gemini routes continue to use \`GEMINI_API_KEY\`.

### Android APK

The Capacitor web app is mirrored in both \`index.html\` and \`WWW/index.html\`. The Android workflow copies \`WWW\` into \`dist\` before syncing Capacitor. Pushes to the default branch trigger the APK build workflow; feature branches do not publish a production APK until merged.
