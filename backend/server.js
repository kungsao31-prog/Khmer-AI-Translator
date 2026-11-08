
const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const API_KEY = process.env.OPENAI_API_KEY;
const API_URL = "https://api.openai.com/v1";

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`
  };
}

function toSrtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;

  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0") + "," +
    String(milli).padStart(3, "0")
  );
}

async function translateText(text) {
  const response = await fetch(
    `${API_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Translate the following dialogue into natural Khmer. Preserve the full meaning, names, emotions, laughter and story details. Return only the Khmer translation."
          },
          { role: "user", content: text }
        ],
        temperature: 0.3
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Translation failed");
  }

  return data.choices[0].message.content.trim();
}

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "Khmer AI Translator Backend is running"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true });
});

// Transcribe audio and translate into Khmer SRT
app.post("/api/process", upload.single("audio"), async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please upload an audio file using field name audio"
      });
    }

    const form = new FormData();

    const audioBlob = new Blob(
      [req.file.buffer],
      { type: req.file.mimetype || "audio/mpeg" }
    );

    form.append("file", audioBlob, req.file.originalname);
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");

    const transcription = await fetch(
      `${API_URL}/audio/transcriptions`,
      {
        method: "POST",
        headers: authHeaders(),
        body: form
      }
    );

    const transcript = await transcription.json();

    if (!transcription.ok) {
      throw new Error(
        transcript.error?.message || "Transcription failed"
      );
    }

    const segments = transcript.segments || [];
    const translatedSegments = [];

    for (const segment of segments) {
      const khmer = await translateText(segment.text);

      translatedSegments.push({
        start: segment.start,
        end: segment.end,
        text: khmer
      });
    }

    const srt = translatedSegments.map((item, index) => {
      return [
        index + 1,
        `${toSrtTime(item.start)} --> ${toSrtTime(item.end)}`,
        item.text
      ].join("\n");
    }).join("\n\n");

    res.json({
      success: true,
      originalText: transcript.text,
      khmerText: translatedSegments
        .map(item => item.text).join(" "),
      srt: srt,
      segments: translatedSegments
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Generate Khmer speech
app.post("/api/tts", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing"
      });
    }

    const { text, voice = "nova" } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "Please provide text"
      });
    }

    const response = await fetch(
      `${API_URL}/audio/speech`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: voice,
          input: text,
          response_format: "mp3"
        })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || "Voice generation failed");
    }

    const audio = Buffer.from(await response.arrayBuffer());

    res.set("Content-Type", "audio/mpeg");
    res.send(audio);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Khmer Translator Backend running on port ${PORT}`);
});
    
