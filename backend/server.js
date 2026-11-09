
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Khmer AI Translator Backend is running!"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    geminiConfigured: Boolean(GEMINI_API_KEY)
  });
});

// AI Translation
app.post("/api/translate", async (req, res) => {
  try {
    const { text, targetLanguage = "Khmer" } = req.body || {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid text"
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Gemini API Key is not configured"
      });
    }

    const prompt = `
You are a professional multilingual translator.

Translate the following text into ${targetLanguage}.

Rules:
- Preserve the original meaning.
- Use natural and accurate language.
- Do not add unnecessary explanations.
- Return only the translated text.

Text:
${text}
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.2
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", response.status);

      return res.status(502).json({
        success: false,
        message: "Gemini AI translation failed",
        error: data.error?.message || "AI service error"
      });
    }

    const translatedText =
      data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!translatedText) {
      return res.status(502).json({
        success: false,
        message: "Gemini returned no translation"
      });
    }

    res.json({
      success: true,
      originalText: text,
      translatedText,
      targetLanguage
    });

  } catch (error) {
    console.error("Translation error:", error.message);

    res.status(500).json({
      success: false,
      message: "Internal translation error"
    });
  }
});

// Video Upload
app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No video uploaded"
    });
  }

  res.json({
    success: true,
    filename: req.file.filename,
    message: "Video uploaded successfully"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Khmer AI Translator running on port ${PORT}`
  );
});
          
