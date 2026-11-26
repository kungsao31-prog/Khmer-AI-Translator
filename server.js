"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { EdgeTTS } = require("node-edge-tts");
const ffmpegPath = require("ffmpeg-static");
const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// OpenAI fallback is opt-in; Gemini remains the default provider.
const ENABLE_OPENAI_FALLBACK = String(process.env.ENABLE_OPENAI_FALLBACK || "false").toLowerCase() === "true";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/files";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const normalizeModel = value => String(value || "").trim().replace(/^models\//, "");
const configuredTextModel = normalizeModel(process.env.GEMINI_TEXT_MODEL);
const configuredVideoModel = normalizeModel(process.env.GEMINI_VIDEO_MODEL);
// Automatically replace the retired default so existing Render variables do not keep calling it.
const TEXT_MODEL = !configuredTextModel || configuredTextModel === "gemini-2.5-flash"
  ? "gemini-3.8-flash"
  : configuredTextModel;
const VIDEO_MODEL = !configuredVideoModel || configuredVideoModel === "gemini-2.5-flash"
  ? "gemini-3.8-flash"
  : configuredVideoModel;
const TMP = process.env.TMP_DIR || path.join(os.tmpdir(), "khmer-ai-translator");
const MAX_VIDEO_MB = Math.max(50, Number(process.env.MAX_VIDEO_MB || 2048));
const MAX_SERIES_FILES = 20;
const MAX_SERIES_TOTAL_MB = Math.max(MAX_VIDEO_MB, Number(process.env.MAX_SERIES_TOTAL_MB || 4096));
const MAX_TEXT_CHARS = 30000;
const TTS_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.TTS_CONCURRENCY || 2)));
const videoJobs = new Map();
const seriesJobs = new Map();
let activeMediaJobId = null;

fs.mkdirSync(TMP, { recursive: true });
app.disable("x-powered-by");
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map(x => x.trim()) : false, credentials: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
require("./security")(app);

const staticDir = ["WWW", "www", "public"]
  .map(dir => path.join(__dirname, dir))
  .find(dir => fs.existsSync(dir)) || path.join(__dirname, "WWW");
