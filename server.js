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
app.use(express.static(path.join(__dirname, "WWW"), { index: "index.html", maxAge: "1h" }));

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
function requireGeminiKey(_req, res, next) {
  if (!API_KEY) return res.status(503).json({ ok: false, error: "មិនទាន់កំណត់ GEMINI_API_KEY នៅលើ Server ទេ" });
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
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({ contents, generationConfig: options })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Gemini API error (${response.status})`);
  const text = (data?.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\n").trim();
  if (!text) throw new Error("Gemini មិនបានផ្ញើអត្ថបទត្រឡប់មកវិញទេ");
  return text;
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
    const check = await fetch(`${GEMINI_BASE}/${file.name}`, { headers: { "x-goog-api-key": API_KEY } });
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
  try { await fetch(`${GEMINI_BASE}/${name}`, { method: "DELETE", headers: { "x-goog-api-key": API_KEY } }); } catch (_) {}
                             }function runWithConcurrency(items, limit, worker) {
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

function normalizeSegments(input) {
  const raw = Array.isArray(input) ? input : input?.segments;

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("មិនមានប្រយោគសម្រាប់បកប្រែទេ");
  }

  return raw.map((item, index) => {
    const start = Number(item.start ?? item.startTime ?? item.start_seconds);
    const end = Number(item.end ?? item.endTime ?? item.end_seconds);
    const text = String(
      item.khmer || item.translation || item.text || ""
    ).trim();

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
អ្នកជាអ្នកបកប្រែវីដេអូពីភាសាបរទេសទៅជាភាសាខ្មែរ។

សូមស្តាប់ និងវិភាគសំឡេងនិយាយក្នុងវីដេអូ។
បកប្រែអត្ថន័យឱ្យបានត្រឹមត្រូវ ជាភាសាខ្មែរធម្មជាតិ។
រក្សាលំដាប់ពេលវេលាដើមរបស់អ្នកនិយាយ។
បំបែកប្រយោគជាផ្នែកៗ ដើម្បីងាយបង្កើតសំឡេងដាក់ជំនួស។

ឆ្លើយតែ JSON តាមទម្រង់នេះ៖
{
  "sourceLanguage": "ភាសាដើម",
  "segments": [
    {
      "start": 0.0,
      "end": 4.5,
      "text": "អត្ថបទបកប្រែជាភាសាខ្មែរ"
    }
  ]
}

ចំណាំ៖
- start និង end គិតជាវិនាទី។
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
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    timeout: 60000
  });

  // node-edge-tts 1.2.x writes audio files with ttsPromise().
  await tts.ttsPromise(cleanText, outputPath);

  const stat = await fs.promises.stat(outputPath);

  if (!stat.size) {
    throw new Error("ការបង្កើតសំឡេងខ្មែរបរាជ័យ");
  }

  return outputPath;
}

async function getMediaDuration(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || ffmpegPath;

  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-i", filePath,
        "-show_entries", "format=duration",
        "-v", "quiet",
        "-of", "csv=p=0"
      ],
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
    );

    const duration = Number(String(stdout).trim());

    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  } catch (_) {}

  return null;
}

async function runFfmpeg(args, timeout = 30 * 60 * 1000) {
  if (!ffmpegPath) {
    throw new Error("មិនអាចរកឃើញ FFmpeg នៅលើ Server");
  }

  try {
    return await execFileAsync(ffmpegPath, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || "");
    throw new Error(`FFmpeg បរាជ័យ៖ ${detail.slice(-1500)}`);
  }
}async function createDubbedVideo(options) {
  const {
    inputPath,
    outputPath,
    segments,
    voice = "female",
    workDir,
    duration
  } = options;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("មិនមានប្រយោគសម្រាប់បង្កើតសំឡេងទេ");
  }

  await fs.promises.mkdir(workDir, { recursive: true });

  const audioFiles = [];

  try {
    await runWithConcurrency(
      segments,
      TTS_CONCURRENCY,
      async (segment, index) => {
        const audioPath = path.join(
          workDir,
          `speech-${String(index).padStart(5, "0")}.mp3`
        );

        await createKhmerSpeech(
          segment.text,
          audioPath,
          voice
        );

        audioFiles[index] = audioPath;
      }
    );

    const args = ["-y", "-i", inputPath];

    for (const audioPath of audioFiles) {
      args.push("-i", audioPath);
    }

    const filters = [];
    const mixInputs = [];

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const delay = Math.max(0, Math.round(segment.start * 1000));
      const label = `voice${index}`;

      filters.push(
        `[${index + 1}:a]adelay=${delay}:all=1,aresample=44100[${label}]`
      );

      mixInputs.push(`[${label}]`);
    }

    filters.push(
      `${mixInputs.join("")}amix=inputs=${segments.length}:duration=longest:dropout_transition=0,aresample=44100,apad[mixed]`
    );

    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map", "0:v:0",
      "-map", "[mixed]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart"
    );

    if (Number.isFinite(duration) && duration > 0) {
      args.push("-t", String(duration));
    }

    args.push(outputPath);

    await runFfmpeg(args, 60 * 60 * 1000);

    const outputStat = await fs.promises.stat(outputPath);

    if (!outputStat.size) {
      throw new Error("វីដេអូ MP4 ដែលបានបង្កើតមានទំហំសូន្យ");
    }

    return {
      outputPath,
      size: outputStat.size,
      duration: duration || null,
      segments: segments.length
    };
  } finally {
    for (const audioPath of audioFiles) {
      if (audioPath) {
        await fs.promises.unlink(audioPath).catch(() => {});
      }
    }
  }
}

function createJob(map, inputPath, originalName, voice) {
  const id = randomUUID();

  const job = {
    id,
    status: "queued",
    progress: 0,
    message: "កំពុងរង់ចាំដំណើរការ",
    originalName,
    voice,
    input: inputPath,
    output: null,
    work: path.join(TMP, id),
    error: null,
    segments: [],
    sourceLanguage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null
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
  if (activeMediaJobId) {
    throw new Error("មានការងារវីដេអូមួយកំពុងដំណើរការរួចហើយ");
  }

  activeMediaJobId = job.id;

  try {
    updateJob(job, "processing", 5, "កំពុងរៀបចំវីដេអូ");

    await fs.promises.mkdir(job.work, { recursive: true });

    updateJob(job, "processing", 15, "កំពុងវិភាគ និងបកប្រែសំឡេង");

    const analysis = await analyzeVideoWithGemini(
      job.input,
      job.originalName
    );

    job.segments = analysis.segments;
    job.sourceLanguage = analysis.sourceLanguage;

    updateJob(job, "processing", 45, "បានបកប្រែរួច កំពុងបង្កើតសំឡេងខ្មែរ");

    const duration = await getMediaDuration(job.input);

    const outputPath = path.join(job.work, "khmer-dubbed.mp4");

    await createDubbedVideo({
      inputPath: job.input,
      outputPath,
      segments: job.segments,
      voice: job.voice,
      workDir: job.work,
      duration
    });

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
  processVideoJob(job).catch(error => {
    job.error = error.message;
    updateJob(job, "failed", 0, job.error);
    job.finishedAt = Date.now();
  });
}

function getPublicJob(job) {
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    originalName: job.originalName,
    sourceLanguage: job.sourceLanguage,
    segments: job.segments,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    downloadUrl: job.status === "completed"
      ? `/api/video/jobs/${job.id}/download`
      : null
  };
  }function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(secs).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

function createSrt(segments) {
  return segments.map((segment, index) => {
    return [
      String(index + 1),
      `${formatSrtTime(segment.start)} --> ${formatSrtTime(segment.end)}`,
      segment.text,
      ""
    ].join("\n");
  }).join("\n");
}

function getVoice(value) {
  return String(value || "female").toLowerCase() === "male"
    ? "male"
    : "female";
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Khmer AI Translator Pro",
    status: "online",
    geminiConfigured: Boolean(API_KEY),
    ffmpegAvailable: Boolean(ffmpegPath),
    maxVideoMB: MAX_VIDEO_MB,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/translate", requireGeminiKey, asyncRoute(async (req, res) => {
  const text = req.body?.text || req.body?.content || "";
  const translated = await translateTextToKhmer(text);

  res.json({
    ok: true,
    translated,
    translation: translated,
    language: "km"
  });
}));

app.post("/api/tts", asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "សូមបញ្ចូលអត្ថបទជាភាសាខ្មែរ"
    });
  }

  const voice = getVoice(req.body?.voice);
  const id = randomUUID();
  const outputPath = path.join(TMP, `tts-${id}.mp3`);

  try {
    await createKhmerSpeech(text, outputPath, voice);

    res.download(outputPath, `khmer-voice-${id}.mp3`, error => {
      fs.promises.unlink(outputPath).catch(() => {});
      if (error) console.error("TTS download error:", error.message);
    });
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    throw error;
  }
}));

app.post(
  "/api/video/translate",
  requireGeminiKey,
  upload.single("video"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "សូមជ្រើសរើសវីដេអូជាមុន"
      });
    }

    try {
      const result = await analyzeVideoWithGemini(
        req.file.path,
        req.file.originalname
      );

      const srt = createSrt(result.segments);

      res.json({
        ok: true,
        sourceLanguage: result.sourceLanguage,
        segments: result.segments,
        subtitle: srt,
        srt
      });
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  })
);

app.post(
  "/api/video/translate-and-dub",
  requireGeminiKey,
  upload.single("video"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "សូមជ្រើសរើសវីដេអូជាមុន"
      });
    }

    const voice = getVoice(req.body?.voice);
    const job = createJob(
      videoJobs,
      req.file.path,
      req.file.originalname,
      voice
    );

    startVideoJob(job);

    res.status(202).json({
      ok: true,
      message: "បានទទួលវីដេអូរួចរាល់",
      job: getPublicJob(job),
      jobId: job.id
    });
  })
);

app.get("/api/video/jobs", (_req, res) => {
  pruneFinishedJobs(videoJobs);

  res.json({
    ok: true,
    jobs: Array.from(videoJobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(getPublicJob)
  });
});

app.get("/api/video/jobs/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងារវីដេអូនេះទេ"
    });
  }

  res.json({
    ok: true,
    job: getPublicJob(job)
  });
});

app.get("/api/video/jobs/:id/download", (req, res) => {
  const job = videoJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងារនេះទេ"
    });
  }

  if (job.status !== "completed" || !job.output) {
    return res.status(409).json({
      ok: false,
      error: "វីដេអូមិនទាន់រួចរាល់ទេ",
      status: job.status,
      progress: job.progress
    });
  }

  res.download(
    job.output,
    `Khmer-Dubbed-${job.id}.mp4`
  );
});

app.get("/api/video/jobs/:id/subtitle", (req, res) => {
  const job = videoJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងារនេះទេ"
    });
  }

  if (!job.segments || job.segments.length === 0) {
    return res.status(409).json({
      ok: false,
      error: "មិនទាន់មាន Subtitle ទេ"
    });
  }

  const srt = createSrt(job.segments);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="Khmer-Subtitle-${job.id}.srt"`
  );

  res.send("\uFEFF" + srt);
});async function processSeriesJob(series) {
  series.status = "processing";
  series.updatedAt = Date.now();

  try {
    for (let index = 0; index < series.jobs.length; index++) {
      const job = videoJobs.get(series.jobs[index]);

      if (!job) continue;

      series.currentIndex = index + 1;
      series.message = `កំពុងដំណើរការវីដេអូ ${index + 1} ក្នុងចំណោម ${series.jobs.length}`;

      await processVideoJob(job);

      if (job.status === "failed") {
        series.failed++;
      } else {
        series.completed++;
      }

      series.progress = Math.round(
        ((series.completed + series.failed) / series.jobs.length) * 100
      );

      series.updatedAt = Date.now();
    }

    series.status = series.failed > 0 ? "completed_with_errors" : "completed";
    series.message = "ដំណើរការវីដេអូទាំងអស់រួចរាល់";
  } catch (error) {
    series.status = "failed";
    series.error = error.message;
    series.message = error.message;
  } finally {
    series.finishedAt = Date.now();
    series.updatedAt = Date.now();
  }
}

