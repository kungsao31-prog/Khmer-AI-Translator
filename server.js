const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 200);
const TMP = path.join(os.tmpdir(), "khmer-ai-translator");

fs.mkdirSync(TMP, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "www")));

const upload = multer({
  dest: TMP,
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 }
});

function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "មិនទាន់កំណត់ GEMINI_API_KEY នៅក្នុង Server"
    });
  }
  next();
}

function getText(data) {
  return (data.candidates?.[0]?.content?.parts || [])
    .filter(p => p.text)
    .map(p => p.text)
    .join("\n")
    .trim();
}

async function geminiGenerate(model, body) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(API_KEY);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    const message =
      data.error?.message || "Gemini API request failed";
    throw new Error(message);
  }
  return data;
}

async function uploadGeminiFile(filePath, mimeType, displayName) {
  const bytes = fs.readFileSync(filePath);
  const startUrl =
    "https://generativelanguage.googleapis.com/upload/v1beta/files?key=" +
    encodeURIComponent(API_KEY);

  const start = await fetch(startUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType
    },
    body: JSON.stringify({
      file: { display_name: displayName }
    })
  });

  if (!start.ok) {
    throw new Error("មិនអាចចាប់ផ្ដើមផ្ទុកវីដេអូទៅ Gemini បានទេ");
  }

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini មិនបានផ្ដល់ Upload URL");
  }

  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: bytes
  });

  const uploaded = await finish.json();
  if (!finish.ok) {
    throw new Error(
      uploaded.error?.message || "ការផ្ទុកវីដេអូបរាជ័យ"
    );
  }

  let file = uploaded.file || uploaded;
  for (let i = 0; i < 30 && file.state === "PROCESSING"; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const name = file.name;
    const check = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/" +
      name + "?key=" + encodeURIComponent(API_KEY)
    );
    const result = await check.json();
    if (!check.ok) {
      throw new Error(result.error?.message || "ពិនិត្យវីដេអូមិនបាន");
    }
    file = result;
  }

  if (file.state && file.state !== "ACTIVE") {
    throw new Error("Gemini មិនអាចដំណើរការវីដេអូនេះបានទេ");
  }
  return file;
}

async function deleteGeminiFile(name) {
  if (!name) return;
  try {
    await fetch(
      "https://generativelanguage.googleapis.com/v1beta/" +
      name + "?key=" + encodeURIComponent(API_KEY),
      { method: "DELETE" }
    );
  } catch (_) {}
}

function cleanJson(text) {
  return text.replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Khmer AI Translator Pro",
    aiConfigured: Boolean(API_KEY)
  });
});

