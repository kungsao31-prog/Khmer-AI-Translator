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
const ENABLE_OPENAI_FALLBACK = String(process.env.ENABLE_OPENAI_FALLBACK || "false").toLowerCase() === "true";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const normalizeModel = v => String(v || "").trim().replace(/^models\//, "");
const cfgText = normalizeModel(process.env.GEMINI_TEXT_MODEL);
const cfgVideo = normalizeModel(process.env.GEMINI_VIDEO_MODEL);
const TEXT_MODEL = !cfgText || cfgText === "gemini-2.5-flash" ? "gemini-3.8-flash" : cfgText;
const VIDEO_MODEL = !cfgVideo || cfgVideo === "gemini-2.5-flash" ? "gemini-3.8-flash" : cfgVideo;
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

const staticDir = ["WWW", "www", "public"].map(d => path.join(__dirname, d)).find(d => fs.existsSync(d)) || path.join(__dirname, "WWW");
app.use(express.static(staticDir, { index: "index.html", maxAge: "1h" }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || "video.mp4").slice(0, 12)}`)
});
const fileFilter = (_req, file, cb) => {
  const ok = /^(video|audio)\//i.test(file.mimetype || "") || /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac)$/i.test(file.originalname || "");
  cb(ok ? null : new Error("ទម្រង់ឯកសារនេះមិនត្រូវបានគាំទ្រទេ"), ok);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 } });
const seriesUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: MAX_SERIES_FILES } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function requireAnyAI(_req, res, next) {
  if (!API_KEY && !(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) {
    return res.status(503).json({ ok: false, error: "សូមកំណត់ GEMINI_API_KEY នៅលើ Render Environment" });
  }
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
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
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
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
        body
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
        if (!text) throw new Error("Gemini មិនបានផ្ញើអត្ថបទត្រឡប់មកវិញទេ");
        return text;
      }
      lastError = new Error(data?.error?.message || `Gemini API error (${res.status})`);
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 3) throw lastError;
    } catch (err) {
      lastError = err;
      if (attempt === 3 || !/fetch failed|network|timeout|temporarily unavailable/i.test(String(err.message || err))) throw err;
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
  for (let i = 0; i < 60 && file.state === "PROCESSING"; i++) {
    await sleep(2000);
    const check = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { headers: { "x-goog-api-key": API_KEY } });
    const checked = await check.json().catch(() => ({}));
    if (!check.ok) throw new Error(checked?.error?.message || "ពិនិត្យស្ថានភាពឯកសារនៅ Gemini មិនបាន");
    file = checked;
  }
  if (file.state && file.state !== "ACTIVE") throw new Error(`Gemini មិនអាចដំណើរការឯកសារនេះបានទេ (${file.state})`);
  if (!file.uri) throw new Error("Gemini មិនបានផ្ដល់ File URI");
  return file;
}

async function deleteGeminiFile(name) {
  if (!name) return;
  try { await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": API_KEY } }); } catch (_) {}
}

async function openAIJsonRequest(url, body, options = {}) {
  if (!OPENAI_API_KEY) throw new Error("មិនទាន់កំណត់ OPENAI_API_KEY នៅលើ Render ទេ");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...(options.headers || {}) },
    body,
    signal: AbortSignal.timeout(options.timeout || 180000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  return data;
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
  if (!Array.isArray(raw) || !raw.length) throw new Error("មិនមានប្រយោគសម្រាប់បកប្រែទេ");
  return raw.map((item, index) => {
    const start = Number(item.start ?? item.startTime ?? item.start_seconds);
    const end = Number(item.end ?? item.endTime ?? item.end_seconds);
    const rawText = String(item.khmer || item.translation || item.text || "").trim();
    const speaker = normalizeSpeaker(item.speaker || item.gender || item.voice, rawText);
    const text = rawText.replace(/^\s*\[\s*(?:m|f|male|female)\s*\]\s*[:\-]?\s*/i, "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`ពេលវេលានៅផ្នែកទី ${index + 1} មិនត្រឹមត្រូវទេ`);
    if (!text) throw new Error(`មិនមានអត្ថបទនៅផ្នែកទី ${index + 1} ទេ`);
    return { index, start: Math.max(0, start), end, speaker, text };
  }).sort((a, b) => a.start - b.start);
}

async function analyzeVideoWithGemini(filePath, originalName) {
  const mimeType = getMimeType({ originalname: originalName, mimetype: "" });
  const uploaded = await uploadGeminiFile(filePath, mimeType, originalName || "video");
  try {
    const prompt = `អ្នកជាអ្នកបកប្រែវីដេអូ និងបែងចែកសំឡេងតួអង្គពីភាសាបរទេសទៅជាភាសាខ្មែរ។
សូមស្តាប់ និងមើលវីដេអូ ដើម្បីវិភាគសំឡេងនិយាយរបស់តួអង្គនីមួយៗ៖
1. បកប្រែអត្ថន័យឱ្យបានត្រឹមត្រូវ ជាភាសាខ្មែរធម្មជាតិ។
2. សម្គាល់ភេទរបស់អ្នកនិយាយក្នុងប្រយោគនីមួយៗដោយស្វ័យប្រវត្តិ៖
   - សំឡេងតួអង្គប្រុស ដាក់ "speaker": "male"
   - សំឡេងតួអង្គស្រី ឬអ្នកនិទានរឿងសំឡេងស្រី ដាក់ "speaker": "female"
3. រក្សាលំដាប់ពេលវេលាដើម និងបំបែកប្រយោគនៅពេលប្តូរអ្នកនិយាយ។
ឆ្លើយតែ JSON តាមទម្រង់នេះ៖
{"sourceLanguage":"ភាសាដើម","segments":[{"start":0.0,"end":4.5,"speaker":"male","text":"អត្ថបទខ្មែរ"},{"start":4.6,"end":8.2,"speaker":"female","text":"អត្ថបទខ្មែរ"}]}
ចំណាំ៖ start និង end គិតជាវិនាទី។ speaker ប្រើតែ "male" ឬ "female"។ កុំបន្ថែមអក្សរក្រៅពី JSON។`;

    const responseText = await geminiGenerate(
      VIDEO_MODEL,
      [{ role: "user", parts: [{ fileData: { mimeType, fileUri: uploaded.uri } }, { text: prompt }] }],
      { responseMimeType: "application/json", temperature: 0.2 }
    );
    const result = parseJsonObject(responseText);
    return { sourceLanguage: result.sourceLanguage || "unknown", segments: normalizeSegments(result) };
  } finally {
    await deleteGeminiFile(uploaded.name);
  }
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
        { role: "system", content: "Translate into natural Khmer and infer speaker gender. Return only JSON: {\"translations\":[{\"index\":0,\"speaker\":\"male\",\"text\":\"Khmer\"}]}. Use only \"male\" or \"female\"." },
        { role: "user", content: JSON.stringify({ segments: batch.map((item, i) => ({ index: offset + i, text: item.text })) }) }
      ]
    });
    const result = await openAIJsonRequest("https://api.openai.com/v1/chat/completions", body, {
      headers: { "Content-Type": "application/json" },
      timeout: 180000
    });
    const parsed = parseJsonObject(result?.choices?.[0]?.message?.content || "");
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
    await runFfmpeg(["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", "-f", "segment", "-segment_time", "480", "-reset_timestamps", "1", pattern], 60 * 60 * 1000);
    const chunks = (await fs.promises.readdir(workDir)).filter(n => /^audio-\d+\.mp3$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!chunks.length) throw new Error("មិនអាចដកសំឡេងពីវីដេអូបានទេ");
    const sourceSegments = [];
    let sourceLanguage = "unknown";
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(workDir, chunks[i]);
      const stat = await fs.promises.stat(chunkPath);
      if (stat.size > 24 * 1024 * 1024) throw new Error("ផ្នែកសំឡេងធំពេកសម្រាប់ OpenAI");
      const audio = await fs.promises.readFile(chunkPath);
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/mpeg" }), chunks[i]);
      form.append("model", OPENAI_TRANSCRIBE_MODEL);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      const transcript = await openAIJsonRequest("https://api.openai.com/v1/audio/transcriptions", form, { timeout: 300000 });
      if (i === 0 && transcript.language) sourceLanguage = transcript.language;
      for (const seg of (transcript.segments || [])) {
        const text = String(seg.text || "").trim();
        const start = Number(seg.start);
        const end = Number(seg.end);
        if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
          sourceSegments.push({ start: start + i * 480, end: end + i * 480, text });
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
      console.warn("Gemini failed; trying OpenAI fallback:", error.message);
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
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker())).then(() => results);
}

async function translateTextToKhmer(text) {
  const input = String(text || "").trim();
  if (!input) throw new Error("សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ");
  if (input.length > MAX_TEXT_CHARS) throw new Error(`អត្ថបទវែងពេក (អតិបរមា ${MAX_TEXT_CHARS} តួអក្សរ)`);
  if (API_KEY) {
    try {
      return await geminiGenerate(TEXT_MODEL, [{ role: "user", parts: [{ text: `បកប្រែអត្ថបទខាងក្រោមទៅជាភាសាខ្មែរធម្មជាតិ។ រក្សាអត្ថន័យដើម និងកុំបន្ថែមការពន្យល់៖\n\n${input}` }] }], { temperature: 0.2 });
    } catch (error) {
      if (!(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) throw error;
    }
  } else if (!(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY)) {
    throw new Error("មិនទាន់កំណត់ GEMINI_API_KEY នៅលើ Render ទេ");
  }
  const result = await openAIJsonRequest("https://api.openai.com/v1/chat/completions", JSON.stringify({
    model: OPENAI_TEXT_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: "Translate into natural Khmer. Return only the translated text." },
      { role: "user", content: input }
    ]
  }), { headers: { "Content-Type": "application/json" }, timeout: 180000 });
  const translated = result?.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error("OpenAI មិនបានផ្ញើអត្ថបទបកប្រែត្រឡប់មកវិញទេ");
  return translated;
}
async function createKhmerSpeech(text, outputPath, voice = "female") {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("មិនមានអត្ថបទសម្រាប់បង្កើតសំឡេងទេ");
  const selectedVoice = voice === "male" ? "km-KH-PisethNeural" : "km-KH-SreymomNeural";
  const tts = new EdgeTTS({
    voice: selectedVoice,
    lang: "km-KH",
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    timeout: 60000
  });
  await tts.ttsPromise(cleanText, outputPath);
  const stat = await fs.promises.stat(outputPath);
  if (!stat.size) throw new Error("ការបង្កើតសំឡេងខ្មែរបរាជ័យ");
  return outputPath;
}

async function getMediaDuration(filePath) {
  if (!ffmpegPath) return null;
  try {
    await execFileAsync(ffmpegPath, ["-i", filePath], { timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    const output = String(error.stderr || error.stdout || "");
    const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) {
      const total = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }
  return null;
}

async function runFfmpeg(args, timeout = 30 * 60 * 1000) {
  if (!ffmpegPath) throw new Error("មិនអាចរកឃើញ FFmpeg នៅលើ Server");
  try {
    return await execFileAsync(ffmpegPath, args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    const detail = String(error.stderr || error.message || "");
    throw new Error(`FFmpeg បរាជ័យ៖ ${detail.slice(-1500)}`);
  }
}

async function createDubbedVideo(options) {
  const { inputPath, outputPath, segments, voice = "auto", workDir, duration } = options;
  if (!Array.isArray(segments) || !segments.length) throw new Error("មិនមានប្រយោគសម្រាប់បង្កើតសំឡេងទេ");
  await fs.promises.mkdir(workDir, { recursive: true });
  const audioFiles = [];
  try {
    await runWithConcurrency(segments, TTS_CONCURRENCY, async (segment, index) => {
      const audioPath = path.join(workDir, `speech-${String(index).padStart(5, "0")}.mp3`);
      const segmentVoice = voice === "male" ? "male" : voice === "female_only" ? "female" : (segment.speaker === "male" ? "male" : "female");
      await createKhmerSpeech(segment.text, audioPath, segmentVoice);
      audioFiles[index] = audioPath;
    });
    const args = ["-y", "-i", inputPath];
    for (const audioPath of audioFiles) args.push("-i", audioPath);
    const filters = [];
    const mixInputs = [];
    for (let i = 0; i < segments.length; i++) {
      const delay = Math.max(0, Math.round(segments[i].start * 1000));
      filters.push(`[${i + 1}:a]adelay=${delay}:all=1,aresample=44100[voice${i}]`);
      mixInputs.push(`[voice${i}]`);
    }
    filters.push(`${mixInputs.join("")}amix=inputs=${segments.length}:duration=longest:dropout_transition=0:normalize=0,aresample=44100,apad[mixed]`);
    args.push("-filter_complex", filters.join(";"), "-map", "0:v:0?", "-map", "[mixed]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart");
    if (Number.isFinite(duration) && duration > 0) args.push("-t", String(duration));
    args.push(outputPath);
    await runFfmpeg(args, 60 * 60 * 1000);
    const outStat = await fs.promises.stat(outputPath);
    if (!outStat.size) throw new Error("វីដេអូ MP4 ដែលបានបង្កើតមានទំហំសូន្យ");
    return { outputPath, size: outStat.size, duration: duration || null, segments: segments.length };
  } finally {
    for (const f of audioFiles) if (f) await fs.promises.unlink(f).catch(() => {});
  }
}

function createJob(map, inputPath, originalName, voice) {
  const id = randomUUID();
  const job = {
    id, status: "queued", progress: 0, message: "កំពុងរង់ចាំដំណើរការ",
    originalName, voice, input: inputPath, output: null, work: path.join(TMP, id),
    error: null, segments: [], sourceLanguage: null, createdAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
  map.set(id, job);
  return job;
}

function updateJob(job, status, progress, message) {
  job.status = status;
  job.progress = Math.max(0, Math.min(100, Number(progress) || 0));
  job.message = message || "";
  job.updatedAt = Date.now();
}

async function processVideoJob(job) {
  if (activeMediaJobId) throw new Error("មានការងារវីដេអូមួយកំពុងដំណើរការរួចហើយ");
  activeMediaJobId = job.id;
  try {
    updateJob(job, "processing", 5, "កំពុងរៀបចំវីដេអូ");
    await fs.promises.mkdir(job.work, { recursive: true });
    updateJob(job, "processing", 15, "កំពុងវិភាគ បែងចែកតួអង្គ និងបកប្រែសំឡេង");
    const analysis = await analyzeVideoWithFallback(job.input, job.originalName);
    job.provider = analysis.provider;
    job.segments = analysis.segments;
    job.sourceLanguage = analysis.sourceLanguage;
    updateJob(job, "processing", 45, "បានបកប្រែរួច កំពុងបង្កើតសំឡេងប្រុស និងស្រី");
    const duration = await getMediaDuration(job.input);
    const outputPath = path.join(job.work, "khmer-dubbed.mp4");
    await createDubbedVideo({ inputPath: job.input, outputPath, segments: job.segments, voice: job.voice, workDir: job.work, duration });
    job.output = outputPath;
    updateJob(job, "completed", 100, "បង្កើតវីដេអូខ្មែររួចរាល់");
    job.finishedAt = Date.now();
  } catch (error) {
    job.error = error.message || "មានបញ្ហាក្នុងការដំណើរការវីដេអូ";
    updateJob(job, "failed", 0, job.error);
    job.finishedAt = Date.now();
  } finally {
    activeMediaJobId = null;
  }
}

function startVideoJob(job) {
  processVideoJob(job).catch(err => {
    job.error = err.message;
    updateJob(job, "failed", 0, job.error);
    job.finishedAt = Date.now();
  });
}

function getPublicJob(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, progress: job.progress, message: job.message,
    originalName: job.originalName, sourceLanguage: job.sourceLanguage, provider: job.provider || null,
    segments: job.segments, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
    downloadUrl: job.status === "completed" ? `/api/video/jobs/${job.id}/download` : null
  };
}
function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function createSrt(segments) {
  return segments.map((seg, i) => `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`).join("\n");
}

const getTtsVoice = v => String(v || "female").trim().toLowerCase() === "male" ? "male" : "female";
function getVideoVoice(v) {
  const s = String(v || "auto").trim().toLowerCase();
  return s === "male" ? "male" : s === "female_only" ? "female_only" : "auto";
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true, service: "Khmer AI Translator Pro", status: "online", autoMultiSpeaker: true,
    geminiConfigured: Boolean(API_KEY), openaiConfigured: Boolean(OPENAI_API_KEY),
    fallbackConfigured: Boolean(ENABLE_OPENAI_FALLBACK && OPENAI_API_KEY),
    openaiFallbackEnabled: ENABLE_OPENAI_FALLBACK, ffmpegAvailable: Boolean(ffmpegPath),
    maxVideoMB: MAX_VIDEO_MB, timestamp: new Date().toISOString()
  });
});

app.post("/api/translate", requireAnyAI, asyncRoute(async (req, res) => {
  const translated = await translateTextToKhmer(req.body?.text || req.body?.content || "");
  res.json({ ok: true, translated, translation: translated, language: "km" });
}));

app.post("/api/tts", asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទជាភាសាខ្មែរ" });
  const id = randomUUID();
  const outputPath = path.join(TMP, `tts-${id}.mp3`);
  try {
    await createKhmerSpeech(text, outputPath, getTtsVoice(req.body?.voice));
    res.download(outputPath, `khmer-voice-${id}.mp3`, err => {
      fs.promises.unlink(outputPath).catch(() => {});
      if (err) console.error("TTS download error:", err.message);
    });
  } catch (err) {
    await fs.promises.unlink(outputPath).catch(() => {});
    throw err;
  }
}));

app.post("/api/video/translate", requireAnyAI, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូជាមុន" });
  try {
    const result = await analyzeVideoWithFallback(req.file.path, req.file.originalname);
    const srt = createSrt(result.segments);
    res.json({ ok: true, sourceLanguage: result.sourceLanguage, provider: result.provider, segments: result.segments, subtitle: srt, srt });
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

app.post("/api/video/translate-and-dub", requireAnyAI, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូជាមុន" });
  const job = createJob(videoJobs, req.file.path, req.file.originalname, getVideoVoice(req.body?.voice));
  startVideoJob(job);
  res.status(202).json({ ok: true, message: "បានទទួលវីដេអូរួចរាល់", job: getPublicJob(job), jobId: job.id });
}));

app.get("/api/video/jobs", (_req, res) => {
  pruneFinishedJobs(videoJobs);
  res.json({ ok: true, jobs: Array.from(videoJobs.values()).sort((a, b) => b.createdAt - a.createdAt).map(getPublicJob) });
});

app.get("/api/video/jobs/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារវីដេអូនេះទេ" });
  res.json({ ok: true, job: getPublicJob(job) });
});

app.get("/api/video/jobs/:id/download", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារនេះទេ" });
  if (job.status !== "completed" || !job.output) {
    return res.status(409).json({ ok: false, error: "វីដេអូមិនទាន់រួចរាល់ទេ", status: job.status, progress: job.progress });
  }
  res.download(job.output, `Khmer-Dubbed-${job.id}.mp4`);
});

app.get("/api/video/jobs/:id/subtitle", (req, res) => {
  const job = videoJobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញការងារនេះទេ" });
  if (!job.segments || !job.segments.length) return res.status(409).json({ ok: false, error: "មិនទាន់មាន Subtitle ទេ" });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="Khmer-Subtitle-${job.id}.srt"`);
  res.send("\uFEFF" + createSrt(job.segments));
});
async function processSeriesJob(series) {
  series.status = "processing";
  series.updatedAt = Date.now();
  try {
    for (let i = 0; i < series.jobs.length; i++) {
      const job = videoJobs.get(series.jobs[i]);
      if (!job) continue;
      series.currentIndex = i + 1;
      series.message = `កំពុងដំណើរការវីដេអូ ${i + 1} ក្នុងចំណោម ${series.jobs.length}`;
      await processVideoJob(job);
      if (job.status === "failed") series.failed++;
      else series.completed++;
      series.progress = Math.round(((series.completed + series.failed) / series.jobs.length) * 100);
      series.updatedAt = Date.now();
    }
    series.status = series.failed > 0 ? "completed_with_errors" : "completed";
    series.message = "ដំណើរការវីដេអូទាំងអស់រួចរាល់";
  } catch (err) {
    series.status = "failed";
    series.error = err.message;
    series.message = err.message;
  } finally {
    series.finishedAt = Date.now();
    series.updatedAt = Date.now();
  }
}

