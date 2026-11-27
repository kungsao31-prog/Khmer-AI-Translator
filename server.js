const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_VIDEO_MODEL = (process.env.GEMINI_VIDEO_MODEL || "gemini-2.5-flash").trim();
const GEMINI_TEXT_MODEL = (process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash").trim();

const TMP = path.join(os.tmpdir(), "khmer-ai-translator");
const UPLOAD_DIR = path.join(TMP, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TTS_CONCURRENCY = 2;
const jobs = new Map();
let activeMediaJobId = null;

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(__dirname));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getMimeType(filePath, originalName = "") {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4"
  };
  return map[ext] || "video/mp4";
}

function getUniqueModels(primary) {
  const list = [
    "gemini-2.5-flash",
    primary,
    GEMINI_VIDEO_MODEL,
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash"
  ].filter(Boolean);
  return [...new Set(list)];
}

async function geminiFetchWithRetry(url, options, maxAttempts = 2, timeoutMs = 45000) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (res.ok) return res;
      let errMsg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        errMsg = data?.error?.message || errMsg;
      } catch (_) {}
      lastError = new Error(errMsg);
      if (![429, 500, 502, 503, 504].includes(res.status)) {
        throw lastError;
      }
    } catch (err) {
      lastError = err.name === "AbortError"
        ? new Error("ការតភ្ជាប់ទៅ Gemini AI លើសពេលកំណត់ (Timeout)")
        : err;
      if (attempt === maxAttempts - 1) break;
    } finally {
      clearTimeout(timer);
    }
    await sleep(1500 * (attempt + 1));
  }
  throw lastError || new Error("Gemini API មិនឆ្លើយតប");
}

