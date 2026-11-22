"use strict";

/**
 * Optional enhancement routes for Khmer AI Translator Pro.
 * Secrets stay on the server:
 *   GROQ_API_KEY       - Groq Whisper transcription
 *   AI_API_KEY         - external OpenAI-compatible translation provider
 *   AI_BASE_URL        - e.g. https://api.groq.com/openai/v1
 *   AI_MODEL           - e.g. llama-3.3-70b-versatile
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const multer = require("multer");
const run = promisify(execFile);

const TMP = path.join(os.tmpdir(), "khmer-ai-enhancements");
fs.mkdirSync(TMP, { recursive: true });
const MAX_MB = Math.max(10, Math.min(200, Number(process.env.MAX_VIDEO_MB || 200)));
const upload = multer({ dest: TMP, limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 } });
const ffmpeg = process.env.FFMPEG_PATH || require("ffmpeg-static");

function safeName(name) {
  return path.basename(String(name || "video")).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "video";
}
async function ffmpegRun(args) {
  if (!ffmpeg) throw new Error("FFmpeg មិនទាន់បានដំឡើង");
  return run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 2 * 60 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
}
async function removeFiles(files) {
  await Promise.all((files || []).filter(Boolean).map(file => fs.promises.unlink(file).catch(() => {})));
}
function requireGroq(req, res, next) {
  if (!String(process.env.GROQ_API_KEY || "").trim()) {
    return res.status(503).json({ ok: false, error: "សូមកំណត់ GROQ_API_KEY ក្នុង Environment របស់ Server ជាមុន។" });
  }
  next();
}
async function groqTranscribeAudio(audioPath, filename) {
  const bytes = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), filename || "audio.mp3");
  form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.GROQ_API_KEY.trim() },
    body: form,
    signal: AbortSignal.timeout(180000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || ("Groq transcription failed (HTTP " + response.status + ")"));
  return data;
}
async function transcribeVideo(file) {
  const dir = path.join(TMP, "audio-" + randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const pattern = path.join(dir, "part-%03d.mp3");
    await ffmpegRun(["-i", file.path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment", "-segment_time", "600", "-reset_timestamps", "1", pattern]);
    const chunks = (await fs.promises.readdir(dir)).filter(n => n.endsWith(".mp3")).sort();
    if (!chunks.length) throw new Error("មិនអាចទាញយកសំឡេងពីវីដេអូបានទេ");
    const allSegments = [];
    const texts = [];
    for (let i = 0; i < chunks.length; i++) {
      const data = await groqTranscribeAudio(path.join(dir, chunks[i]), chunks[i]);
      const offset = i * 600;
      texts.push(String(data.text || "").trim());
      for (const seg of (data.segments || [])) {
        allSegments.push({
          start: Math.max(0, Number(seg.start || 0) + offset),
          end: Math.max(0, Number(seg.end || 0) + offset),
          text: String(seg.text || "").trim()
        });
      }
    }
    return { text: texts.filter(Boolean).join("\n"), segments: allSegments };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = function registerEnhancementRoutes(app) {
  // Health diagnostics: never expose secret values.
  app.get("/api/health/features", (req, res) => res.json({
    ok: true,
    groqConfigured: Boolean(String(process.env.GROQ_API_KEY || "").trim()),
    externalTranslationConfigured: Boolean(String(process.env.AI_API_KEY || process.env.GROQ_API_KEY || "").trim()),
    thumbnail: Boolean(ffmpeg),
    merge: Boolean(ffmpeg)
  }));

  // Groq audio transcription. Accepts one video and returns source text + timed segments.
  app.post("/api/groq/transcribe", requireGroq, upload.single("video"), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
    try {
      const result = await transcribeVideo(req.file);
      res.json({ ok: true, provider: "groq", model: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo", ...result });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message || "Groq មិនអាចទាញអត្ថបទបានទេ" });
    } finally {
      await removeFiles([req.file.path]);
    }
  });

  // Batch transcription is bounded and sequential per file to protect free-tier instances.
  app.post("/api/groq/batch-transcribe", requireGroq, upload.array("videos", 10), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូយ៉ាងតិច ១" });
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > 500 * 1024 * 1024) {
      await removeFiles(files.map(f => f.path));
      return res.status(413).json({ ok: false, error: "ទំហំសរុប Batch លើស 500 MB" });
    }
    const results = new Array(files.length);
    let nextIndex = 0;
    async function worker() {
      while (true) {
        const index = nextIndex++;
        if (index >= files.length) return;
        const file = files[index];
        try {
          const result = await transcribeVideo(file);
          results[index] = { filename: safeName(file.originalname), ok: true, ...result };
        } catch (error) {
          results[index] = { filename: safeName(file.originalname), ok: false, error: error.message };
        }
      }
    }
    try {
      // Two workers balance throughput against free-tier CPU and provider rate limits.
      await Promise.all(Array.from({ length: Math.min(2, files.length) }, () => worker()));
      res.json({ ok: true, total: files.length, completed: results.filter(x => x && x.ok).length, results });
    } finally {
      await removeFiles(files.map(f => f.path));
    }
  });

  // Configurable OpenAI-compatible AI translation provider (Groq is the default recommendation).
  app.post("/api/ai/translate", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    const sourceLanguage = String(req.body?.sourceLanguage || "auto");
    const provider = String(req.body?.provider || "groq").toLowerCase();
    if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទដើម" });
    if (text.length > 30000) return res.status(413).json({ ok: false, error: "អត្ថបទវែងពេក (អតិបរមា 30,000 តួអក្សរ)" });
    const key = provider === "groq" ? process.env.GROQ_API_KEY : process.env.AI_API_KEY;
    const base = provider === "groq" ? "https://api.groq.com/openai/v1" : String(process.env.AI_BASE_URL || "").replace(/\/+$/, "");
    const model = provider === "groq" ? (process.env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile") : process.env.AI_MODEL;
    if (!key || !base || !model) return res.status(503).json({ ok: false, error: "មិនទាន់កំណត់ API Key, Base URL ឬ Model របស់ AI Provider នេះទេ។" });
    try {
      const response = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + String(key).trim(), "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: "You are an expert translator. Translate the user's text into natural, accurate Khmer. Preserve names, numbers, meaning and dialogue. Return only the Khmer translation." },
            { role: "user", content: "Source language: " + sourceLanguage + "\nTranslate into Khmer:\n" + text }
          ]
        }),
        signal: AbortSignal.timeout(120000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || ("AI provider failed (HTTP " + response.status + ")"));
      const translation = String(data.choices?.[0]?.message?.content || "").trim();
      if (!translation) throw new Error("AI Provider មិនបានផ្ញើលទ្ធផលបកប្រែ");
      res.json({ ok: true, provider, model, translation });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message || "AI បកប្រែមិនបាន" });
    }
  });

  // Merge clips after normalizing video/audio streams to a consistent MP4 format.
  app.post("/api/video/merge", upload.array("videos", 10), async (req, res) => {
    const files = req.files || [];
    if (files.length < 2) {
      await removeFiles(files.map(f => f.path));
      return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូយ៉ាងតិច ២" });
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > 500 * 1024 * 1024) {
      await removeFiles(files.map(f => f.path));
      return res.status(413).json({ ok: false, error: "ទំហំសរុបលើស 500 MB" });
    }
    const work = path.join(TMP, "merge-" + randomUUID());
    await fs.promises.mkdir(work, { recursive: true });
    try {
      const normalized = [];
      for (let i = 0; i < files.length; i++) {
        const out = path.join(work, "clip-" + String(i).padStart(3, "0") + ".mp4");
        await ffmpegRun(["-i", files[i].path, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out]);
        normalized.push(out);
      }
      const list = path.join(work, "concat.txt");
      await fs.promises.writeFile(list, normalized.map(p => "file '" + p.replace(/'/g, "'\\''") + "'").join("\n") + "\n", "utf8");
      const output = path.join(work, "Khmer-Merged-Video.mp4");
      await ffmpegRun(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
      res.download(output, "Khmer-Merged-Video.mp4", async () => {
        await removeFiles(files.map(f => f.path));
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      });
    } catch (error) {
      await removeFiles(files.map(f => f.path));
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      res.status(500).json({ ok: false, error: "Merge វីដេអូមិនបាន៖ " + error.message });
    }
  });

  // Generate a JPEG thumbnail at a chosen timestamp (seconds).
  app.post("/api/video/thumbnail", upload.single("video"), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូ" });
    const work = path.join(TMP, "thumb-" + randomUUID());
    await fs.promises.mkdir(work, { recursive: true });
    const output = path.join(work, "Khmer-Thumbnail.jpg");
    try {
      const seconds = Math.max(0, Math.min(86400, Number(req.body?.timeSeconds) || 1));
      await ffmpegRun(["-ss", String(seconds), "-i", req.file.path, "-frames:v", "1", "-q:v", "2", "-vf", "scale=720:-2", output]);
      const stat = await fs.promises.stat(output);
      if (!stat.size) throw new Error("វីដេអូនេះមិនមាន Frame នៅពេលដែលបានជ្រើស");
      res.download(output, "Khmer-Thumbnail.jpg", async () => {
        await removeFiles([req.file.path]);
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      });
    } catch (error) {
      await removeFiles([req.file.path]);
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      res.status(500).json({ ok: false, error: "បង្កើត Thumbnail មិនបាន៖ " + error.message });
    }
  });
};