app.use(express.static(staticDir, { index: "index.html", maxAge: "1h" }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || "video.mp4").slice(0, 12)}`)
});
const fileFilter = (_req, file, cb) => {
  const allowed = /^(video|audio)\//i.test(file.mimetype || "") || /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac)$/i.test(file.originalname || "");
  cb(allowed ? null : new Error("ទម្រង់ឯកសារនេះមិនត្រូវបានគាំទ្រទេ"), allowed);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 } });
const seriesUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: MAX_SERIES_FILES } });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
function requireAnyAI(_req, res, next) {
  if (!API_KEY && !(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) return res.status(503).json({ ok: false, error: "សូមកំណត់ GEMINI_API_KEY នៅលើ Render Environment" });
  next();
}
function getMimeType(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = path.extname(file?.originalname || "").toLowerCase();
  return ({ ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac" })[ext] || "application/octet-stream";
}
function pruneFinishedJobs(map) {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of map) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      if (job.work) fs.promises.rm(job.work, { recursive: true, force: true }).catch(() => {});
      if (job.input) fs.promises.unlink(job.input).catch(() => {});
      map.delete(id);
    }
  }
}
function parseJsonObject(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch (_) {
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Gemini បានឆ្លើយតបមិនមែនជា JSON ត្រឹមត្រូវទេ");
  }
}
async function geminiGenerate(model, contents, options = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({ contents, generationConfig: options });
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const text = (data?.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\n").trim();
        if (!text) throw new Error("Gemini មិនបានផ្ញើអត្ថបទត្រឡប់មកវិញទេ");
        return text;
      }
      const message = data?.error?.message || `Gemini API error (${response.status})`;
      lastError = new Error(message);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw lastError;
      console.warn(`Gemini temporary error ${response.status}; retry ${attempt + 1}/3`);
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !/fetch failed|network|timeout|temporarily unavailable/i.test(String(error.message || error))) throw error;
    }
    await sleep(1500 * (2 ** attempt));
  }
  throw lastError || new Error("Gemini API មិនអាចដំណើរការបានទេ");
}
async function uploadGeminiFile(filePath, mimeType, displayName) {
  const stat = await fs.promises.stat(filePath);
  const start = await fetch(GEMINI_UPLOAD_BASE, {
    method: "POST",
    headers: {
      "x-goog-api-key": API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(stat.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: String(displayName || "uploaded-media").slice(0, 100) } })
  });
  if (!start.ok) {
    const err = await start.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini upload start failed (${start.status})`);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini មិនបានផ្ដល់ Upload URL");
  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(stat.size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Type": mimeType },
    body: fs.createReadStream(filePath),
    duplex: "half"
  });
  const uploaded = await finish.json().catch(() => ({}));
  if (!finish.ok) throw new Error(uploaded?.error?.message || `Gemini upload failed (${finish.status})`);
  let file = uploaded.file || uploaded;
  for (let attempt = 0; attempt < 60 && file.state === "PROCESSING"; attempt++) {
    await sleep(2000);
    const check = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { headers: { "x-goog-api-key": API_KEY } });
    const checked = await check.json().catch(() => ({}));
    if (!check.ok) throw new Error(checked?.error?.message || "ពិនិត្យស្ថានភាពឯកសារនៅ Gemini មិនបាន");
    file = checked;
  }
  if (file.state && file.state !== "ACTIVE") throw new Error(`Gemini មិនអាចដំណើរការឯកសារនេះបានទេ (state: ${file.state})`);
  if (!file.uri) throw new Error("Gemini មិនបានផ្ដល់ File URI");
  return file;
}
async function deleteGeminiFile(name) {
  if (!name) return;
  try { await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": API_KEY } }); } catch (_) {}
}

async function openAIJsonRequest(url, body, options = {}) {
  if (!OPENAI_API_KEY) throw new Error("មិនទាន់កំណត់ OPENAI_API_KEY នៅលើ Render ទេ");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...(options.headers || {}) },
    body,
    signal: AbortSignal.timeout(options.timeout || 180000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API error (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function openAITranslateSegments(segments) {
  const translated = [];
  for (let offset = 0; offset < segments.length; offset += 40) {
    const batch = segments.slice(offset, offset + 40);
    const body = JSON.stringify({
      model: OPENAI_TEXT_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a professional audiovisual translator. Translate every input segment into natural, accurate Khmer and infer whether the speaker is male or female from dialogue context. Preserve meaning, names, tone, and segment order. Return only JSON: {\"translations\":[{\"index\":0,\"speaker\":\"male\",\"text\":\"Khmer translation\"}]}. Use only \"male\" or \"female\" for speaker. Do not omit any index." },
        { role: "user", content: JSON.stringify({ segments: batch.map((item, i) => ({ index: offset + i, text: item.text })) }) }
      ]
    });
    const result = await openAIJsonRequest("https://api.openai.com/v1/chat/completions", body, {
      headers: { "Content-Type": "application/json" },
      timeout: 180000
    });
    const content = result?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonObject(content);
    const rows = Array.isArray(parsed.translations) ? parsed.translations : [];
    for (let i = 0; i < batch.length; i++) {
      const row = rows.find(item => Number(item.index) === offset + i) || rows[i];
      const text = String(row?.text || "").trim();
      if (!text) throw new Error(`OpenAI មិនបានបកប្រែប្រយោគទី ${offset + i + 1}`);
      translated.push({ ...batch[i], speaker: row?.speaker || "female", text });
    }
  }
  return translated;
}

async function analyzeVideoWithOpenAI(filePath) {
  if (!OPENAI_API_KEY) throw new Error("មិនទាន់កំណត់ OPENAI_API_KEY នៅលើ Render ទេ");
  const workDir = path.join(TMP, `openai-audio-${randomUUID()}`);
  await fs.promises.mkdir(workDir, { recursive: true });
  try {
    const pattern = path.join(workDir, "audio-%03d.mp3");
    await runFfmpeg([
      "-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libmp3lame", "-b:a", "48k",
      "-f", "segment", "-segment_time", "480", "-reset_timestamps", "1",
      pattern
    ], 60 * 60 * 1000);
    const chunks = (await fs.promises.readdir(workDir))
      .filter(name => /^audio-\d+\.mp3$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!chunks.length) throw new Error("មិនអាចដកសំឡេងពីវីដេអូបានទេ");

    const sourceSegments = [];
    let sourceLanguage = "unknown";
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(workDir, chunks[i]);
      const stat = await fs.promises.stat(chunkPath);
      if (stat.size > 24 * 1024 * 1024) throw new Error("ផ្នែកសំឡេងធំពេកសម្រាប់ OpenAI។ សូមបំបែកវីដេអូជាផ្នែកខ្លីជាងនេះ");
      const audio = await fs.promises.readFile(chunkPath);
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/mpeg" }), chunks[i]);
      form.append("model", OPENAI_TRANSCRIBE_MODEL);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      const transcript = await openAIJsonRequest("https://api.openai.com/v1/audio/transcriptions", form, { timeout: 300000 });
      if (i === 0 && transcript.language) sourceLanguage = transcript.language;
      const chunkOffset = i * 480;
      for (const segment of (transcript.segments || [])) {
        const text = String(segment.text || "").trim();
        const start = Number(segment.start);
        const end = Number(segment.end);
        if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
          sourceSegments.push({ start: start + chunkOffset, end: end + chunkOffset, text });
        }
      }
    }
    if (!sourceSegments.length) throw new Error("OpenAI មិនអាចរកឃើញប្រយោគនិយាយក្នុងវីដេអូនេះទេ");
    const khmerSegments = await openAITranslateSegments(sourceSegments);
    return { sourceLanguage, segments: normalizeSegments(khmerSegments), provider: "OpenAI" };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function analyzeVideoWithFallback(filePath, originalName) {
  if (API_KEY) {
    try {
      const result = await analyzeVideoWithGemini(filePath, originalName);
      return { ...result, provider: "Gemini" };
    } catch (error) {
      if (!(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) throw error;
      console.warn("Gemini video analysis failed; trying enabled OpenAI fallback:", error.message);
    }
  } else if (!(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) {
    throw new Error("មិនទាន់កំណត់ GEMINI_API_KEY នៅលើ Render ទេ");
  }
  return analyzeVideoWithOpenAI(filePath);
}

function runWithConcurrency(items, limit, worker) {
  let next = 0;
  const results = new Array(items.length);

  async function runWorker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  return Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => runWorker()
    )
  ).then(() => results);
}

function normalizeSpeaker(rawSpeaker, rawText = "") {
  const s = String(rawSpeaker || "").trim().toLowerCase();
  if (["male", "m", "man", "boy", "ប្រុស"].includes(s)) return "male";
  if (["female", "f", "woman", "girl", "ស្រី"].includes(s)) return "female";
  if (/^\s*\[\s*(?:m|male)\s*\]/i.test(rawText)) return "male";
  return "female";
}

function normalizeSegments(input) {
  const raw = Array.isArray(input) ? input : input?.segments;

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("មិនមានប្រយោគសម្រាប់បកប្រែទេ");
  }

  return raw.map((item, index) => {
    const start = Number(item.start ?? item.startTime ?? item.start_seconds);
    const end = Number(item.end ?? item.endTime ?? item.end_seconds);
    const rawText = String(
      item.khmer || item.translation || item.text || ""
    ).trim();
    const speaker = normalizeSpeaker(
      item.speaker || item.gender || item.voice,
      rawText
    );
    const text = rawText
      .replace(/^\s*\[\s*(?:m|f|male|female)\s*\]\s*[:\-]?\s*/i, "")
      .trim();

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`ពេលវេលានៅផ្នែកទី ${index + 1} មិនត្រឹមត្រូវទេ`);
    }

    if (!text) {
      throw new Error(`មិនមានអត្ថបទនៅផ្នែកទី ${index + 1} ទេ`);
    }

    return {
      index,
      start: Math.max(0, start),
      end,
      speaker,
      text
    };
  }).sort((a, b) => a.start - b.start);
}

