const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const RAW_VIDEO_MODEL = (process.env.GEMINI_VIDEO_MODEL || "").trim();
const RAW_TEXT_MODEL = (process.env.GEMINI_TEXT_MODEL || "").trim();
const GEMINI_VIDEO_MODEL = (!RAW_VIDEO_MODEL || RAW_VIDEO_MODEL.includes("2.0") || RAW_VIDEO_MODEL.includes("2.5"))
  ? "gemini-3.8-flash"
  : RAW_VIDEO_MODEL;
const GEMINI_TEXT_MODEL = (!RAW_TEXT_MODEL || RAW_TEXT_MODEL.includes("2.0") || RAW_TEXT_MODEL.includes("2.5"))
  ? "gemini-3.8-flash"
  : RAW_TEXT_MODEL;

const TMP = path.join(os.tmpdir(), "khmer-ai-translator");
const UPLOAD_DIR = path.join(TMP, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TTS_CONCURRENCY = 2;
const jobs = new Map();
let activeMediaJobId = null;
let edgeTtsCooldownUntil = 0;

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || ".mp4") || ".mp4";
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWithTimeout(promise, ms, label = "timeout") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function splitKhmerText(text, maxLen = 170) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function synthesizeWithGoogleFallback(text, outPath) {
  const chunks = splitKhmerText(text, 170);
  if (!chunks.length) throw new Error("គ្មានអត្ថបទសម្រាប់បង្កើតសំឡេងទេ");
  const buffers = [];
  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=km&client=tw-ob`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        "Referer": "https://translate.google.com/"
      }
    });
    if (!res.ok) {
      throw new Error(`Google TTS បរាជ័យ (${res.status})`);
    }
    const arr = await res.arrayBuffer();
    buffers.push(Buffer.from(arr));
  }
  await fs.promises.writeFile(outPath, Buffer.concat(buffers));
}

async function createKhmerSpeech(text, outPath, voiceGender = "female") {
  const voiceName = voiceGender === "male" ? "km-KH-PisethNeural" : "km-KH-SreymomNeural";
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("គ្មានអត្ថបទសម្រាប់បង្កើតសំឡេងទេ");

  if (Date.now() > edgeTtsCooldownUntil) {
    try {
      const { EdgeTTS } = require("node-edge-tts");
      const tts = new EdgeTTS({
        voice: voiceName,
        lang: "km-KH",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+4%",
        timeout: 8000
      });
      await runWithTimeout(tts.ttsPromise(cleanText, outPath), 9000, "EdgeTTS timeout");
      const st = await fs.promises.stat(outPath);
      if (st.size > 100) return;
    } catch (_) {}

    try {
      const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
      const tts = new MsEdgeTTS();
      await runWithTimeout(
        (async () => {
          await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
          const { audioStream } = tts.toStream(cleanText);
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(outPath);
            audioStream.pipe(ws);
            ws.on("finish", resolve);
            ws.on("error", reject);
            audioStream.on("error", reject);
          });
        })(),
        9000,
        "MsEdgeTTS timeout"
      );
      const st = await fs.promises.stat(outPath);
      if (st.size > 100) return;
    } catch (_) {
      edgeTtsCooldownUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  await synthesizeWithGoogleFallback(cleanText, outPath);
    }
        function getUniqueModels(primary) {
  const list = [primary, "gemini-3.8-flash", "gemini-3.5-flash-lite"].filter(Boolean);
  return [...new Set(list.filter((m) => !m.includes("2.0") && !m.includes("2.5")))];
}

function guessVideoMimeType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".avi") return "video/x-msvideo";
  return "video/mp4";
}

async function uploadGeminiFile(filePath, mimeType, displayName) {
  const stat = await fs.promises.stat(filePath);
  const startUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(API_KEY)}`;
  const startRes = await fetch(startUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(stat.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: displayName || "video.mp4" } })
  });
  if (!startRes.ok) {
    const errTxt = await startRes.text();
    throw new Error(`បង្ហោះវីដេអូទៅ Gemini បរាជ័យ (${startRes.status}): ${errTxt.slice(0, 200)}`);
  }
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("មិនទទួលបានតំណបង្ហោះវីដេអូពី Gemini");

  const fileBuffer = await fs.promises.readFile(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(stat.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: fileBuffer
  });
  if (!uploadRes.ok) {
    const errTxt = await uploadRes.text();
    throw new Error(`បញ្ជូនឯកសារវីដេអូបរាជ័យ (${uploadRes.status}): ${errTxt.slice(0, 200)}`);
  }
  const uploadData = await uploadRes.json();
  let fileInfo = uploadData.file || uploadData;

  for (let attempt = 0; attempt < 40; attempt++) {
    if (fileInfo.state === "ACTIVE") return fileInfo;
    if (fileInfo.state === "FAILED") throw new Error("Gemini មិនអាចអានឯកសារវីដេអូនេះបានទេ");
    await sleep(2000);
    const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileInfo.name}?key=${encodeURIComponent(API_KEY)}`);
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      fileInfo = checkData.file || checkData;
    }
  }
  throw new Error("Gemini ចំណាយពេលរៀបចំវីដេអូយូរពេក");
}

async function deleteGeminiFile(fileName) {
  if (!fileName || !API_KEY) return;
  await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(API_KEY)}`, {
    method: "DELETE"
  }).catch(() => {});
}

