
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;
const API_URL = "https://api.openai.com/v1";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1
  }
});

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
              "Translate the dialogue into natural, accurate Khmer. Preserve the complete meaning, names, emotions, laughter, and story details. Do not summarize. Return only Khmer translation."
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.3
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Khmer translation failed"
    );
  }

  return data.choices[0].message.content.trim();
}

function extractAudio(input, output) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("FFmpeg is not installed"));
    }

    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i", input,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      output
    ]);

    let errorOutput = "";

    ffmpeg.stderr.on("data", data => {
      errorOutput += data.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error("Cannot extract audio: " + errorOutput.slice(-1000))
        );
      }
    });
  });
}

async function transcribeAudio(audioBuffer, filename) {
  const form = new FormData();

  form.append(
    "file",
    new Blob([audioBuffer], {
      type: "audio/mpeg"
    }),
    filename
  );

  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetch(
    `${API_URL}/audio/transcriptions`,
    {
      method: "POST",
      headers: authHeaders(),
      body: form
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Audio transcription failed"
    );
  }

  return data;
}

// Home
app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Khmer AI Translator",
    status: "Live",
    features: [
      "Video upload",
      "Chinese audio transcription",
      "Khmer translation",
      "SRT subtitles",
      "Khmer text to speech"
    ]
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "Server is running",
    apiConfigured: Boolean(API_KEY)
  });
});

// Translate video or audio into Khmer SRT
app.post(
  "/api/process",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    let folder;

    try {
      if (!API_KEY) {
        throw new Error("OPENAI_API_KEY is missing");
      }

      const video = req.files?.video?.[0];
      const audio = req.files?.audio?.[0];

      if (!video && !audio) {
        return res.status(400).json({
          success: false,
          error: "Please upload video using field video or audio using field audio"
        });
      }

      folder = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "khmer-translator-")
      );

      let audioBuffer;
      let audioName;

      if (video) {
        const input = path.join(folder, "input.mp4");
        const output = path.join(folder, "audio.mp3");

        await fs.promises.writeFile(input, video.buffer);

        await extractAudio(input, output);

        audioBuffer = await fs.promises.readFile(output);
        audioName = "audio.mp3";
      } else {
        audioBuffer = audio.buffer;
        audioName = "audio.mp3";
      }

      // OpenAI transcription upload limit
      if (audioBuffer.length > 25 * 1024 * 1024) {
        throw new Error(
          "Audio is larger than 25MB. Please use a shorter video."
        );
      }

      const transcript = await transcribeAudio(
        audioBuffer,
        audioName
      );

      const segments = transcript.segments || [];

      if (!segments.length) {
        throw new Error(
          "No speech segments found in this video"
        );
      }

      const translatedSegments = [];

      for (const segment of segments) {
        if (!segment.text?.trim()) continue;

        const khmer = await translateText(segment.text);

        translatedSegments.push({
          start: segment.start,
          end: segment.end,
          text: khmer
        });
      }

      const srt = translatedSegments
        .map((item, index) => {
          return [
            index + 1,
            `${toSrtTime(item.start)} --> ${toSrtTime(item.end)}`,
            item.text
          ].join("\n");
        })
        .join("\n\n");

      res.json({
        success: true,
        message: "Video translated successfully",
        originalText: transcript.text,
        khmerText: translatedSegments
          .map(item => item.text)
          .join(" "),
        srt: srt,
        segments: translatedSegments
      });

    } catch (error) {
      console.error("PROCESS ERROR:", error);

      res.status(500).json({
        success: false,
        error: error.message || "Video processing failed"
      });

    } finally {
      if (folder) {
        await fs.promises.rm(folder, {
          recursive: true,
          force: true
        }).catch(console.error);
      }
    }
  }
);

// Generate Khmer voice
app.post("/api/tts", async (req, res) => {
  try {
    if (!API_KEY) {
      throw new Error("OPENAI_API_KEY is missing");
    }

    const { text, voice = "nova" } = req.body;

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        error: "Please provide text"
      });
    }

    if (text.length > 4000) {
      return res.status(400).json({
        success: false,
        error: "Text is too long. Please split it into smaller parts."
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
          voice,
          input: text,
          response_format: "mp3"
        })
      }
    );

    if (!response.ok) {
      const data = await response.json();

      throw new Error(
        data.error?.message || "Voice generation failed"
      );
    }

    const audio = Buffer.from(
      await response.arrayBuffer()
    );

    res.set("Content-Type", "audio/mpeg");
    res.set("Content-Disposition", "attachment; filename=khmer-voice.mp3");
    res.send(audio);

  } catch (error) {
    console.error("TTS ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Khmer AI Translator running on port ${PORT}`
  );
});