app.post("/api/series/jobs", requireAnyAI, seriesUpload.array("videos", MAX_SERIES_FILES), asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូយ៉ាងហោចណាស់មួយ" });
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_SERIES_TOTAL_MB * 1024 * 1024) {
    await Promise.all(files.map(f => fs.promises.unlink(f.path).catch(() => {})));
    return res.status(413).json({ ok: false, error: "ទំហំវីដេអូសរុបធំពេក" });
  }
  const jobs = files.map(f => createJob(videoJobs, f.path, f.originalname, getVideoVoice(req.body?.voice)).id);
  const seriesId = randomUUID();
  const series = {
    id: seriesId, jobs, status: "queued", progress: 0, completed: 0, failed: 0, currentIndex: 0,
    message: "បានទទួលវីដេអូទាំងអស់", error: null, createdAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
  seriesJobs.set(seriesId, series);
  res.status(202).json({ ok: true, message: "បានបញ្ចូលវីដេអូទៅក្នុងជួររង់ចាំ", seriesId, totalVideos: jobs.length, jobs });
  processSeriesJob(series).catch(err => {
    series.status = "failed";
    series.error = err.message;
    series.finishedAt = Date.now();
  });
}));

app.get("/api/series/jobs/:id", (req, res) => {
  const series = seriesJobs.get(req.params.id);
  if (!series) return res.status(404).json({ ok: false, error: "រកមិនឃើញជួរការងារនេះទេ" });
  res.json({
    ok: true,
    series: {
      id: series.id, status: series.status, progress: series.progress, completed: series.completed,
      failed: series.failed, currentIndex: series.currentIndex, totalVideos: series.jobs.length,
      message: series.message, error: series.error, jobs: series.jobs.map(id => getPublicJob(videoJobs.get(id)))
    }
  });
});

