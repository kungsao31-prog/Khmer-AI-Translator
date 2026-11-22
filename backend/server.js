/**
 * Khmer AI Translator Pro - Backend
 * Node.js 20+
 */

"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
const { EdgeTTS } = require("node-edge-tts");
require("dotenv").config();

const execFileAsync = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const API_KEY_INVALID_CHAR = [...API_KEY].findIndex(char => {
  const code = char.codePointAt(0);
  return code < 0x21 || code > 0x7E;
});

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || TEXT_MODEL;
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map(value => value.trim()).filter(Boolean);

const GEMINI_RETRY_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.GEMINI_RETRY_ATTEMPTS || 2)));
const GEMINI_RETRY_BASE_MS = Math.max(500, Math.min(10000, Number(process.env.GEMINI_RETRY_BASE_MS || 1200)));
const MAX_VIDEO_MB = Math.max(1, Math.min(200, Number(process.env.MAX_VIDEO_MB || 200)));
const MAX_TEXT_CHARS = Math.max(1000, Number(process.env.MAX_TEXT_CHARS || 12000));
const TTS_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.TTS_CONCURRENCY || 3)));

const TMP = path.join(os.tmpdir(), "khmer-ai-translator");
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

fs.mkdirSync(TMP, { recursive: true });

const videoJobs = new Map();
const seriesJobs = new Map();
let activeMediaJobId = null;
const JOB_RETENTION_MS = 30 * 60 * 1000;

function pruneFinishedJobs(jobs) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.finishedAt || now - job.finishedAt < JOB_RETENTION_MS) continue;
    if (job.input) fs.promises.unlink(job.input).catch(() => {});
    for (const input of job.inputFiles || []) fs.promises.unlink(input).catch(() => {});
    if (job.work) fs.promises.rm(job.work, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
  }
}

const cleanupTimer = setInterval(() => {
  pruneFinishedJobs(videoJobs);
  pruneFinishedJobs(seriesJobs);
}, 5 * 60 * 1000);
cleanupTimer.unref();

app.disable("x-powered-by");
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  dest: TMP,
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 }
});
const seriesUpload = multer({
  dest: TMP,
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 20 }
});
const MAX_SERIES_FILES = 20;
const MAX_SERIES_TOTAL_MB = Math.max(1, Math.min(200, Number(process.env.MAX_SERIES_TOTAL_MB || 200)));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireGeminiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "មិនទាន់កំណត់ GEMINI_API_KEY នៅក្នុង Environment"
    });
  }
  if (API_KEY_INVALID_CHAR !== -1) {
    const badChar = [...API_KEY][API_KEY_INVALID_CHAR];
    console.error(`[CONFIG] GEMINI_API_KEY contains non-ASCII char at ${API_KEY_INVALID_CHAR} (U+${badChar.codePointAt(0).toString(16).toUpperCase()})`);
    return res.status(503).json({
      ok: false,
      error: "GEMINI_API_KEY មានតួអក្សរខ្មែរ ឬតួអក្សរមិនត្រឹមត្រូវ។ សូមដាក់ API Key ស្អាតពី Google AI Studio។"
    });
  }
  next();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => typeof part.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();
}

class GeminiApiError extends Error {
  constructor(message, status = 0, apiStatus = "") {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.apiStatus = apiStatus;
  }
}

function isQuotaOrRateLimitError(error) {
  const message = String(error?.message || "").toLowerCase();
  return Number(error?.status) === 429 ||
    String(error?.apiStatus || "").toUpperCase() === "RESOURCE_EXHAUSTED" ||
    /quota|rate.?limit|too many requests|resource.?exhausted/.test(message);
}

function isDailyQuotaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return /per[_\\s-]?day|daily|requests per day|quota.{0,40}day|day.{0,40}quota/.test(message);
}

function isTemporaryGeminiError(error) {
  const message = String(error?.message || "").toLowerCase();
  return [0, 408, 500, 502, 503, 504].includes(Number(error?.status)) ||
    /high demand|overloaded|temporarily unavailable|try again later/.test(message);
}