async function uploadGeminiFile(filePath, mimeType, displayName, onProgress) {
  const stat = await fs.promises.stat(filePath);
  console.log(`[GeminiUpload] Starting upload (${Math.round(stat.size / 1024)} KB)`);
  if (onProgress) onProgress(20, "កំពុងបញ្ជូនវីដេអូទៅកាន់ AI...");

  const start = await geminiFetchWithRetry(
    "https:" + "//generativelanguage.googleapis.com/upload/v1beta/files",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": API_KEY,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(stat.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ file: { display_name: displayName || path.basename(filePath) } })
    },
    2,
    30000
  );

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("មិនអាចទទួលបានតំណផ្ទុកឯកសារទៅ Gemini ទេ");

  const fileBuffer = await fs.promises.readFile(filePath);
  const finish = await geminiFetchWithRetry(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Length": String(stat.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: fileBuffer
    },
    2,
    60000
  );

  const uploaded = await finish.json();
  let fileInfo = uploaded.file || uploaded;
  if (!fileInfo || !fileInfo.name) throw new Error("ការផ្ទុកវីដេអូទៅ Gemini បរាជ័យ");

  if (onProgress) onProgress(26, "AI កំពុងរៀបចំឯកសារវីដេអូ...");
  for (let i = 0; i < 30; i++) {
    if (fileInfo.state === "ACTIVE") {
      console.log(`[GeminiUpload] File ACTIVE: ${fileInfo.name}`);
      return fileInfo;
    }
    if (fileInfo.state === "FAILED") {
      throw new Error("Gemini មិនអាចដំណើរការឯកសារវីដេអូនេះបានទេ");
    }
    await sleep(2000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const check = await fetch("https:" + "//generativelanguage.googleapis.com/v1beta/" + fileInfo.name, {
        headers: { "x-goog-api-key": API_KEY },
        signal: controller.signal
      });
      if (check.ok) {
        const data = await check.json();
        fileInfo = data.file || data;
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("AI រៀបចំឯកសារវីដេអូលើសពេលកំណត់ សូមសាកល្បងម្តងទៀត");
}

async function deleteGeminiFile(fileName) {
  if (!fileName || !API_KEY) return;
  await fetch("https:" + "//generativelanguage.googleapis.com/v1beta/" + fileName, {
    method: "DELETE",
    headers: { "x-goog-api-key": API_KEY }
  }).catch(() => {});
}

function parseJsonResponse(rawText) {
  const cleaned = String(rawText || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

async function analyzeVideoWithFallback(videoPath, originalName, onProgress) {
  if (!API_KEY) {
    throw new Error("មិនទាន់បានកំណត់ GEMINI_API_KEY នៅលើ Server ទេ");
  }

  const mimeType = getMimeType(videoPath, originalName);
  const uploadedFile = await uploadGeminiFile(videoPath, mimeType, originalName, onProgress);

  const prompt = [
    "You are an expert video translator and Khmer dubbing scriptwriter.",
    "Listen carefully to all spoken dialogue and read any on-screen title in this video.",
    "Translate everything into natural, fluent, conversational Khmer.",
    "Rules:",
    "1. Return ONLY valid JSON with this exact schema:",
    '{"sourceLanguage":"string","videoTitle":"short Khmer title for top banner (max 45 chars, empty if none)","segments":[{"start":0.0,"end":2.5,"speaker":"male or female","text":"Khmer translation"}]}',
    "2. Detect speaker gender accurately ('male' or 'female') for every spoken line.",
    "3. Keep 'start' and 'end' timestamps in seconds (numbers) matching the speech timing accurately without overlapping.",
    "4. Keep each Khmer segment concise so the Khmer voiceover fits comfortably within its start-to-end window.",
    "5. Use natural Khmer phrasing, proper Khmer punctuation, and zero English/Chinese words unless unavoidable proper names."
  ].join("\n");

  const models = getUniqueModels(GEMINI_VIDEO_MODEL);
  let lastError = null;

  try {
    for (const model of models) {
      try {
        console.log(`[GeminiAnalyze] Trying model: ${model}`);
        if (onProgress) onProgress(32, `AI (${model}) កំពុងស្តាប់ បកប្រែ និងបែងចែកតួអង្គ...`);

        const analyzeUrl = "https:" + "//[generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/)" + encodeURIComponent(model) + ":generateContent";
        const res = await geminiFetchWithRetry(
          analyzeUrl,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { file_data: { mime_type: uploadedFile.mimeType || mimeType, file_uri: uploadedFile.uri } },
                    { text: prompt }
                  ]
                }
              ],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
              }
            })
          },
          2,
          60000
        );

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        const parsed = parseJsonResponse(text);
        const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];

        const segments = rawSegments
          .map((seg, idx) => {
            const start = Math.max(0, Number(seg.start) || 0);
            const end = Math.max(start + 0.6, Number(seg.end) || start + 2.0);
            const sp = String(seg.speaker || "").toLowerCase();
            const speaker = sp.includes("male") && !sp.includes("female") ? "male" : "female";
            const cleanText = String(seg.text || "").trim();
            return { index: idx, start, end, speaker, text: cleanText };
          })
          .filter((s) => s.text.length > 0);

        if (!segments.length) {
          throw new Error("AI មិនអាចស្គាល់សំឡេងនិយាយនៅក្នុងវីដេអូនេះបានទេ");
        }

        console.log(`[GeminiAnalyze] Success with ${model}: ${segments.length} segments`);
        return {
          provider: model,
          sourceLanguage: parsed.sourceLanguage || "auto",
          videoTitle: String(parsed.videoTitle || "").trim(),
          segments
        };
      } catch (err) {
        console.error(`[GeminiAnalyze] Failed with ${model}: ${err.message}`);
        lastError = err;
      }
    }
    throw lastError || new Error("ការវិភាគវីដេអូជាមួយ Gemini បរាជ័យ");
  } finally {
    await deleteGeminiFile(uploadedFile.name);
  }
}

async function synthesizeWithGoogleFallback(text, outPath) {
  const clean = String(text || "").trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += 180) {
    chunks.push(clean.slice(i, i + 180));
  }
  const buffers = [];
  for (const chunk of chunks) {
    const url = "https:" + "//[translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=km&q=](https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=km&q=)" + encodeURIComponent(chunk);
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    buffers.push(Buffer.from(arr));
  }
  await fs.promises.writeFile(outPath, Buffer.concat(buffers));
}

async function createKhmerSpeech(text, outPath, voiceGender = "female") {
  const voiceName = voiceGender === "male" ? "km-KH-PisethNeural" : "km-KH-SreymomNeural";
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("គ្មានអត្ថបទសម្រាប់បង្កើតសំឡេងទេ");

  try {
    const { EdgeTTS } = require("node-edge-tts");
    const tts = new EdgeTTS({
      voice: voiceName,
      lang: "km-KH",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      rate: "+4%",
      timeout: 20000
    });
    await tts.ttsPromise(cleanText, outPath);
    const st = await fs.promises.stat(outPath);
    if (st.size > 100) return;
  } catch (_) {}

  try {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(cleanText);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      audioStream.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      audioStream.on("error", reject);
    });
    const st = await fs.promises.stat(outPath);
    if (st.size > 100) return;
  } catch (_) {}

  await synthesizeWithGoogleFallback(cleanText, outPath);
}