function parseGeminiJson(rawText) {
  const cleaned = String(rawText || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("AI មិនបានបញ្ជូនទម្រង់ JSON ត្រឹមត្រូវមកវិញទេ");
  }
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

async function analyzeVideoWithFallback(filePath, originalName, onProgress) {
  if (!API_KEY) throw new Error("មិនទាន់បានកំណត់ GEMINI_API_KEY នៅលើ Render ទេ");
  const mimeType = guessVideoMimeType(filePath);
  if (onProgress) onProgress(18, "កំពុងបញ្ជូនវីដេអូទៅឱ្យ AI វិភាគ...");
  const uploaded = await uploadGeminiFile(filePath, mimeType, originalName);

  const prompt = [
    "You are an expert Chinese/English/Vietnamese/Thai-to-Khmer movie and drama translator and voice dubbing director.",
    "Watch and listen to the entire video carefully, including spoken dialogue and on-screen captions.",
    "Transcribe and translate every spoken line into natural, expressive, conversational Khmer suitable for voice-over dubbing.",
    "Identify the speaker gender ('male' or 'female') for each segment based on voice and visual context.",
    "Return ONLY valid JSON with this exact structure (no markdown, no extra commentary):",
    "{",
    '  "videoTitle": "ចំណងជើងរឿងខ្លីជាភាសាខ្មែរ (ឬទុកទទេបើមិនចាំបាច់)",',
    '  "sourceLanguage": "zh",',
    '  "segments": [',
    '    { "start": 0.5, "end": 3.2, "speaker": "male", "text": "ប្រយោគបកប្រែជាភាសាខ្មែរ" }',
    "  ]",
    "}",
    "Rules:",
    "- start and end must be accurate timestamps in seconds (numbers) matching when the character speaks.",
    "- Keep Khmer translations concise enough to be spoken naturally within the segment time window.",
    "- Ensure segments do not overlap and are sorted chronologically."
  ].join("\n");

  const models = getUniqueModels(GEMINI_VIDEO_MODEL);
  let lastError = null;

  try {
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if (onProgress) onProgress(28 + i * 5, `AI (${model}) កំពុងស្កេន និងបកប្រែសាច់រឿង...`);
      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { file_data: { mime_type: mimeType, file_uri: uploaded.uri } },
                  { text: prompt }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.3,
              responseMimeType: "application/json"
            }
          })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }
        const textOut = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        const parsed = parseGeminiJson(textOut);
        const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
        const segments = rawSegments
          .map((s) => ({
            start: Math.max(0, Number(s.start) || 0),
            end: Math.max(0.5, Number(s.end) || (Number(s.start) || 0) + 2),
            speaker: String(s.speaker || "female").toLowerCase().includes("male") && !String(s.speaker || "").toLowerCase().includes("female") ? "male" : "female",
            text: String(s.text || "").trim()
          }))
          .filter((s) => s.text.length > 0)
          .sort((a, b) => a.start - b.start);

        if (!segments.length) {
          throw new Error("AI មិនរកឃើញពាក្យសន្ទនានៅក្នុងវីដេអូនេះទេ");
        }

        return {
          provider: model,
          videoTitle: String(parsed.videoTitle || "").trim(),
          sourceLanguage: String(parsed.sourceLanguage || "auto").trim(),
          segments
        };
      } catch (err) {
        lastError = err;
        console.error(`[GeminiAnalyze] Failed with ${model}: ${err.message}`);
      }
    }
    throw lastError || new Error("ការវិភាគវីដេអូជាមួយ Gemini បរាជ័យ");
  } finally {
    await deleteGeminiFile(uploaded.name);
  }
}

async function translateTextWithFallback(text, style = "natural") {
  if (!API_KEY) throw new Error("មិនទាន់បានកំណត់ GEMINI_API_KEY ទេ");
  const models = getUniqueModels(GEMINI_TEXT_MODEL);
  let lastError = null;
  const prompt = `Translate the following text into fluent, natural Khmer (${style} tone). Return ONLY the Khmer translation without explanations:\n\n${text}`;

  for (const model of models) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const translated = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (translated) return translated;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("បកប្រែអត្ថបទបរាជ័យ");
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

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
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
}