async function geminiGenerateOnce(model, contents, generationConfig = {}) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.2,
          ...generationConfig
        }
      })
    });
  } catch (error) {
    throw new GeminiApiError("មិនអាចភ្ជាប់ទៅសេវា Gemini បានទេ: " + error.message, 0);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GeminiApiError(
      data?.error?.message || `Gemini API request failed (${response.status})`,
      response.status,
      data?.error?.status || ""
    );
  }

  const text = getGeminiText(data);
  if (!text) throw new GeminiApiError("Gemini មិនបានផ្ញើអត្ថបទត្រឡប់មកវិញ", 502);
  return text;
}

async function geminiGenerate(model, contents, generationConfig = {}) {
  const models = [...new Set([model, ...FALLBACK_MODELS].filter(Boolean))];
  let lastError;
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const selectedModel = models[modelIndex];
    for (let attempt = 1; attempt <= GEMINI_RETRY_ATTEMPTS; attempt++) {
      try {
        return await geminiGenerateOnce(selectedModel, contents, generationConfig);
      } catch (error) {
        lastError = error;
        if (isQuotaOrRateLimitError(error)) {
          const daily = isDailyQuotaError(error);
          throw new GeminiApiError(
            daily
              ? "កូតា Gemini ប្រចាំថ្ងៃបានអស់ហើយ។ សូមរង់ចាំឱ្យកូតាកំណត់ឡើងវិញ។"
              : "Gemini បានកំណត់ចំនួនសំណើ (HTTP 429)។ សូមរង់ចាំបន្តិច រួចសាកល្បងម្ដងទៀត។",
            Number(error.status) || 429,
            error.apiStatus
          );
        }
        const temporary = isTemporaryGeminiError(error);
        if (temporary && attempt < GEMINI_RETRY_ATTEMPTS) {
          const delay = GEMINI_RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
          await sleep(delay);
          continue;
        }
        if (!temporary || modelIndex === models.length - 1) throw error;
        break;
      }
    }
  }
  throw lastError || new Error("សេវា Gemini មិនអាចដំណើរការបានទេ");
}

function stripJsonFence(text) {
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function repairInvalidJsonEscapes(text) {
  let output = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      output += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') {
      output += ch;
      inString = false;
      continue;
    }
    if (ch !== "\\") {
      output += ch;
      continue;
    }
    const next = text[i + 1];
    if (next && '"\\/bfnrt'.includes(next)) {
      output += ch + next;
      i++;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      output += text.slice(i, i + 6);
      i += 5;
      continue;
    }
    output += "\\\\";
  }
  return output;
}

function parseJsonObject(text) {
  const cleaned = stripJsonFence(text);
  for (const candidate of [cleaned, repairInvalidJsonEscapes(cleaned)]) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      const first = candidate.indexOf("{");
      const last = candidate.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try {
          return JSON.parse(candidate.slice(first, last + 1));
        } catch (_) {}
      }
    }
  }
  throw new Error("Gemini បានផ្ញើ JSON មិនត្រឹមត្រូវ។ សូមសាកល្បងម្ដងទៀត។");
}

function getMimeType(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4"
  };
  return file.mimetype && file.mimetype !== "application/octet-stream"
    ? file.mimetype
    : (map[ext] || "video/mp4");
}

async function uploadGeminiFile(filePath, mimeType, displayName) {
  const stat = await fs.promises.stat(filePath);
  const start = await fetch(`${GEMINI_BASE.replace("/v1beta", "")}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": API_KEY,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(stat.size),
      "X-Goog-Upload-Header-Content-Type": mimeType
    },
    body: JSON.stringify({ file: { display_name: displayName } })
  });

  if (!start.ok) {
    const data = await start.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Gemini upload start failed (${start.status})`);
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini មិនបានផ្ដល់ Upload URL");

  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(stat.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: fs.createReadStream(filePath),
    duplex: "half"
  });

  const uploaded = await finish.json().catch(() => ({}));
  if (!finish.ok) {
    throw new Error(uploaded?.error?.message || `Gemini upload failed (${finish.status})`);
  }

  let file = uploaded.file || uploaded;
  for (let attempt = 0; attempt < 45 && file.state === "PROCESSING"; attempt++) {
    await sleep(1500);
    const check = await fetch(`${GEMINI_BASE}/${file.name}`, {
      headers: { "x-goog-api-key": API_KEY }
    });
    const checked = await check.json().catch(() => ({}));
    if (!check.ok) throw new Error(checked?.error?.message || "ពិនិត្យស្ថានភាពឯកសារនៅ Gemini មិនបាន");
    file = checked;
  }

  if (file.state && file.state !== "ACTIVE") {
    throw new Error(`Gemini មិនអាចដំណើរការឯកសារនេះបានទេ (state: ${file.state})`);
  }
  if (!file.uri) throw new Error("Gemini មិនបានផ្ដល់ File URI");
  return file;
}