function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function wrapKhmerText(text, maxChars = 34) {
  const clean = String(text || "").trim();
  if (clean.length <= maxChars) return clean;
  const mid = Math.floor(clean.length / 2);
  let splitIdx = clean.lastIndexOf(" ", mid + 6);
  if (splitIdx < mid - 10) splitIdx = clean.indexOf(" ", mid - 6);
  if (splitIdx > 0 && splitIdx < clean.length - 3) {
    return `${clean.slice(0, splitIdx).trim()}\\N${clean.slice(splitIdx + 1).trim()}`;
  }
  return `${clean.slice(0, mid)}\\N${clean.slice(mid)}`;
}

async function createAssSubtitle(segments, videoTitle, assPath) {
  const maxEnd = segments.reduce((m, s) => Math.max(m, Number(s.end) || 0), 5) + 1.5;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 720",
    "PlayResY: 1280",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Noto Sans Khmer,34,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,36,36,135,1",
    "Style: Subtitle,Noto Sans Khmer,34,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,36,36,135,1",
    "Style: Title,Noto Sans Khmer,38,&H0000E5FF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.5,1,8,36,36,92,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];

  const events = [];
  const cleanTitle = String(videoTitle || "").trim();
  if (cleanTitle) {
    events.push(`Dialogue: 1,0:00:00.00,${formatAssTime(maxEnd)},Title,,0,0,0,,${escapeAssText(wrapKhmerText(cleanTitle, 28))}`);
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextStart = i + 1 < segments.length ? segments[i + 1].start : seg.end + 0.5;
    const start = Math.max(0, Number(seg.start) || 0);
    const end = Math.max(start + 0.5, Math.min(Number(seg.end) || start + 2, Math.max(start + 0.5, nextStart - 0.05)));
    const line = escapeAssText(wrapKhmerText(seg.text, 34));
    events.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Subtitle,,0,0,0,,${line}`);
  }

  const content = "\uFEFF" + [...header, ...events].join("\n") + "\n";
  await fs.promises.writeFile(assPath, content, "utf8");
                             }function runFfmpeg(args, timeoutMs = 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg ដំណើរការលើសពេលកំណត់"));
    }, timeoutMs);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-4000);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`មិនអាចបើក FFmpeg បានទេ៖ ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const tail = stderr.trim().slice(-1200);
      reject(new Error(`FFmpeg បរាជ័យ៖ ${tail}`));
    });
  });
}