function runFfmpeg(args, timeoutMs = 60 * 60 * 1000) {
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
  const mixedAudioPath = path.join(workDir, "mixed-voice.m4a");

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

    if (onProgress) onProgress(65, "កំពុងរៀបចំបញ្ចូលសំឡេងខ្មែរ...");
    const audioArgs = ["-y"];
    for (const audioPath of audioFiles) audioArgs.push("-i", audioPath);

    const audioFilters = [];
    if (segments.length === 1) {
      const delay = Math.max(0, Math.round(segments[0].start * 1000));
      audioFilters.push(`[0:a]adelay=${delay}:all=1,aresample=44100,alimiter=limit=0.95,apad[mixed]`);
    } else {
      const mixInputs = [];
      for (let i = 0; i < segments.length; i++) {
        const delay = Math.max(0, Math.round(segments[i].start * 1000));
        audioFilters.push(`[${i}:a]adelay=${delay}:all=1,aresample=44100[voice${i}]`);
        mixInputs.push(`[voice${i}]`);
      }
      audioFilters.push(`${mixInputs.join("")}amix=inputs=${segments.length}:duration=longest:dropout_transition=0:normalize=0,aresample=44100,alimiter=limit=0.95,apad[mixed]`);
    }

    audioArgs.push(
      "-filter_complex", audioFilters.join(";"),
      "-map", "[mixed]",
      "-c:a", "aac",
      "-b:a", "128k"
    );
    if (Number.isFinite(duration) && duration > 0) audioArgs.push("-t", String(duration));
    audioArgs.push(mixedAudioPath);

    await runFfmpeg(audioArgs, 15 * 60 * 1000);

    if (onProgress) onProgress(78, "កំពុងបាំងអក្សរចាស់ ដាក់អក្សរខ្មែរ និងផលិតវីដេអូ...");
    await createAssSubtitle(segments, videoTitle, assPath);
    const escapedAss = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const hasTitle = Boolean(String(videoTitle || "").trim());

    const filters = [
      "[0:v]scale=w='if(gt(iw,ih),min(1280,iw),min(720,iw))':h='if(gt(iw,ih),min(720,ih),min(1280,ih))':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[vscaled]"
    ];
    if (hasTitle) {
      filters.push("[vscaled]split=3[base][topraw][botraw]");
      filters.push("[topraw]crop=w=iw:h='trunc(ih*0.13/2)*2':x=0:y='trunc(ih*0.05/2)*2',boxblur=3:1,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.48:t=fill[topblur]");
      filters.push("[botraw]crop=w=iw:h='trunc(ih*0.14/2)*2':x=0:y='trunc(ih*0.78/2)*2',boxblur=3:1,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.52:t=fill[botblur]");
      filters.push("[base][topblur]overlay=x=0:y='trunc(H*0.05/2)*2'[v1]");
      filters.push("[v1][botblur]overlay=x=0:y='trunc(H*0.78/2)*2'[vmasked]");
    } else {
      filters.push("[vscaled]split=2[base][botraw]");
      filters.push("[botraw]crop=w=iw:h='trunc(ih*0.14/2)*2':x=0:y='trunc(ih*0.78/2)*2',boxblur=3:1,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.52:t=fill[botblur]");
      filters.push("[base][botblur]overlay=x=0:y='trunc(H*0.78/2)*2'[vmasked]");
    }

    filters.push(`[vmasked]ass='${escapedAss}'[vout]`);

    const videoArgs = [
      "-y",
      "-i", inputPath,
      "-i", mixedAudioPath,
      "-filter_complex", filters.join(";"),
      "-map", "[vout]",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-crf", "25",
      "-pix_fmt", "yuv420p",
      "-threads", "1",
      "-c:a", "copy",
      "-shortest",
      "-movflags", "+faststart"
    ];
    if (Number.isFinite(duration) && duration > 0) videoArgs.push("-t", String(duration));
    videoArgs.push(outputPath);

    await runFfmpeg(videoArgs, 60 * 60 * 1000);
    const outStat = await fs.promises.stat(outputPath);
    if (!outStat.size) throw new Error("វីដេអូ MP4 ដែលបានបង្កើតមានទំហំសូន្យ");
    return { outputPath, size: outStat.size, duration: duration || null, segments: segments.length };
  } finally {
    await fs.promises.unlink(assPath).catch(() => {});
    await fs.promises.unlink(mixedAudioPath).catch(() => {});
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
      return res.status(400).json({ ok: false, success: false, error: "សូមជ្រើសរើសឯកសារវីដេអូជាមុនសិន" });
    }
    if (activeMediaJobId) {
      fs.promises.unlink(file.path).catch(() => {});
      return res.status(409).json({ ok: false, success: false, error: "ប្រព័ន្ធកំពុងបកប្រែវីដេអូមួយផ្សេងទៀត សូមរង់ចាំបន្តិច" });
    }
    const voice = String(req.body?.voice || req.body?.gender || "auto").trim();
    const job = createJob(jobs, file.path, file.originalname, voice);
    processVideoJob(job).catch(() => {});
    res.status(202).json({
      ok: true,
      success: true,
      status: job.status,
      id: job.id,
      jobId: job.id,
      job_id: job.id,
      taskId: job.id,
      task_id: job.id,
      uuid: job.id,
      data: { id: job.id, jobId: job.id, job_id: job.id, status: job.status },
      job
    });
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