async function deleteGeminiFile(name) {
  if (!name) return;
  try {
    await fetch(`${GEMINI_BASE}/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": API_KEY }
    });
  } catch (_) {}
}

function validateVoice(gender) {
  const value = String(gender || "").toLowerCase();
  if (["male", "m", "man", "km-kh-pisethneural"].includes(value)) return "km-KH-PisethNeural";
  return "km-KH-SreymomNeural";
}

function cinematicProsody(emotion, gender) {
  const mood = String(emotion || "neutral").toLowerCase();
  const male = validateVoice(gender) === "km-KH-PisethNeural";
  const presets = {
    neutral: { rate: "+6%", pitch: male ? "-3%" : "+0%", volume: "+0%" },
    calm: { rate: "+0%", pitch: male ? "-5%" : "-2%", volume: "+0%" },
    sad: { rate: "-2%", pitch: male ? "-7%" : "-4%", volume: "-4%" },
    angry: { rate: "+6%", pitch: male ? "-2%" : "+3%", volume: "+5%" },
    excited: { rate: "+9%", pitch: male ? "+2%" : "+5%", volume: "+4%" },
    dramatic: { rate: "+0%", pitch: male ? "-6%" : "-2%", volume: "+3%" },
    whisper: { rate: "-5%", pitch: male ? "-4%" : "-2%", volume: "-18%" }
  };
  return presets[mood] || presets.neutral;
}

async function synthesizeKhmer(text, gender, outputPath, emotion = "neutral", style = "cinematic") {
  const voice = validateVoice(gender);
  const prosody = style === "cinematic"
    ? cinematicProsody(emotion, gender)
    : { rate: "+2%", pitch: "default", volume: "default" };

  const attempts = Math.max(1, Math.min(4, Number(process.env.EDGE_TTS_RETRY_ATTEMPTS || 3)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.promises.unlink(outputPath).catch(() => {});
      const tts = new EdgeTTS({
        voice,
        lang: "km-KH",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: prosody.rate,
        pitch: prosody.pitch,
        volume: prosody.volume,
        timeout: 60000
      });
      await tts.ttsPromise(text, outputPath);
      const stat = await fs.promises.stat(outputPath);
      if (!stat.size) throw new Error("សេវាសំឡេងខ្មែរបានបង្កើតឯកសារទទេ");
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable = /429|too many requests|rate.?limit|503|502|temporarily unavailable|timeout|timed out|socket hang up/i.test(message);
      await fs.promises.unlink(outputPath).catch(() => {});
      if (!retryable || attempt === attempts) break;
      await sleep(Math.min(12000, 1800 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400));
    }
  }
  throw lastError || new Error("បង្កើតសំឡេងខ្មែរមិនបាន");
}

async function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error("រកមិនឃើញ FFmpeg binary");
  return execFileAsync(ffmpegPath, args, {
    maxBuffer: 30 * 1024 * 1024,
    timeout: 15 * 60 * 1000
  });
}

async function videoDuration(filePath) {
  let output = "";
  try {
    const result = await runFfmpeg(["-hide_banner", "-i", filePath, "-t", "0", "-f", "null", "-"]);
    output = String(result.stdout || "") + "\n" + String(result.stderr || "");
  } catch (error) {
    output = String(error.stdout || "") + "\n" + String(error.stderr || "");
  }
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 30;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function extractFastAudio(videoPath, outMp3Path) {
  if (!ffmpegPath) return null;
  try {
    await runFfmpeg([
      "-y", "-i", videoPath,
      "-vn", "-acodec", "libmp3lame",
      "-ar", "16000", "-ac", "1", "-b:a", "48k",
      outMp3Path
    ]);
    const stat = await fs.promises.stat(outMp3Path);
    if (stat.size > 0) return outMp3Path;
  } catch (_) {}
  await fs.promises.unlink(outMp3Path).catch(() => {});
  return null;
}

function extractSegmentArray(payload, depth = 0) {
  if (depth > 5 || payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value) return null;
    try { return extractSegmentArray(JSON.parse(value), depth + 1); } catch (_) { return null; }
  }
  if (typeof payload !== "object") return null;
  for (const key of ["segments", "subtitles", "captions", "items", "data", "result", "transcript"]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const found = extractSegmentArray(payload[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizeSegments(input, duration) {
  const segmentArray = extractSegmentArray(input);
  if (!segmentArray) {
    throw new Error("AI មិនបានផ្ញើបញ្ជី segments ត្រឹមត្រូវទេ។ សូមសាកល្បងម្ដងទៀត។");
  }
  return segmentArray.map(item => ({
    start: Math.max(0, Number(item.start) || 0),
    end: Math.min(duration || 99999, Number(item.end) || 0),
    original: String(item.original || item.text || "").trim(),
    translation: String(item.translation || item.khmer || "").trim(),
    speakerId: String(item.speakerId || item.speaker || "").trim(),
    gender: ["male", "female"].includes(String(item.gender || item.speakerGender || "").toLowerCase())
      ? String(item.gender || item.speakerGender).toLowerCase()
      : "",
    emotion: ["neutral", "calm", "sad", "angry", "excited", "dramatic", "whisper"].includes(String(item.emotion || "").toLowerCase())
      ? String(item.emotion).toLowerCase()
      : "neutral"
  })).filter(item =>
    item.translation &&
    Number.isFinite(item.start) &&
    Number.isFinite(item.end) &&
    item.end > item.start
  ).sort((a, b) => a.start - b.start).slice(0, 600);
}

async function analyzeAndTranslateVideo(filePath, mimeType, originalName) {
  const duration = await videoDuration(filePath);
  const tmpAudio = path.join(TMP, `audio-${randomUUID()}.mp3`);
  const extractedAudio = await extractFastAudio(filePath, tmpAudio);
  const uploadPath = extractedAudio || filePath;
  const uploadMime = extractedAudio ? "audio/mpeg" : mimeType;

  let uploaded = null;
  try {
    uploaded = await uploadGeminiFile(uploadPath, uploadMime, originalName || "media");
    const prompt = `សូមស្តាប់ និងបកប្រែខ្លឹមសារជាភាសាខ្មែរឱ្យរហ័ស ធម្មជាតិ និងច្បាស់លាស់។
ត្រឡប់មកជា JSON object តែមួយគត់ តាមទម្រង់៖
{"segments":[{"start":0.0,"end":3.5,"original":"...","translation":"អត្ថបទខ្មែរ","gender":"female","emotion":"neutral"}]}`;

    const rawText = await geminiGenerate(
      VIDEO_MODEL,
      [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: uploadMime } },
          { text: prompt }
        ]
      }],
      { temperature: 0.2, responseMimeType: "application/json" }
    );

    const parsed = parseJsonObject(rawText);
    const segments = normalizeSegments(parsed, duration);
    return { duration, segments };
  } finally {
    if (extractedAudio) await fs.promises.unlink(extractedAudio).catch(() => {});
    if (uploaded?.name) await deleteGeminiFile(uploaded.name);
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

async function createDubbedVideo(req, res, segments, options = {}) {
  const validSegments = normalizeSegments({ segments }, 99999);
  if (!validSegments.length) {
    throw new Error("មិនមានឃ្លាបកប្រែត្រឹមត្រូវសម្រាប់បង្កើតសំឡេងទេ");
  }

  const work = path.join(TMP, "dub-" + randomUUID());
  await fs.promises.mkdir(work, { recursive: true });
  const output = path.join(work, "khmer-video-dub.mp4");
  const fallbackGender = req.body?.gender || "female";
  const style = req.body?.style || "cinematic";

  try {
    const segFiles = await runWithConcurrency(validSegments, TTS_CONCURRENCY, async (seg, idx) => {
      const segMp3 = path.join(work, `seg-${String(idx).padStart(4, "0")}.mp3`);
      await synthesizeKhmer(seg.translation, seg.gender || fallbackGender, segMp3, seg.emotion, style);
      return { ...seg, mp3: segMp3 };
    });

    const listPath = path.join(work, "concat.txt");
    const listLines = segFiles.map(s => `file '${s.mp3.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await fs.promises.writeFile(listPath, listLines, "utf8");

    const mergedVoice = path.join(work, "khmer-narration.mp3");
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy"app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"), error => {
    if (error && !res.headersSent) {
      res.status(200).send("Khmer AI Translator Pro backend is running.");
    }
  });
});