app.post("/api/translate", requireKey, async (req, res) => {
  try {
    const sourceText = String(req.body.sourceText || "").trim();
    const mode = req.body.mode === "explain" ? "explain" : "normal";
    const sourceLang = String(req.body.sourceLang || "auto");

    if (!sourceText) {
      return res.status(400).json({ error: "សូមបញ្ចូលអត្ថបទដើម" });
    }
    if (sourceText.length > 30000) {
      return res.status(413).json({ error: "អត្ថបទវែងពេក សូមបែងចែកជាផ្នែក" });
    }

    const instruction = mode === "explain"
      ? "បកប្រែជាភាសាខ្មែរបែបពន្យល់ ឱ្យងាយយល់ ប៉ុន្តែកុំបន្ថែមហេតុការណ៍ដែលមិនមានក្នុងអត្ថបទ។"
      : "បកប្រែជាភាសាខ្មែរធម្មជាតិ ត្រឹមត្រូវ និងរក្សាន័យដើម។";

    const data = await geminiGenerate(TEXT_MODEL, {
      contents: [{
        role: "user",
        parts: [{
          text:
            "អ្នកជាអ្នកបកប្រែជំនាញ។ ភាសាដើម: " + sourceLang +
            ". " + instruction +
            " រក្សាឈ្មោះ មនុស្ស លេខ និងលំដាប់សន្ទនា។ " +
            "បញ្ចេញតែអត្ថបទខ្មែរដែលបានបកប្រែ។\n\n" +
            sourceText
        }]
      }]
    });

    res.json({ translatedText: getText(data) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  "/api/process-video",
  requireKey,
  upload.single("video"),
  async (req, res) => {
    let remoteFile;
    try {
      if (!req.file) {
        return res.status(400).json({ error: "សូមជ្រើសរើសវីដេអូជាមុន" });
      }

      const sourceLang = String(req.body.sourceLang || "auto");
      const mode = req.body.mode === "explain" ? "explain" : "normal";
      const instruction = mode === "explain"
        ? "Translate naturally into clear explanatory Khmer without inventing facts."
        : "Translate faithfully into natural spoken Khmer.";

      remoteFile = await uploadGeminiFile(
        req.file.path,
        req.file.mimetype || "video/mp4",
        req.file.originalname || "uploaded-video"
      );

      const prompt =
        "Analyze the entire video from beginning to end. Listen carefully to all spoken dialogue. " +
        "The source language is " + sourceLang + ". " +
        "Create subtitle segments in chronological order. " +
        "Do not skip dialogue, laughter, cries, or meaningful vocal reactions. " +
        "For laughter use a short Khmer label such as (សើច) when appropriate. " +
        instruction + " " +
        "Return ONLY valid JSON with this exact shape: " +
        '{"segments":[{"start":0.0,"end":2.5,"source":"original words","khmer":"Khmer translation"}]}. ' +
        "Timestamps must be seconds from the video start and must match the actual speech as closely as possible. " +
        "Do not invent timestamps or dialogue. Include every audible spoken segment until the video ends.";

      const data = await geminiGenerate(TEXT_MODEL, {
        contents: [{
          role: "user",
          parts: [
            {
              fileData: {
                mimeType: remoteFile.mimeType || req.file.mimetype,
                fileUri: remoteFile.uri
              }
            },
            { text: prompt }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      });

      const raw = getText(data);
      const parsed = JSON.parse(cleanJson(raw));
      const segments = Array.isArray(parsed.segments)
        ? parsed.segments.map((s, i) => ({
            id: i + 1,
            start: Math.max(0, Number(s.start) || 0),
            end: Math.max(
              Number(s.start) || 0,
              Number(s.end) || (Number(s.start) || 0) + 2
            ),
            source: String(s.source || ""),
            khmer: String(s.khmer || "")
          })).filter(s => s.khmer)
        : [];

      if (!segments.length) {
        throw new Error("AI មិនបានបង្កើតចំណងជើងរងទេ។ សូមសាកល្បងម្ដងទៀត");
      }

      res.json({
        ok: true,
        segments,
        sourceText: segments.map(s => s.source).join("\n"),
        khmerText: segments.map(s => s.khmer).join("\n")
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    } finally {
      if (remoteFile?.name) await deleteGeminiFile(remoteFile.name);
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
    }
  }
);

function makeWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

app.post("/api/tts", requireKey, async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const gender = req.body.gender === "male" ? "male" : "female";
    if (!text) {
      return res.status(400).json({ error: "សូមបញ្ចូលអត្ថបទខ្មែរ" });
    }
    if (text.length > 4000) {
      return res.status(413).json({
        error: "អត្ថបទវែងពេកសម្រាប់បង្កើតសំឡេងម្ដង។ សូមបែងចែកជាផ្នែក"
      });
    }

    const voice = gender === "male" ? "Charon" : "Kore";
    const data = await geminiGenerate(TTS_MODEL, {
      contents: [{
        parts: [{
          text:
            "Read the following Khmer text aloud in natural Cambodian Khmer. " +
            "Use a " + gender + " speaking style, clear pronunciation, " +
            "steady pace, and natural emotion. Do not translate or add words.\n\n" +
            text
        }]
      }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice }
          }
        }
      }
    });

    const audioPart = (
      data.candidates?.[0]?.content?.parts || []
    ).find(p => p.inlineData?.data);

    if (!audioPart) {
      throw new Error("AI មិនបានបង្កើតទិន្នន័យសំឡេងទេ");
    }

    const audio = Buffer.from(audioPart.inlineData.data, "base64");
    const mime = audioPart.inlineData.mimeType || "";
    const wav = mime.includes("wav") ? audio : makeWav(audio);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="khmer-voice.wav"'
    );
    res.send(wav);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(413).json({
      error: "ឯកសារធំពេក ឬមិនអាចទទួលយកបាន។ កម្រិតបច្ចុប្បន្ន " +
        MAX_VIDEO_MB + " MB"
    });
  }
  res.status(500).json({ error: error.message || "Server error" });
});

app.listen(PORT, () => {
  console.log("Khmer AI Translator Pro running on port " + PORT);
});