async function createDubbedVideo(options) {
  const { inputPath, outputPath, segments, videoTitle = "", voice = "auto", workDir, duration, onProgress } = options;
  if (!Array.isArray(segments) || !segments.length) throw new Error("មិនមានប្រយោគសម្រាប់បង្កើតសំឡេងទេ");
  await fs.promises.mkdir(workDir, { recursive: true });
  const audioFiles = [];
  const assPath = path.join(workDir, "subtitles.ass");

  try {
    if (onProgress) onProgress(50, "កំពុងបង្កើតសំឡេងខ្មែរតួប្រុស និងតួស្រី...");
    await runWithConcurrency(segments, TTS_CONCURRENCY, async (segment, index) => {
      const audioPath = path.join(workDir, `speech-${String(index).padStart(5, "0")}.mp3`);
      const segmentVoice = voice === "male"
        ? "male"
        : voice === "female_only"
          ? "female"
          : (segment.speaker === "male" ? "male" : "female");
      await createKhmerSpeech(segment.text, audioPath, segmentVoice);
      audioFiles[index] = audioPath;
    });

    if (onProgress) onProgress(70, "កំពុងបាំងអក្សរចាស់ ដាក់អក្សរខ្មែរ និងបញ្ចូលសំឡេង...");
    await createAssSubtitle(segments, videoTitle, assPath);
    const escapedAss = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const hasTitle = Boolean(String(videoTitle || "").trim());
    const args = ["-y", "-i", inputPath];
    for (const audioPath of audioFiles) args.push("-i", audioPath);

    const filters = [];
    if (hasTitle) {
      filters.push("[0:v]split=3[base][topraw][botraw]");
      filters.push("[topraw]crop=w=iw:h='trunc(ih*0.13/2)*2':x=0:y='trunc(ih*0.05/2)*2',gblur=sigma=8,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.48:t=fill[topblur]");
      filters.push("[botraw]crop=w=iw:h='trunc(ih*0.14/2)*2':x=0:y='trunc(ih*0.78/2)*2',gblur=sigma=8,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.52:t=fill[botblur]");
      filters.push("[base][topblur]overlay=x=0:y='trunc(H*0.05/2)*2'[v1]");
      filters.push("[v1][botblur]overlay=x=0:y='trunc(H*0.78/2)*2'[vmasked]");
    } else {
      filters.push("[0:v]split=2[base][botraw]");
      filters.push("[botraw]crop=w=iw:h='trunc(ih*0.14/2)*2':x=0:y='trunc(ih*0.78/2)*2',gblur=sigma=8,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.52:t=fill[botblur]");
      filters.push("[base][botblur]overlay=x=0:y='trunc(H*0.78/2)*2'[vmasked]");
    }

    filters.push(`[vmasked]ass='${escapedAss}'[vout]`);

    const mixInputs = [];
    for (let i = 0; i < segments.length; i++) {
      const delay = Math.max(0, Math.round(segments[i].start * 1000));
      filters.push(`[${i + 1}:a]adelay=${delay}:all=1,aresample=44100[voice${i}]`);
      mixInputs.push(`[voice${i}]`);
    }
    filters.push(`${mixInputs.join("")}amix=inputs=${segments.length}:duration=longest:dropout_transition=0:normalize=0,aresample=44100,alimiter=limit=0.95,apad[mixed]`);

    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[vout]",
      "-map", "[mixed]",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "24",
      "-pix_fmt", "yuv420p",
      "-threads", "2",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart"
    );
    if (Number.isFinite(duration) && duration > 0) args.push("-t", String(duration));
    args.push(outputPath);

    await runFfmpeg(args, 60 * 60 * 1000);
    const outStat = await fs.promises.stat(outputPath);
    if (!outStat.size) throw new Error("វីដេអូ MP4 ដែលបានបង្កើតមានទំហំសូន្យ");
    return { outputPath, size: outStat.size, duration: duration || null, segments: segments.length };
  } finally {
    await fs.promises.unlink(assPath).catch(() => {});
    for (const f of audioFiles) if (f) await fs.promises.unlink(f).catch(() => {});
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
    videoTitle: "",
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
  if (activeMediaJobId) throw new Error("មានការងារវីដេអូមួយកំពុងដំណើរការរួចហើយ");
  activeMediaJobId = job.id;
  try {
    console.log(`[VideoJob] Started ${job.id} (${job.originalName})`);
    updateJob(job, "processing", 10, "កំពុងរៀបចំវីដេអូ");
    await fs.promises.mkdir(job.work, { recursive: true });

    const analysis = await analyzeVideoWithFallback(job.input, job.originalName, (pct, msg) => {
      updateJob(job, "processing", pct, msg);
    });

    job.provider = analysis.provider;
    job.segments = analysis.segments;
    job.videoTitle = analysis.videoTitle || "";
    job.sourceLanguage = analysis.sourceLanguage;

    updateJob(job, "processing", 45, "កំពុងបង្កើតសំឡេងខ្មែរ និងដាក់អក្សរខ្មែរលើវីដេអូ");
    const outPath = path.join(job.work, `khmer-${job.id}.mp4`);

    await createDubbedVideo({
      inputPath: job.input,
      outputPath: outPath,
      segments: job.segments,
      videoTitle: job.videoTitle,
      voice: job.voice,
      workDir: job.work,
      onProgress: (pct, msg) => updateJob(job, "processing", pct, msg)
    });

    job.output = outPath;
    job.finishedAt = Date.now();
    updateJob(job, "completed", 100, "បកប្រែវីដេអូរួចរាល់ 100%");
    console.log(`[VideoJob] Completed ${job.id}`);
  } catch (err) {
    console.error(`[VideoJob] Failed ${job.id}: ${err.message}`);
    job.error = err.message || "មានបញ្ហាក្នុងការបកប្រែវីដេអូ";
    job.finishedAt = Date.now();
    updateJob(job, "failed", job.progress, job.error);
  } finally {
    if (activeMediaJobId === job.id) activeMediaJobId = null;
    await fs.promises.unlink(job.input).catch(() => {});
  }
}