const healthHandler = (req, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy",
    service: "Khmer AI Translator Pro",
    timestamp: new Date().toISOString(),
    geminiConfigured: Boolean(API_KEY),
    ffmpegConfigured: Boolean(ffmpegPath)
  });
};
app.get("/api/health", healthHandler);
app.get("/health", healthHandler);

app.post("/api/translate", requireGeminiKey, asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const sourceLanguage = String(req.body?.sourceLanguage || "auto").trim();
  if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ" });
  if (text.length > MAX_TEXT_CHARS) {
    return res.status(413).json({ ok: false, error: `អត្ថបទវែងពេក (អតិបរមា ${MAX_TEXT_CHARS} តួអក្សរ)` });
  }

  const prompt = `បកប្រែអត្ថបទខាងក្រោមទៅជាភាសាខ្មែរធម្មជាតិ ត្រឹមត្រូវ និងងាយយល់។
ភាសាដើម៖ ${sourceLanguage}
ឆ្លើយតែអត្ថបទបកប្រែជាភាសាខ្មែរ៖

${text}`;

  const translation = await geminiGenerate(TEXT_MODEL, [{
    role: "user",
    parts: [{ text: prompt }]
  }], { temperature: 0.2 });

  res.json({ ok: true, sourceLanguage, translation });
}));

