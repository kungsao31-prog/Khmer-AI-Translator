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
const execFileAsync = promisify(execFile);
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 200);
const TMP = path.join(os.tmpdir(), "khmer-ai-translator");
fs.mkdirSync(TMP, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));
const upload = multer({ dest: TMP, limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 } });

function requireKey(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: "មិនទាន់កំណត់ GEMINI_API_KEY នៅក្នុង Render Environment" });
  next();
}
function getText(data) {
  return (data.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join("\n").trim();
}
async function geminiGenerate(model, body) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Gemini API request failed (" + response.status + ")");
  return data;
}
async function uploadGeminiFile(filePath, mimeType, displayName) {
  const bytes = fs.readFileSync(filePath);
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: { "x-goog-api-key": API_KEY, "Content-Type": "application/json", "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(bytes.length), "X-Goog-Upload-Header-Content-Type": mimeType },
    body: JSON.stringify({ file: { display_name: displayName } })
  });
  if (!start.ok) { const d = await start.json().catch(()=>({})); throw new Error(d.error?.message || "មិនអាចចាប់ផ្ដើមផ្ទុកវីដេអូទៅ Gemini"); }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini មិនបានផ្ដល់ Upload URL");
  const finish = await fetch(uploadUrl, { method: "POST", headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: bytes });
  const uploaded = await finish.json();
  if (!finish.ok) throw new Error(uploaded.error?.message || "ការផ្ទុកវីដេអូបរាជ័យ");
  let file = uploaded.file || uploaded;
  for (let i=0; i<60 && file.state==="PROCESSING"; i++) {
    await new Promise(r=>setTimeout(r,2000));
    const check = await fetch("https://generativelanguage.googleapis.com/v1beta/"+file.name,{headers:{"x-goog-api-key":API_KEY}});
    const d = await check.json();
    if (!check.ok) throw new Error(d.error?.message || "ពិនិត្យវីដេអូមិនបាន");
    file=d;
  }
  if (file.state && file.state!=="ACTIVE") throw new Error("Gemini មិនអាចដំណើរការវីដេអូនេះបានទេ (state: "+file.state+")");
  return file;
}
async function deleteGeminiFile(name) {
  if (!name) return;
  try { await fetch("https://generativelanguage.googleapis.com/v1beta/"+name,{method:"DELETE",headers:{"x-goog-api-key":API_KEY}}); } catch (_) {}
}
function validateVoice(gender) {
  return gender === "male" || gender === "km-KH-PisethNeural"
    ? "km-KH-PisethNeural"
    : "km-KH-SreymomNeural";
}
async function synthesizeKhmer(text, gender, output) {
  const voice = validateVoice(gender);
  const tts = new EdgeTTS({ voice, lang: "km-KH", outputFormat: "audio-24khz-48kbitrate-mono-mp3", timeout: 30000 });
  await tts.ttsPromise(text, output);
  const stat = await fs.promises.stat(output);
  if (!stat.size) throw new Error("សេវាសំឡេងខ្មែរបានបង្កើតឯកសារទទេ");
}
async function runFfmpeg(args) {
  return execFileAsync(ffmpegPath, args, { maxBuffer: 20 * 1024 * 1024, timeout: 30 * 60 * 1000 });
}
async function videoDuration(file) {
  let output = "";
  try {
    const result = await runFfmpeg(["-i", file, "-f", "null", "-"]);
    output = (result.stdout || "") + "\\n" + (result.stderr || "");
  } catch (error) {
    output = (error.stdout || "") + "\\n" + (error.stderr || "");
  }
  const match = output.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error("មិនអាចអានរយៈពេលវីដេអូបាន");
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

app.post("/api/tts", requireKey, async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "សូមបញ្ចូលអត្ថបទខ្មែរ" });
  if (text.length > 5000) return res.status(413).json({ error: "អត្ថបទវែងពេក (អតិបរមា 5000 តួអក្សរ)" });
  const output = path.join(TMP, randomUUID() + ".mp3");
  try {
    await synthesizeKhmer(text, req.body.gender, output);
    res.type("audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="khmer-voice.mp3"');
    res.sendFile(output, error => {
      fs.promises.unlink(output).catch(() => {});
      if (error && !res.headersSent) res.status(500).end();
    });
  } catch (error) {
    await fs.promises.unlink(output).catch(() => {});
    res.status(502).json({ error: "បង្កើតសំឡេងខ្មែរមិនបាន៖ " + error.message });
  }
});