async function processSeriesJob(job, files) {
  if (activeMediaJobId) throw new Error("មានការងារវីដេអូមួយកំពុងដំណើរការរួចហើយ");
  activeMediaJobId = job.id;
  const episodeOutputs = [];
  try {
    await fs.promises.mkdir(job.work, { recursive: true });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const basePct = Math.round((i / files.length) * 85);
      updateJob(job, "processing", Math.max(5, basePct), `កំពុងបកប្រែភាគទី ${i + 1}/${files.length}`);
      const analysis = await analyzeVideoWithFallback(f.path, f.originalname);
      const epOut = path.join(job.work, `ep-${String(i).padStart(3, "0")}.mp4`);
      const epWork = path.join(job.work, `w-${i}`);
      await createDubbedVideo({
        inputPath: f.path,
        outputPath: epOut,
        segments: analysis.segments,
        videoTitle: analysis.videoTitle || "",
        voice: job.voice,
        workDir: epWork
      });
      episodeOutputs.push(epOut);
      await fs.promises.unlink(f.path).catch(() => {});
    }

    updateJob(job, "processing", 90, "កំពុងភ្ជាប់គ្រប់ភាគជាវីដេអូ MP4 តែមួយ");
    const listPath = path.join(job.work, "concat.txt");
    const listBody = episodeOutputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await fs.promises.writeFile(listPath, listBody, "utf8");
    const finalOut = path.join(job.work, `khmer-series-${job.id}.mp4`);
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", finalOut]);

    job.output = finalOut;
    job.finishedAt = Date.now();
    updateJob(job, "completed", 100, "ភ្ជាប់រឿងគ្រប់ភាគរួចរាល់ 100%");
  } catch (err) {
    job.error = err.message || "មានបញ្ហាក្នុងការភ្ជាប់រឿង";
    job.finishedAt = Date.now();
    updateJob(job, "failed", job.progress, job.error);
  } finally {
    if (activeMediaJobId === job.id) activeMediaJobId = null;
    for (const f of files) await fs.promises.unlink(f.path).catch(() => {});
    for (const ep of episodeOutputs) await fs.promises.unlink(ep).catch(() => {});
  }
}

app.get(["/api/health", "/health"], (req, res) => {
  res.json({
    ok: true,
    status: "ok",
    provider: "Render Cloud",
    geminiConfigured: Boolean(API_KEY),
    models: { video: GEMINI_VIDEO_MODEL, text: GEMINI_TEXT_MODEL }
  });
});

app.post(["/api/translate-video", "/api/video/translate", "/api/jobs/video", "/api/video/jobs"], upload.any(), (req, res) => {
  try {
    const file = Array.isArray(req.files) && req.files[0];
    if (!file) {
      return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសឯកសារវីដេអូជាមុនសិន" });
    }
    if (activeMediaJobId) {
      fs.promises.unlink(file.path).catch(() => {});
      return res.status(409).json({ ok: false, error: "ប្រព័ន្ធកំពុងបកប្រែវីដេអូមួយផ្សេងទៀត សូមរង់ចាំបន្តិច" });
    }
    const voice = String(req.body?.voice || "auto").trim();
    const job = createJob(jobs, file.path, file.originalname, voice);
    processVideoJob(job).catch(() => {});
    res.json({ ok: true, id: job.id, jobId: job.id, job });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(["/api/translate-series", "/api/batch-video", "/api/merge-episodes", "/api/jobs/series", "/api/video/series", "/api/video/batch"], upload.any(), (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length < 2) {
      for (const f of files) fs.promises.unlink(f.path).catch(() => {});
      return res.status(400).json({ ok: false, error: "សូមជ្រើសរើសវីដេអូចាប់ពី ២ ភាគឡើងទៅ" });
    }
    if (activeMediaJobId) {
      for (const f of files) fs.promises.unlink(f.path).catch(() => {});
      return res.status(409).json({ ok: false, error: "ប្រព័ន្ធកំពុងដំណើរការការងារផ្សេង សូមរង់ចាំបន្តិច" });
    }
    const voice = String(req.body?.voice || "auto").trim();
    const job = createJob(jobs, files[0].path, `${files.length} episodes`, voice);
    processSeriesJob(job, files).catch(() => {});
    res.json({ ok: true, id: job.id, jobId: job.id, job });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get(["/api/jobs/:id", "/api/video/status/:id", "/api/status/:id", "/api/video/jobs/:id"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "រកមិនឃើញទិន្នន័យការងារនេះទេ" });
  const downloadUrl = job.output ? `/api/jobs/${job.id}/download` : null;
  res.json({ ok: true, ...job, downloadUrl, videoUrl: downloadUrl });
});

app.get(["/api/jobs/:id/download", "/api/video/download/:id", "/api/download/:id", "/api/video/jobs/:id/download"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.output || !fs.existsSync(job.output)) {
    return res.status(404).json({ ok: false, error: "ឯកសារវីដេអូមិនទាន់រួចរាល់ ឬត្រូវបានលុបហើយ" });
  }
  const baseName = path.parse(job.originalName || "video").name.replace(/[^\w\u1780-\u17FF-]+/g, "_");
  res.download(job.output, `${baseName}_Khmer.mp4`);
});

app.get(["/api/jobs", "/api/video/jobs"], (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((j) => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      message: j.message,
      originalName: j.originalName,
      videoTitle: j.videoTitle,
      createdAt: j.createdAt,
      downloadUrl: j.output ? `/api/jobs/${j.id}/download` : null
    }));
  res.json({ ok: true, jobs: list });
});

