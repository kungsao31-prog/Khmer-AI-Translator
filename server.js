
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const uploadDir = "/tmp/khmer-uploads";

fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "Khmer AI Translator Pro API is running"
  });
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "សូមបញ្ចូលវីដេអូជាមុន"
    });
  }

  res.json({
    message: "វីដេអូបានបញ្ចូលជោគជ័យ",
    filename: req.file.filename,
    originalName: req.file.originalname
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
  
