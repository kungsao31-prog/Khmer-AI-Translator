
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Khmer AI Translator Backend is running!"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online"
  });
});

app.post("/api/translate", (req, res) => {
  const { text, targetLanguage } = req.body;

  if (!text) {
    return res.status(400).json({
      success: false,
      message: "Please provide text"
    });
  }

  res.json({
    success: true,
    originalText: text,
    targetLanguage: targetLanguage || "Khmer",
    message: "Translation API is ready for AI integration"
  });
});

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
  console.log(`Khmer AI Translator running on port ${PORT}`);
});
  