app.post(["/api/translate-text", "/api/translate"], async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទជាមុនសិន" });
    if (!API_KEY) return res.status(500).json({ ok: false, error: "មិនទាន់បានកំណត់ GEMINI_API_KEY ទេ" });
    const textUrl = "https:" + "//[generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/)" + encodeURIComponent(GEMINI_TEXT_MODEL) + ":generateContent";
    const r = await geminiFetchWithRetry(
      textUrl,
      {
        method: "POST",
        headers: { "x-goog-api-key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: `Translate the following text into natural, fluent Khmer. Output ONLY the Khmer translation without notes:\n\n${text}` }] }
          ]
        })
      },
      2,
      30000
    );
    const data = await r.json();
    const translatedText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
    res.json({ ok: true, translatedText, text: translatedText });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(["/api/tts", "/api/speak"], async (req, res) => {
  const tempMp3 = path.join(TMP, `tts-${randomUUID()}.mp3`);
  try {
    const text = String(req.body?.text || "").trim();
    const voice = String(req.body?.voice || "female").trim();
    if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទសម្រាប់អានសំឡេង" });
    await createKhmerSpeech(text, tempMp3, voice);
    res.setHeader("Content-Type", "audio/mpeg");
    const stream = fs.createReadStream(tempMp3);
    stream.pipe(res);
    stream.on("close", () => fs.promises.unlink(tempMp3).catch(() => {}));
  } catch (err) {
    fs.promises.unlink(tempMp3).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(["/api/login", "/api/auth/login", "/login"], (req, res) => {
  const username = String(req.body?.username || req.body?.user || "").trim();
  const password = String(req.body?.password || req.body?.pass || "").trim();
  const expectedUser = (process.env.ADMIN_USERNAME || process.env.APP_USERNAME || "khmeradmin").trim();
  const expectedPass = (process.env.ADMIN_PASSWORD || process.env.APP_PASSWORD || "").trim();
  if (!username || !password) {
    return res.status(400).json({ ok: false, success: false, error: "សូមបញ្ចូលឈ្មោះអ្នកប្រើ និងពាក្យសម្ងាត់" });
  }
  const isValid = expectedPass
    ? (username === expectedUser && password === expectedPass)
    : (username === expectedUser && password.length > 0);
  if (!isValid) {
    return res.status(401).json({ ok: false, success: false, error: "ឈ្មោះអ្នកប្រើ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវទេ" });
  }
  const token = Buffer.from(`${username}:${Date.now()}`).toString("base64");
  res.json({ ok: true, success: true, token, username, user: { username, role: "admin" } });
});

app.get(["/api/me", "/api/auth/me", "/api/session", "/api/check-auth"], (req, res) => {
  const username = (process.env.ADMIN_USERNAME || process.env.APP_USERNAME || "khmeradmin").trim();
  res.json({ ok: true, authenticated: true, username, user: { username, role: "admin" } });
});

app.post(["/api/logout", "/api/auth/logout"], (req, res) => {
  res.json({ ok: true, success: true });
});

app.all("/api/*", (req, res) => {
  res.status(404).json({ ok: false, error: `រកមិនឃើញមុខងារ API នេះទេ (${req.path})` });
});

app.get("*", (req, res) => {
  const indexPublic = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPublic)) return res.sendFile(indexPublic);
  const indexRoot = path.join(__dirname, "index.html");
  if (fs.existsSync(indexRoot)) return res.sendFile(indexRoot);
  res.status(404).send("Khmer AI Translator Pro API is running.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("Khmer AI Translator Pro");
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini configured: ${Boolean(API_KEY)}`);
  console.log("================================");
});