app.post("/api/tts", asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទខ្មែរ" });
  if (text.length > 5000) return res.status(413).json({ ok: false, error: "អត្ថបទវែងពេក (អតិបរមា 5000 តួអក្សរ)" });

  const output = path.join(TMP, `${randomUUID()}.mp3`);
  try {
    await synthesizeKhmer(text, req.body?.gender, output, req.body?.emotion || "neutral", req.body?.style || "cinematic");
    res.type("audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="khmer-voice.mp3"');
    res.sendFile(output, error => {
      fs.promises.unlink(output).catch(() => {});
      if (error && !res.headersSent) res.status(500).end();
    });
  } catch (error) {
    await fs.promises.unlink(output).catch(() => {});
    throw error;
  }
}));

app.post("/api/video/translate", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
  try {
    const result = await analyzeAndTranslateVideo(
      req.file.path,
      getMimeType(req.file),
      req.file.originalname
    );
    res.json({ ok: true, ...result });
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

app.post("/api/video/translate-and-dub", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
  try {
    const result = await analyzeAndTranslateVideo(
      req.file.path,
      getMimeType(req.file),
      req.file.originalname
    );
    if (!result.segments.length) throw new Error("រកមិនឃើញសំឡេងនិយាយក្នុងវីដេអូ");
    await createDubbedVideo(req, res, result.segments);
  } catch (error) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    throw error;
  }
}));

app.post("/api/video/jobs", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
  pruneFinishedJobs(videoJobs);
  if (activeMediaJobId) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(409).json({ ok: false, error: "មានការងារវីដេអូមួយកំពុងដំណើរការ។ សូមរង់ចាំឱ្យវាចប់សិន។" });
  }
  const id = randomUUID();
  activeMediaJobId = id;
  const job = {
    id,
    status: "processing",
    stage: "queued",
    createdAt: Date.now(),
    output: null,
    work: null,
    input: req.file.path,
    error: null,
    size: 0
  };
  videoJobs.set(id, job);
  res.status(202).json({ ok: true, jobId: id, status: job.status });

  setImmediate(async () => {
    try {
      job.stage = "analyzing_video";
      const result = await analyzeAndTranslateVideo(
        req.file.path,
        getMimeType(req.file),
        req.file.originalname
      );
      if (!result.segments.length) throw new Error("រកមិនឃើញសំឡេងនិយាយក្នុងវីដេអូ");
      job.stage = "creating_khmer_voice_and_mp4";
      const built = await createDubbedVideo(req, null, result.segments, { returnFile: true });
      job.output = built.output;
      job.work = built.work;
      job.size = built.size;
      job.duration = result.duration;
      job.segmentCount = result.segments.length;
      job.stage = "completed";
      job.status = "completed";
      job.finishedAt = Date.now();
      if (activeMediaJobId === id) activeMediaJobId = null;
    } catch (error) {
      job.status = "failed";
      job.stage = "failed";
      job.error = String(error?.message || "ដំណើរការវីដេអូមិនបាន");
      job.finishedAt = Date.now();
      if (activeMediaJobId === id) activeMediaJobId = null;
      await fs.promises.unlink(job.input).catch(() => {});
      if (job.work) await fs.promises.rm(job.work, { recursive: true, force: true }).catch(() => {});
    }
  });
}));