app.post("/api/dub", upload.single("video"), async (req, res) => {
  const work = path.join(TMP, randomUUID());
  await fs.promises.mkdir(work, { recursive: true });
  const output = path.join(work, "khmer-dub.mp4");
  const background = path.join(work, "background.wav");
  try {
    if (!req.file) return res.status(400).json({ error: "សូមជ្រើសរើសវីដេអូ" });
    let segments;
    try { segments = JSON.parse(req.body.segments || "[]"); }
    catch { throw new Error("ទិន្នន័យចំណងជើងរងមិនត្រឹមត្រូវ"); }
    if (!Array.isArray(segments) || !segments.length || segments.length > 150)
      throw new Error("ចំនួនផ្នែកសំឡេងមិនត្រឹមត្រូវ (អតិបរមា 150 ផ្នែក)");
    const duration = await videoDuration(req.file.path);
    const valid = segments.map(item => ({
      start: Math.max(0, Number(item.start) || 0),
      end: Math.min(duration, Number(item.end) || 0),
      translation: String(item.translation || item.khmer || "").trim()
    })).filter(item => item.translation && item.end > item.start && item.start < duration);
    if (!valid.length) throw new Error("គ្មានអត្ថបទខ្មែរសម្រាប់បញ្ចូលសំឡេង");
    const voice = validateVoice(req.body.gender || req.body.voice);
    const audioFiles = [];
    for (let i = 0; i < valid.length; i++) {
      const audioFile = path.join(work, "voice-" + i + ".mp3");
      await synthesizeKhmer(valid[i].translation, voice, audioFile);
      audioFiles.push(audioFile);
    }
    let hasBackground = true;
    try {
      await runFfmpeg(["-y", "-i", req.file.path, "-vn", "-ac", "2", "-ar", "44100", "-t", String(duration), background]);
    } catch (_) { hasBackground = false; }
    const args = ["-y", "-i", req.file.path];
    if (hasBackground) args.push("-i", background);
    else args.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    for (const file of audioFiles) args.push("-i", file);
    const filters = ["[1:a]volume=0.14,apad,atrim=duration=" + duration + "[bg]"];
    const inputs = ["[bg]"];
    valid.forEach((segment, index) => {
      const label = "voice" + index;
      const delay = Math.round(segment.start * 1000);
      filters.push("[" + (index + 2) + ":a]adelay=" + delay + "|" + delay + ",volume=1.0[" + label + "]");
      inputs.push("[" + label + "]");
    });
    filters.push(inputs.join("") + "amix=inputs=" + inputs.length + ":duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]");
    args.push("-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", String(duration), "-shortest", output);
    await runFfmpeg(args);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="khmer-video-dub.mp4"');
    res.sendFile(output, () => {
      fs.promises.unlink(req.file.path).catch(() => {});
      fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    });
  } catch (error) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: "បង្កើតវីដេអូបញ្ចូលសំឡេងខ្មែរមិនបាន៖ " + error.message });
  }
});

app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError)return res.status(413).json({error:"ឯកសារធំពេក ឬមិនអាចទទួលយកបាន។ កម្រិត "+MAX_VIDEO_MB+" MB"});
  res.status(500).json({error:err.message||"Server error"});
});
app.listen(PORT,"0.0.0.0",()=>console.log("Khmer AI Translator Pro running on port "+PORT));
