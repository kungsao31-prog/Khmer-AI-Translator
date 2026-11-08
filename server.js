
const express = require("express");
const cors = require("cors");
const multer = require("multer");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const upload = multer({
  dest: "/tmp/khmer-uploads/",
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});