app.post("/api/series/jobs", requireGeminiKey, seriesUpload.array("videos", MAX_SERIES_FILES), asyncRoute(async (req, res) => {
  const files = req.files || [];
  pruneFinishedJobs(seriesJobs);
  if (activeMediaJobId) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    return res.status(409).json({ ok: false, error: "មានការងារវីដេអូមួយកំពុងដំណើរការ។ សូមរង់ចាំឱ្យវាចប់សិន។" });
  }
  if (files.length < 2) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសយ៉ាងតិច ២ ភាគ" });
  }
  if (files.length > MAX_SERIES_FILES) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    return res.status(400).json({ ok: false, error: "អាចជ្រើសរើសបានអតិបរមា ២០ ភាគ" });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_SERIES_TOTAL_MB * 1024 * 1024) {
    await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
    return res.status(413).json({ ok: false, error: `ទំហំសរុបរឿងភាគលើស ${MAX_SERIES_TOTAL_MB} MB។` });
  }

  const id = randomUUID();
  activeMediaJobId = id;
  const work = path.join(TMP, "series-" + id);
  await fs.promises.mkdir(work, { recursive: true });
  const job = {
    id, status: "processing", stage: "queued", createdAt: Date.now(),
    currentEpisode: 0, totalEpisodes: files.length,
    episodes: files.map(file => ({ name: path.basename(file.originalname || "episode.mp4"), status: "queued" })),
    inputFiles: files.map(file => file.path), output: null, work, size: 0, error: null
  };
  seriesJobs.set(id, job);
  res.status(202).json({ ok: true, jobId: id, status: job.status, totalEpisodes: files.length });

  setImmediate(async () => {
    const normalizedFiles = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const episode = job.episodes[index];
        job.currentEpisode = index + 1;
        episode.status = "processing";
        job.stage = `episode_${index + 1}_analyzing`;
        const result = await analyzeAndTranslateVideo(file.path, getMimeType(file), file.originalname);
        if (!result.segments.length) throw new Error(`ភាគ ${index + 1} មិនមានសំឡេងនិយាយដែលអាចបកប្រែបាន`);
        job.stage = `episode_${index + 1}_creating_khmer_voice`;
        const built = await createDubbedVideo({ file, body: req.body }, null, result.segments, { returnFile: true });
        const normalized = path.join(work, `episode-${String(index + 1).padStart(2, "0")}.mp4`);
        job.stage = `episode_${index + 1}_preparing_video`;
        await runFfmpeg([
          "-y", "-i", built.output,
          "-vf", "scale=432:768:force_original_aspect_ratio=decrease,pad=432:768:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1",
          "-map", "0:v:0", "-map", "0:a:0",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-threads", "1",
          "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
          "-movflags", "+faststart", normalized
        ]);
        normalizedFiles.push(normalized);
        episode.status = "completed";
        episode.duration = result.duration;
        await fs.promises.unlink(file.path).catch(() => {});
        await fs.promises.rm(built.work, { recursive: true, force: true }).catch(() => {});
      }

      job.stage = "joining_all_episodes";
      const concatList = path.join(work, "episodes.txt");
      const listContent = normalizedFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
      await fs.promises.writeFile(concatList, listContent, "utf8");
      job.output = path.join(work, "Khmer-Complete-Series.mp4");
      await runFfmpeg([
        "-y", "-f", "concat", "-safe", "0", "-i", concatList,
        "-c", "copy", "-movflags", "+faststart", job.output
      ]);
      const stat = await fs.promises.stat(job.output);
      if (!stat.size) throw new Error("មិនអាចបង្កើតវីដេអូរឿងភាគចុងក្រោយបាន");
      job.size = stat.size;
      job.stage = "completed";
      job.status = "completed";
      job.finishedAt = Date.now();
      if (activeMediaJobId === id) activeMediaJobId = null;
    } catch (error) {
      job.status = "failed";
      job.stage = "failed";
      job.error = String(error?.message || "បកប្រែរឿងភាគមិនបាន");
      job.finishedAt = Date.now();
      if (activeMediaJobId === id) activeMediaJobId = null;
      await Promise.all(job.inputFiles.map(file => fs.promises.unlink(file).catch(() => {})));
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
}));