app.post(
  "/api/series/jobs",
  requireGeminiKey,
  seriesUpload.array("videos", MAX_SERIES_FILES),
  asyncRoute(async (req, res) => {
    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({
        ok: false,
        error: "សូមជ្រើសរើសវីដេអូយ៉ាងហោចណាស់មួយ"
      });
    }

    const totalSize = files.reduce(
      (total, file) => total + file.size,
      0
    );

    if (totalSize > MAX_SERIES_TOTAL_MB * 1024 * 1024) {
      await Promise.all(
        files.map(file =>
          fs.promises.unlink(file.path).catch(() => {})
        )
      );

      return res.status(413).json({
        ok: false,
        error: "ទំហំវីដេអូសរុបធំពេក"
      });
    }

    const jobs = files.map(file => {
      const job = createJob(
        videoJobs,
        file.path,
        file.originalname,
        getVoice(req.body?.voice)
      );

      return job.id;
    });

    const seriesId = randomUUID();

    const series = {
      id: seriesId,
      jobs,
      status: "queued",
      progress: 0,
      completed: 0,
      failed: 0,
      currentIndex: 0,
      message: "បានទទួលវីដេអូទាំងអស់",
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null
    };

    seriesJobs.set(seriesId, series);

    res.status(202).json({
      ok: true,
      message: "បានបញ្ចូលវីដេអូទៅក្នុងជួររង់ចាំ",
      seriesId,
      totalVideos: jobs.length,
      jobs
    });