app.get("/api/series/jobs/:id/download", (req, res) => {
  const series = seriesJobs.get(req.params.id);
  if (!series) return res.status(404).json({ ok: false, error: "រកមិនឃើញជួរការងារនេះទេ" });
  const done = series.jobs.map(id => videoJobs.get(id)).filter(j => j && j.status === "completed" && j.output);
  if (!done.length) return res.status(409).json({ ok: false, error: "មិនទាន់មានវីដេអូរួចរាល់សម្រាប់ទាញយកទេ" });
  res.json({
    ok: true,
    videos: done.map(j => ({ id: j.id, name: `Khmer-Dubbed-${j.id}.mp4`, downloadUrl: `/api/video/jobs/${j.id}/download` }))
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Khmer AI Translator Pro", status: "online", version: "1.1.0",
    endpoints: { health: "/api/health", translate: "/api/translate", tts: "/api/tts", video: "/api/video/translate-and-dub", jobs: "/api/video/jobs" }
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "រកមិនឃើញ API នេះទេ", path: req.originalUrl });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error);
  if (res.headersSent) return next(error);
  const status = error instanceof multer.MulterError
    ? (error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT" ? 413 : 400)
    : 500;
  res.status(status).json({ ok: false, error: error.message || "មានបញ្ហានៅលើ Server" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("Khmer AI Translator Pro");
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini configured: ${Boolean(API_KEY)}`);
  console.log("================================");
});

server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