app.get("/api/series/jobs/:id", (req, res) => {
  const job = seriesJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងាររឿងភាគនេះ ឬវាបានផុតកំណត់" });
  res.json({
    ok: true, jobId: job.id, status: job.status, stage: job.stage,
    currentEpisode: job.currentEpisode, totalEpisodes: job.totalEpisodes,
    episodes: job.episodes, size: job.size || 0, error: job.error
  });
});

app.get("/api/series/jobs/:id/download", (req, res) => {
  const job = seriesJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងាររឿងភាគនេះ ឬវាបានផុតកំណត់" });
  if (job.status !== "completed" || !job.output) {
    return res.status(409).json({ ok: false, error: "រឿងភាគមិនទាន់ភ្ជាប់រួចរាល់ទេ" });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", String(job.size));
  res.setHeader("Content-Disposition", 'attachment; filename="Khmer-Complete-Series.mp4"');
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(job.output, error => {
    if (error) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: "ទាញយកវីដេអូរឿងភាគមិនបាន។" });
      else res.destroy(error);
      return;
    }
    fs.promises.rm(job.work, { recursive: true, force: true }).catch(() => {});
    seriesJobs.delete(job.id);
  });
});

app.get("/api/video/jobs/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារវីដេអូនេះ ឬវាបានផុតកំណត់" });
  res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    error: job.error,
    size: job.size || 0,
    duration: job.duration || 0,
    segmentCount: job.segmentCount || 0
  });
});

app.get("/api/video/jobs/:id/download", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារវីដេអូនេះ ឬវាបានផុតកំណត់" });
  if (job.status !== "completed" || !job.output) {
    return res.status(409).json({ ok: false, error: "វីដេអូមិនទាន់រួចរាល់ទេ" });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", String(job.size));
  res.setHeader("Content-Disposition", 'attachment; filename="khmer-video-dub.mp4"');
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(job.output, error => {
    if (error) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: "ទាញយក MP4 មិនបាន។" });
      else res.destroy(error);
      return;
    }
    fs.promises.unlink(job.input).catch(() => {});
    if (job.work) fs.promises.rm(job.work, { recursive: true, force: true }).catch(() => {});
    videoJobs.delete(job.id);
  });
});

app.post("/api/dub", upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
  let segments;
  try {
    segments = JSON.parse(req.body?.segments || "[]");
  } catch (_) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ ok: false, error: "ទិន្នន័យចំណងជើងរងមិនត្រឹមត្រូវ" });
  }
  await createDubbedVideo(req, res, segments);
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      ok: false,
      error: `ឯកសារធំពេក ឬមិនអាចទទួលយកបាន។ កម្រិតអតិបរមា ${MAX_VIDEO_MB} MB`
    });
  }
  console.error("[API ERROR]", err);
  const message = String(err?.message || "");
  const quotaLimited = isQuotaOrRateLimitError(err);
  const dailyQuota = quotaLimited && isDailyQuotaError(err);
  const temporary = isTemporaryGeminiError(err);
  const status = quotaLimited ? 429 : (temporary ? 503 : (Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500));
  const khmerMessage = quotaLimited
    ? (dailyQuota
      ? "កូតា Gemini ប្រចាំថ្ងៃបានអស់ហើយ។ សូមរង់ចាំឱ្យកូតាកំណត់ឡើងវិញ។"
      : "Gemini បានកំណត់ចំនួនសំណើ (HTTP 429)។ សូមរង់ចាំបន្តិច រួចសាកល្បងម្ដងទៀត។")
    : (temporary
      ? "សេវា AI កំពុងមមាញឹកជាបណ្ដោះអាសន្ន។ សូមរង់ចាំបន្តិច រួចសាកល្បងម្ដងទៀត។"
      : (/API key|permission|unauthorized|forbidden/i.test(message)
        ? "ការភ្ជាប់ Gemini API Key មានបញ្ហា។ សូមពិនិត្យ GEMINI_API_KEY ក្នុង Environment។"
        : message || "មានបញ្ហាក្នុងម៉ាស៊ីនមេ"));
  res.status(status).json({ ok: false, error: khmerMessage, retryable: temporary || quotaLimited });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Khmer AI Translator Pro backend running on port ${PORT}`);
});
    
