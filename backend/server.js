/**
 * Khmer AI Translator Pro - Backend
 * Node.js 20+
 *
 * API:
 *   GET  /api/health
 *   POST /api/translate                 JSON { text, sourceLanguage? }
 *   POST /api/tts                       JSON { text, gender?: "male"|"female", style?: "cinematic" }
 *   POST /api/video/translate            multipart field "video"
 *   POST /api/video/translate-and-dub    multipart field "video"
 *   POST /api/dub                        multipart fields "video", "segments" (JSON), "gender"
 *
 * Notes:
 * - Gemini handles transcription/translation and approximate segment timestamps.
 * - Edge TTS generates synthetic Khmer neural narration; it is not a human recording.
 * - Video analysis estimates speaker gender per segment; uncertain speakers use the selected fallback voice.
 * - Cinematic style applies restrained rate/pitch/volume prosody; it is not studio voice acting.
 * - Video dubbing is speech mixed over the original audio at reduced volume.
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
const ffmpegPath = require("ffmpeg-static");
const { EdgeTTS } = require("node-edge-tts");
require("dotenv").config();

const execFileAsync = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY || "";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || TEXT_MODEL;
const MAX_VIDEO_MB = Math.max(1, Number(process.env.MAX_VIDEO_MB || 100));
const MAX_TEXT_CHARS = Math.max(1000, Number(process.env.MAX_TEXT_CHARS || 12000));
const TMP = path.join(os.tmpdir(), "khmer-ai-translator");
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

fs.mkdirSync(TMP, { recursive: true });

app.disable("x-powered-by");
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  dest: TMP,
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 }
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireGeminiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "មិនទាន់កំណត់ GEMINI_API_KEY នៅក្នុង Render Environment"
    });
  }
  next();
}

function getGeminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => typeof part.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();
}

async function geminiGenerate(model, contents, generationConfig = {}) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
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

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini API request failed (${response.status})`);
  }

  const text = getGeminiText(data);
  if (!text) throw new Error("Gemini មិនបានផ្ញើអត្ថបទត្រឡប់មកវិញ");
  return text;
}

function stripJsonFence(text) {
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function parseJsonObject(text) {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("Gemini បានផ្ញើទិន្នន័យ JSON មិនត្រឹមត្រូវ");
  }
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

  const bytes = await fs.promises.readFile(filePath);
  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: bytes
  });

  const uploaded = await finish.json().catch(() => ({}));
  if (!finish.ok) {
    throw new Error(uploaded?.error?.message || `Gemini upload failed (${finish.status})`);
  }

  let file = uploaded.file || uploaded;
  for (let attempt = 0; attempt < 60 && file.state === "PROCESSING"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
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
    neutral: { rate: "-4%", pitch: male ? "-3%" : "+0%", volume: "+0%" },
    calm: { rate: "-9%", pitch: male ? "-5%" : "-2%", volume: "+0%" },
    sad: { rate: "-12%", pitch: male ? "-7%" : "-4%", volume: "-4%" },
    angry: { rate: "+4%", pitch: male ? "-2%" : "+3%", volume: "+5%" },
    excited: { rate: "+7%", pitch: male ? "+2%" : "+5%", volume: "+4%" },
    dramatic: { rate: "-8%", pitch: male ? "-6%" : "-2%", volume: "+3%" },
    whisper: { rate: "-10%", pitch: male ? "-4%" : "-2%", volume: "-18%" }
  };
  return presets[mood] || presets.neutral;
}

async function synthesizeKhmer(text, gender, outputPath, emotion = "neutral", style = "cinematic") {
  const voice = validateVoice(gender);
  const prosody = style === "cinematic"
    ? cinematicProsody(emotion, gender)
    : { rate: "-2%", pitch: "default", volume: "default" };
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
}

async function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error("រកមិនឃើញ FFmpeg binary");
  return execFileAsync(ffmpegPath, args, {
    maxBuffer: 30 * 1024 * 1024,
    timeout: 30 * 60 * 1000
  });
}

async function videoDuration(filePath) {
  let output = "";
  try {
    const result = await runFfmpeg(["-i", filePath, "-f", "null", "-"]);
    output = `${result.stdout || ""}\n${result.stderr || ""}`;
  } catch (error) {
    output = `${error.stdout || ""}\n${error.stderr || ""}`;
  }
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error("មិនអាចអានរយៈពេលវីដេអូបាន ឬឯកសារមិនមែនជាវីដេអូ");
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function normalizeSegments(input, duration) {
  if (!Array.isArray(input)) throw new Error("ទិន្នន័យ segments ត្រូវតែជា Array");
  return input.map(item => ({
    start: Math.max(0, Number(item.start) || 0),
    end: Math.min(duration, Number(item.end) || 0),
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
    item.end > item.start &&
    item.start < duration
  ).sort((a, b) => a.start - b.start).slice(0, 150);
}

async function analyzeAndTranslateVideo(filePath, mimeType, originalName) {
  const file = await uploadGeminiFile(filePath, mimeType, originalName || "uploaded-video");
  try {
    const prompt = `
អ្នកជាអ្នកបកប្រែ និងរៀបចំសំឡេងវីដេអូពីភាសាបរទេសទៅជាភាសាខ្មែរ។
សូមស្តាប់សំឡេងនិយាយក្នុងវីដេអូនេះ ហើយបង្កើតអត្ថបទជាផ្នែកៗតាមលំដាប់ពេលវេលា។
- ស្គាល់ភាសាដើមដោយស្វ័យប្រវត្តិ។
- ចម្លងអត្ថបទដើមឱ្យបានត្រឹមត្រូវតាមដែលអាចធ្វើបាន។
- បកប្រែឱ្យទៅជាភាសាខ្មែរធម្មជាតិ ងាយស្តាប់។
- start និង end ត្រូវជាពេលវេលាគិតជាវិនាទី (លេខទសភាគ) ហើយត្រូវសមស្របនឹងពេលសំឡេងនិយាយ។
- កុំបង្កើតពាក្យដែលមិនមានក្នុងសំឡេង។
- បែងចែកជាឃ្លាខ្លីៗ មិនឱ្យលើស 150 ផ្នែក។
- កំណត់ speakerId ឱ្យថេរសម្រាប់អ្នកនិយាយដដែល (ឧ. speaker-1, speaker-2)។
- ប៉ាន់ស្មាន gender ជា male ឬ female តែបើសំឡេងអាចសម្គាល់បានច្បាស់; បើមិនច្បាស់ប្រើ unknown។
- កំណត់ emotion តាមការនិយាយជា neutral, calm, sad, angry, excited, dramatic ឬ whisper។ កុំបន្ថែមអារម្មណ៍ដែលមិនឮជាក់ស្តែង។
- បើមិនមានសំឡេងនិយាយ សូមត្រឡប់ segments ជា Array ទទេ។
សូមឆ្លើយតែ JSON តាមទម្រង់នេះ មិនត្រូវដាក់ Markdown ឬ code fence៖
{"sourceLanguage":"English","segments":[{"start":0.0,"end":2.5,"speakerId":"speaker-1","gender":"male","emotion":"dramatic","original":"Hello","translation":"សួស្តី"}]}
`;
    const raw = await geminiGenerate(VIDEO_MODEL, [{
      role: "user",
      parts: [
        { fileData: { mimeType, fileUri: file.uri } },
        { text: prompt }
      ]
    }], { responseMimeType: "application/json", temperature: 0.1 });

    const parsed = parseJsonObject(raw);
    const duration = await videoDuration(filePath);
    const segments = normalizeSegments(parsed.segments, duration);
    return {
      sourceLanguage: String(parsed.sourceLanguage || "unknown"),
      duration,
      segments
    };
  } finally {
    await deleteGeminiFile(file.name);
  }
}

async function createDubbedVideo(req, res, segments) {
  if (!req.file) throw new Error("សូមជ្រើសរើសវីដេអូ");
  const work = path.join(TMP, randomUUID());
  await fs.promises.mkdir(work, { recursive: true });
  const output = path.join(work, "khmer-dub.mp4");
  const background = path.join(work, "background.wav");

  try {
    const duration = await videoDuration(req.file.path);
    const valid = normalizeSegments(segments, duration);
    if (!valid.length) throw new Error("មិនមានអត្ថបទខ្មែរសម្រាប់បញ្ចូលសំឡេង");

    const audioFiles = [];
    for (let index = 0; index < valid.length; index++) {
      const audioFile = path.join(work, `voice-${index}.mp3`);
      const segmentGender = valid[index].gender || req.body.gender || "female";
      await synthesizeKhmer(valid[index].translation, segmentGender, audioFile, valid[index].emotion, "cinematic");
      audioFiles.push(audioFile);
    }

    let hasBackground = true;
    try {
      await runFfmpeg([
        "-y", "-i", req.file.path, "-vn",
        "-ac", "2", "-ar", "44100", "-t", String(duration), background
      ]);
    } catch (_) {
      hasBackground = false;
    }

    const args = ["-y", "-i", req.file.path];
    if (hasBackground) {
      args.push("-i", background);
    } else {
      args.push("-f", "lavfi", "-t", String(duration), "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100");
    }
    for (const audioFile of audioFiles) args.push("-i", audioFile);

    const filters = ["[1:a]volume=0.16,apad,atrim=duration=" + duration + "[bg]"];
    const mixInputs = ["[bg]"];

    valid.forEach((segment, index) => {
      const label = `voice${index}`;
      const delay = Math.max(0, Math.round(segment.start * 1000));
      filters.push(`[${index + 2}:a]adelay=${delay}|${delay},volume=1.0[${label}]`);
      mixInputs.push(`[${label}]`);
    });

    filters.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0,` +
      "loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
    );

    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "0:v:0",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-t", String(duration),
      output
    );

    await runFfmpeg(args);
    const stat = await fs.promises.stat(output);
    if (!stat.size) throw new Error("FFmpeg មិនបានបង្កើតវីដេអូចេញ");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="khmer-video-dub.mp4"');
    res.sendFile(output, error => {
      fs.promises.unlink(req.file.path).catch(() => {});
      fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      if (error && !res.headersSent) res.status(500).end();
    });
  } catch (error) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// Basic routes
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Khmer AI Translator Pro",
    version: "3.0.0",
    health: "/api/health"
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

// Text translation
app.post("/api/translate", requireGeminiKey, asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const sourceLanguage = String(req.body?.sourceLanguage || "auto").trim();
  if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ" });
  if (text.length > MAX_TEXT_CHARS) {
    return res.status(413).json({ ok: false, error: `អត្ថបទវែងពេក (អតិបរមា ${MAX_TEXT_CHARS} តួអក្សរ)` });
  }

  const prompt = `បកប្រែអត្ថបទខាងក្រោមទៅជាភាសាខ្មែរធម្មជាតិ ត្រឹមត្រូវ និងងាយយល់។
ភាសាដើម៖ ${sourceLanguage}
រក្សាឈ្មោះមនុស្ស ឈ្មោះទីកន្លែង លេខ និងអត្ថន័យដើមឱ្យបានត្រឹមត្រូវ។
ឆ្លើយតែអត្ថបទបកប្រែជាភាសាខ្មែរ៖

${text}`;

  const translation = await geminiGenerate(TEXT_MODEL, [{
    role: "user",
    parts: [{ text: prompt }]
  }], { temperature: 0.2 });

  res.json({ ok: true, sourceLanguage, translation });
}));

// Khmer speech generation (does not require Gemini API key)
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

// Analyze video and return translated, timestamped segments
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

// One-step: upload video -> Gemini translate -> Khmer TTS -> dubbed MP4
app.post("/api/video/translate-and-dub", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
  let result;
  try {
    result = await analyzeAndTranslateVideo(
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

// Existing frontend compatibility: client sends video + JSON segments
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

// Multer and general error handler
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
  const message = err?.message || "Server error";
  res.status(500).json({ ok: false, error: message });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Khmer AI Translator Pro backend running on port ${PORT}`);
});