async function analyzeVideoWithGemini(filePath, originalName) {
  const mimeType = getMimeType({
    originalname: originalName,
    mimetype: ""
  });

  const uploaded = await uploadGeminiFile(
    filePath,
    mimeType,
    originalName || "video"
  );

  try {
    const prompt = `
អ្នកជាអ្នកបកប្រែវីដេអូ និងបែងចែកសំឡេងតួអង្គពីភាសាបរទេសទៅជាភាសាខ្មែរ។

សូមស្តាប់ និងមើលវីដេអូ ដើម្បីវិភាគសំឡេងនិយាយរបស់តួអង្គនីមួយៗ៖
1. បកប្រែអត្ថន័យឱ្យបានត្រឹមត្រូវ ជាភាសាខ្មែរធម្មជាតិ។
2. សម្គាល់ភេទរបស់អ្នកនិយាយក្នុងប្រយោគនីមួយៗដោយស្វ័យប្រវត្តិ៖
   - ប្រសិនបើជាសំឡេងតួអង្គប្រុស សូមដាក់ "speaker": "male"
   - ប្រសិនបើជាសំឡេងតួអង្គស្រី ឬអ្នកនិទានរឿងសំឡេងស្រី សូមដាក់ "speaker": "female"
3. រក្សាលំដាប់ពេលវេលាដើមរបស់អ្នកនិយាយ និងបំបែកប្រយោគនៅពេលប្តូរអ្នកនិយាយ។

ឆ្លើយតែ JSON តាមទម្រង់នេះ៖
{
  "sourceLanguage": "ភាសាដើម",
  "segments": [
    {
      "start": 0.0,
      "end": 4.5,
      "speaker": "male",
      "text": "អត្ថបទបកប្រែជាភាសាខ្មែរ"
    },
    {
      "start": 4.6,
      "end": 8.2,
      "speaker": "female",
      "text": "អត្ថបទបកប្រែជាភាសាខ្មែរ"
    }
  ]
}

ចំណាំ៖
- start និង end គិតជាវិនាទី។
- speaker ត្រូវប្រើតែពាក្យ "male" ឬ "female" ប៉ុណ្ណោះ។
- កុំបង្កើតពេលវេលាដោយស្មាន ប្រសិនបើមិនអាចកំណត់បាន។
- កុំរំលងប្រយោគសំខាន់ៗ។
- កុំបន្ថែមការពន្យល់ក្រៅពី JSON។
`;

    const responseText = await geminiGenerate(
      VIDEO_MODEL,
      [{
        role: "user",
        parts: [
          {
            fileData: {
              mimeType,
              fileUri: uploaded.uri
            }
          },
          { text: prompt }
        ]
      }],
      {
        responseMimeType: "application/json",
        temperature: 0.2
      }
    );

    const result = parseJsonObject(responseText);
    const segments = normalizeSegments(result);

    return {
      sourceLanguage: result.sourceLanguage || "unknown",
      segments
    };
  } finally {
    await deleteGeminiFile(uploaded.name);
  }
}