app.post(["/api/translate-series", "/api/batch-video", "/api/merge-episodes", "/api/jobs/series", "/api/video/series", "/api/video/batch"], upload.any(), (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length < 2) {
      for (const f of files) fs.promises.unlink(f.path).catch(() => {});
      return res.status(400).json({ ok: false, success: false, error: "សូមជ្រើសរើសវីដេអូចាប់ពី ២ ភាគឡើងទៅ" });
    }
    if (activeMediaJobId) {
      for (const f of files) fs.promises.unlink(f.path).catch(() => {});
      return res.status(409).json({ ok: false, success: false, error: "ប្រព័ន្ធកំពុងដំណើរការការងារមួយផ្សេងទៀត សូមរង់ចាំបន្តិច" });
    }
    const voice = String(req.body?.voice || req.body?.gender || "auto").trim();
    const job = createJob(jobs, files[0].path, `${files.length} ភាគ`, voice);
    processSeriesJob(job, files).catch(() => {});
    res.status(202).json({
      ok: true,
      success: true,
      status: job.status,
      id: job.id,
      jobId: job.id,
      job_id: job.id,
      taskId: job.id,
      task_id: job.id,
      uuid: job.id,
      data: { id: job.id, jobId: job.id, job_id: job.id, status: job.status },
      job
    });
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

app.get(["/api/jobs/:id", "/api/video/jobs/:id", "/api/status/:id", "/api/video/status/:id", "/api/tasks/:id"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, success: false, error: "រកមិនឃើញលេខកូដការងារនេះទេ (Server អាចទើបតែចាប់ផ្តើមឡើងវិញ)" });
  }
  const videoUrl = job.output ? `/api/jobs/${job.id}/video` : null;
  const srtUrl = job.segments.length ? `/api/jobs/${job.id}/srt` : null;
  res.json({
    ok: true,
    success: true,
    id: job.id,
    jobId: job.id,
    status: job.status,
    done: job.status === "completed",
    progress: job.progress,
    message: job.message,
    videoUrl,
    downloadUrl: videoUrl,
    outputUrl: videoUrl,
    url: videoUrl,
    srtUrl,
    videoTitle: job.videoTitle,
    segments: job.segments,
    subtitles: job.segments,
    error: job.error,
    data: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      videoUrl,
      downloadUrl: videoUrl,
      srtUrl,
      videoTitle: job.videoTitle,
      segments: job.segments,
      error: job.error
    }
  });
});

app.get(["/api/jobs/:id/video", "/api/jobs/:id/download", "/api/video/download/:id", "/api/download/:id"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.output || !fs.existsSync(job.output)) {
    return res.status(404).json({ ok: false, error: "រកមិនឃើញឯកសារវីដេអូ MP4 ទេ" });
  }
  res.sendFile(job.output);
});

app.get(["/api/jobs/:id/srt", "/api/video/srt/:id"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.segments.length) {
    return res.status(404).json({ ok: false, error: "មិនមានអត្ថបទអក្សររត់ SRT ទេ" });
  }
  const srtLines = job.segments.map((seg, i) => {
    return `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`;
  });
  res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="khmer-${job.id}.srt"`);
  res.send("\uFEFF" + srtLines.join("\n"));
});

app.post(["/api/translate-text", "/api/text/translate", "/api/translate"], async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.content || req.body?.prompt || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ" });
    const style = String(req.body?.style || "natural").trim();
    const translation = await translateTextWithFallback(text, style);
    res.json({ ok: true, success: true, translation, translatedText: translatedTextWithFallback ? translation : translation, result: translation });
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

app.post(["/api/tts", "/api/speak"], async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "គ្មានអត្ថបទសម្រាប់អាន" });
    const gender = String(req.body?.voice || req.body?.gender || "female").trim();
    const outMp3 = path.join(TMP, `tts-${randomUUID()}.mp3`);
    await createKhmerSpeech(text, outMp3, gender === "male" ? "male" : "female");
    res.sendFile(outMp3, () => {
      fs.promises.unlink(outMp3).catch(() => {});
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "រកមិនឃើញតំណភ្ជាប់ API នេះទេ" });
  }
  const indexFile = path.join(publicDir, "index.html");
  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }
  res.send("Khmer AI Translator Pro Server is running.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("===============================