async function translateTextToKhmer(text) {
  const input = String(text || "").trim();

  if (!input) {
    throw new Error("សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ");
  }

  if (input.length > MAX_TEXT_CHARS) {
    throw new Error(`អត្ថបទវែងពេក។ អនុញ្ញាតអតិបរមា ${MAX_TEXT_CHARS} តួអក្សរ`);
  }

  if (API_KEY) {
    try {
      return await geminiGenerate(
        TEXT_MODEL,
        [{
          role: "user",
          parts: [{
            text: `បកប្រែអត្ថបទខាងក្រោមទៅជាភាសាខ្មែរធម្មជាតិ។ រក្សាអត្ថន័យដើម និងកុំបន្ថែមការពន្យល់៖\n\n${input}`
          }]
        }],
        { temperature: 0.2 }
      );
    } catch (error) {
      if (!(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) throw error;
      console.warn("Gemini text translation failed; trying enabled OpenAI fallback:", error.message);
    }
  } else if (!(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) {
    throw new Error("មិនទាន់កំណត់ GEMINI_API_KEY នៅលើ Render ទេ");
  }
  const result = await openAIJsonRequest("https://api.openai.com/v1/chat/completions", JSON.stringify({
    model: OPENAI_TEXT_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: "Translate the user's text into natural Khmer. Preserve meaning and return only the translated text without explanation." },
      { role: "user", content: input }
    ]
  }), { headers: { "Content-Type": "application/json" }, timeout: 180000 });
  const translated = result?.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error("OpenAI មិនបានផ្ញើអត្ថបទបកប្រែត្រឡប់មកវិញទេ");
  return translated;
}

async function createKhmerSpeech(text, outputPath, voice = "female") {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    throw new Error("មិនមានអត្ថបទសម្រាប់បង្កើតសំឡេងទេ");
  }

  const selectedVoice =
    voice === "male"
      ? "km-KH-PisethNeural"
      : "km-KH-SreymomNeural";

  const tts = new EdgeTTS({
    voice: selectedVoice,
    lang: "km-KH",
    outputForm
