  });
  const uploaded = await finish.json().catch(() => ({}));
  if (!finish.ok) {
    throw new Error(uploaded?.error?.message || `Gemini upload failed (${finish.status})`);
  }

  let file = uploaded.file || uploaded;
  for (let attempt = 0; attempt < 45 && file.state === "PROCESSING"; attempt++) {
    await sleep(1500);
    const check = await fetch(`${GEMINI_BASE}/${file.name}`, {
      headers: { "x-goog-api-key": API_KEY }
    });
    const checked = await check.json().catch(() => ({}));
    if (!check.ok) throw new Error(checked?.error?.message || "ពិនិត្យស្ថានភាពឯកសារនៅ Gemini មិនបាន");
    file = checked;
  }

  if (file.state && file.state !== "ACTIVE") {
    throw new Error(`Gemini មិនអាចដំណើរការឯកសារនេះបានទេ (state: ${file.state})`);
  }
  if (!file.uri) throw new Error("Gemini មិនបានផ្ដល់ File URI");
  return file;
}

async function deleteGeminiFile(name) {
  if (!name) return;
  try {
    await fetch(`${GEMINI_BASE}/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": API_KEY }
    });
  } catch (_) {}
}

function validateVoice(gender) {
  const value = String(gender || "").toLowerCase();
  if (["male", "m", "man", "km-kh-pisethneural"].includes(value)) return "km-KH-PisethNeural";
  return "km-KH-SreymomNeural";
}

function cinematicProsody(emotion, gender) {
  const mood = String(emotion || "neutral").toLowerCase();
  const male = validateVoice(gender) === "km-KH-PisethNeural";
  const presets = {
    neutral: { rate: "+6%", pitch: male ? "-3%" : "+0%", volume: "+0%" },
    calm: { rate: "+0%", pitch: male ? "-5%" : "-2%", volume: "+0%" },
    sad: { rate: "-2%", pitch: male ? "-7%" : "-4%", volume: "-4%" },
    angry: { rate: "+6%", pitch: male ? "-2%" : "+3%", volume: "+5%" },
    excited: { rate: "+9%", pitch: male ? "+2%" : "+5%", volume: "+4%" },
    dramatic: { rate: "+0%", pitch: male ? "-6%" : "-2%", volume: "+3%" },
    whisper: { rate: "-5%", pitch: male ? "-4%" : "-2%", volume: "-18%" }
  };
  return presets[mood] || presets.neutral;
}

async function synthesizeKhmer(text, gender, outputPath, emotion = "neutral", style = "cinematic") {
  const voice = validateVoice(gender);
  const prosody = style === "cinematic"
    ? cinematicProsody(emotion, gender)
    : { rate: "+2%", pitch: "default", volume: "default" };

  const attempts = Math.max(1, Math.min(4, Number(process.env.EDGE_TTS_RETRY_ATTEMPTS || 3)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.promises.unlink(outputPath).catch(() => {});
      const tts = new EdgeTTS({
        voice,
        lang: "km-KH",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: prosody.rate,
        pitch: prosody.pitch,
        volume: prosody.volume,
        timeout: 60000
      });
      await tts.ttsPromise(text, outputPath);
      const stat = await fs.promises.stat(outputPath);
      if (!stat.size) throw new Error("សេវាសំឡេងខ្មែរបានបង្កើតឯកសារទទេ");
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable = /429|too many requests|rate.?limit|503|502|temporarily unavailable|timeout|timed out|socket hang up/i.test(message);
      await fs.promises.unlink(outputPath).catch(() => {});
      if (!retryable || attempt === attempts) break;
      await sleep(Math.min(12000, 1800 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400));
    }
  }
  throw lastError || new Error("បង្កើតសំឡេងខ្មែរមិនបាន");
}

async function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error("រកមិនឃើញ FFmpeg binary");
  return execFileAsync(ffmpegPath, args, {
    maxBuffer: 30 * 1024 * 1024,
    timeout: 15 * 60 * 1000
  });
}

async function videoDuration(filePath) {
  let output = "";
  try {
    const result = await runFfmpeg(["-hide_banner", "-i", filePath, "-t", "0", "-f", "null", "-"]);
    output = String(result.stdout || "") + "\n" + String(result.stderr || "");
  } catch (error) {
    output = String(error.stdout || "") + "\n" + String(error.stderr || "");
  }
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 30;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function extractFastAudio(videoPath, outMp3Path) {
  if (!ffmpegPath) return null;
  try {
    await runFfmpeg([
      "-y", "-i", videoPath,
      "-vn", "-acodec", "libmp3lame",
      "-ar", "16000", "-ac", "1", "-b:a", "48k",
      outMp3Path
    ]);
    const stat = await fs.promises.stat(outMp3Path);
    if (stat.size > 0) return outMp3Path;
  } catch (_) {}
  await fs.promises.unlink(outMp3Path).catch(() => {});
  return null;
}

function extractSegmentArray(payload, depth = 0) {
  if (depth > 5 || payload == null) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value) return null;
    try { return extractSegmentArray(JSON.parse(value), depth + 1); } catch (_) { return null; }
  }
  if (typeof payload !== "object") return null;
  for (const key of ["segments", "subtitles", "captions", "items", "data", "result", "transcript"]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const found = extractSegmentArray(payload[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizeSegments(input, duration) {
  const segmentArray = extractSegmentArray(input);
  if (!segmentArray) {
    throw new Error("AI មិនបានផ្ញើបញ្ជី segments ត្រឹមត្រូវទេ។ សូមសាកល្បងម្ដងទៀត។");
  }
  return segmentArray.map(item => ({
    start: Math.max(0, Number(item.start) || 0),
    end: Math.min(duration || 99999, Number(item.end) || 0),
    original: String(item.original || item.text || "").trim(),
    translation: String(item.translation || item.khmer || "").trim(),
    speakerId: String(item.speakerId || item.speaker || "").trim(),
    gender: ["male", "female"].includes(String(item.gender || item.speakerGender || "").toLowerCase())
      ? String(item.gender || item.speakerGender).toLowerCase()
      : "",
    emotion: ["neutral", "calm", "sad", "angry", "excited", "dramatic", "whisper"].includes(String(item.emotion || "").toLowerCase())
      ? String(item.emotion).toLowerCase()
      : "neutral"
  })).filter(item =>
    item.translation &&
    Number.isFinite(item.start) &&
    Number.isFinite(item.end) &&
    item.end > item.start
  ).sort((a, b) => a.start - b.start).slice(0, 600);
}

async function analyzeAndTranslateVideo(filePath, mimeType, originalName) {
  const duration = await videoDuration(filePath);
  const tmpAudio = path.join(TMP, `audio-${randomUUID()}.mp3`);
  const extractedAudio = await extractFastAudio(filePath, tmpAudio);
  const uploadPath = extractedAudio || filePath;
  const uploadMime = extractedAudio ? "audio/mpeg" : mimeType;

  let uploaded = null;
  try {
    uploaded = await uploadGeminiFile(uploadPath, uploadMime, originalName || "media");
    const prompt = `សូមស្តាប់ និងបកប្រែខ្លឹមសារជាភាសាខ្មែរឱ្យរហ័ស ធម្មជាតិ និងច្បាស់លាស់។
ត្រឡប់មកជា JSON object តែមួយគត់ តាមទម្រង់៖
{"segments":[{"start":0.0,"end":3.5,"original":"...","translation":"អត្ថបទខ្មែរ","gender":"female","emotion":"neutral"}]}`;

    const rawText = await geminiGenerate(
      VIDEO_MODEL,
      [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: uploadMime } },
          { text: prompt }
        ]
      }],
      { temperature: 0.2, responseMimeType: "application/json" }
    );

    const parsed = parseJsonObject(rawText);
    const segments = normalizeSegments(parsed, duration);
    return { duration, segments };
  } finally {
    if (extractedAudio) await fs.promises.unlink(extractedAudio).catch(() => {});
    if (uploaded?.name) await deleteGeminiFile(uploaded.name);
  }
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
    }    body: fs.createReadStream(filePath),
    duplex: "half"
  });async function createDubbedVideo(req, res, segments, options = {}) {
  const validSegments = normalizeSegments({ segments }, 99999);
  if (!validSegments.length) throw new Error("មិនមានឃ្លាបកប្រែត្រឹមត្រូវសម្រាប់បង្កើតសំឡេងទេ");

  const inputPath = options.inputPath || req?.file?.path || req?.file?.file?.path;
  if (!inputPath) throw new Error("រកមិនឃើញឯកសារវីដេអូដើមសម្រាប់បញ្ចូលសំឡេងទេ");

  const work = path.join(TMP, "dub-" + randomUUID());
  await fs.promises.mkdir(work, { recursive: true });
  const output = path.join(work, "khmer-video-dub.mp4");
  const fallbackGender = req?.body?.gender || "female";
  const style = req?.body?.style || "cinematic";
  const keepOriginalAudio = String(req?.body?.keepOriginalAudio ?? "false") === "true";
  const voiceVolume = Math.max(0, Math.min(2, Number(req?.body?.voiceVolume ?? 1)));

  try {
    const segFiles = await runWithConcurrency(validSegments, TTS_CONCURRENCY, async (seg, idx) => {
      const segMp3 = path.join(work, `seg-${String(idx).padStart(5, "0")}.mp3`);
      await synthesizeKhmer(seg.translation, seg.gender || fallbackGender, segMp3, seg.emotion, style);
      return { ...seg, mp3: segMp3 };
    });

    const sourceDuration = await videoDuration(inputPath);
    const inputs = ["-y", "-i", inputPath];
    for (const segment of segFiles) inputs.push("-i", segment.mp3);

    const filters = [];
    const voiceLabels = [];
    segFiles.forEach((segment, index) => {
      const delayMs = Math.max(0, Math.round(segment.start * 1000));
      const label = `voice${index}`;
      filters.push(`[${index + 1}:a]volume=${voiceVolume},adelay=${delayMs}|${delayMs}[${label}]`);
      voiceLabels.push(`[${label}]`);
    });

    const mixInputs = [];
    if (keepOriginalAudio) mixInputs.push("[0:a]");
    mixInputs.push(...voiceLabels);
    filters.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${Math.max(1, sourceDuration)}[aout]`);

    await runFfmpeg([
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "0:v:0", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
      "-t", String(Math.max(1, sourceDuration)), "-movflags", "+faststart", output
    ]);

    const stat = await fs.promises.stat(output);
    if (!stat.size) throw new Error("FFmpeg មិនបានបង្កើតវីដេអូ MP4 ទេ");
    if (options.returnFile) return { output, work, size: stat.size };
    if (!res) throw new Error("មិនមាន response សម្រាប់ផ្ញើវីដេអូត្រឡប់ទេ");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", 'attachment; filename="khmer-video-dub.mp4"');
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(output, error => {
      fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      if (error && !res.headersSent) res.status(500).json({ ok: false, error: "ផ្ញើឯកសារ MP4 មិនបានទេ" });
    });
    return { output, work, size: stat.size };
  } catch (error) {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"), error => {
    if (error && !res.headersSent) {
      res.status(200).send("Khmer AI Translator Pro backend is running.");
    }
  });
});

const healthHandler = (req, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy",
    service: "Khmer AI Translator Pro",
    timestamp: new Date().toISOString(),
    geminiConfigured: Boolean(API_KEY),
    ffmpegConfigured: Boolean(ffmpegPath)
  });
};
app.get("/api/health", healthHandler);
app.get("/health", healthHandler);

app.post("/api/translate", requireGeminiKey, asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const sourceLanguage = String(req.body?.sourceLanguage || "auto").trim();
  if (!text) return res.status(400).json({ ok: false, error: "សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ" });
  if (text.length > MAX_TEXT_CHARS) {
    return res.status(413).json({ ok: false, error: `អត្ថបទវែងពេក (អតិបរមា ${MAX_TEXT_CHARS} តួអក្សរ)` });
  }

  const prompt = `បកប្រែអត្ថបទខាងក្រោមទៅជាភាសាខ្មែរធម្មជាតិ ត្រឹមត្រូវ និងងាយយល់។
ភាសាដើម៖ ${sourceLanguage}
ឆ្លើយតែអត្ថបទបកប្រែជាភាសាខ្មែរ៖

${text}`;

  const translation = await geminiGenerate(TEXT_MODEL, [{
    role: "user",
    parts: [{ text: prompt }]
  }], { temperature: 0.2 });

  res.json({ ok: true, sourceLanguage, translation });
}));
app.post("/api/tts", asyncRoute(async (req, res) => {  const text = String(req.body?.text || "").trim();

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "សូមបញ្ចូលអត្ថបទខ្មែរ"
    });
  }

  if (text.length > 5000) {
    return res.status(413).json({
      ok: false,
      error: "អត្ថបទវែងពេក"
    });
  }

  const output = path.join(TMP, `${randomUUID()}.mp3`);

  try {
    await synthesizeKhmer(
      text,
      req.body?.gender,
      output,
      req.body?.emotion || "neutral",
      req.body?.style || "cinematic"
    );

    res.type("audio/mpeg");

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="khmer-voice.mp3"'
    );

    res.sendFile(output, error => {
      fs.promises.unlink(output).catch(() => {});

      if (error && !res.headersSent) {
        res.status(500).end();
      }
    });

  } catch (error) {
    await fs.promises.unlink(output).catch(() => {});
    throw error;
  }
}));app.post("/api/video/translate", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "សូមជ្រើសរើសវីដេអូ"
    });
  }

  try {
    const result = await analyzeAndTranslateVideo(
      req.file.path,
      getMimeType(req.file),
      req.file.originalname
    );

    res.json({
      ok: true,
      ...result
    });

  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

app.post("/api/video/translate-and-dub", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "សូមជ្រើសរើសវីដេអូ"
    });
  }

  try {
    const result = await analyzeAndTranslateVideo(
      req.file.path,
      getMimeType(req.file),
      req.file.originalname
    );

    if (!result.segments.length) {
      throw new Error("រកមិនឃើញសំឡេងនិយាយក្នុងវីដេអូ");
    }

    await createDubbedVideo(req, res, result.segments);

  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
}));app.post("/api/video/jobs", requireGeminiKey, upload.single("video"), asyncRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "សូមជ្រើសរើសវីដេអូ"
    });
  }

  pruneFinishedJobs(videoJobs);

  if (activeMediaJobId) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(409).json({
      ok: false,
      error: "មានការងារវីដេអូកំពុងដំណើរការ សូមរង់ចាំ"
    });
  }

  const id = randomUUID();
  activeMediaJobId = id;

  const job = {
    id,
    status: "processing",
    stage: "queued",
    createdAt: Date.now(),
    output: null,
    work: null,
    input: req.file.path,
    error: null,
    size: 0
  };

  videoJobs.set(id, job);

  res.status(202).json({
    ok: true,
    jobId: id,
    status: job.status
  });

  setImmediate(async () => {
    try {
      job.stage = "analyzing_video";

      const result = await analyzeAndTranslateVideo(
        req.file.path,
        getMimeType(req.file),
        req.file.originalname
      );

      if (!result.segments.length) {
        throw new Error("រកមិនឃើញសំឡេងនិយាយក្នុងវីដេអូ");
      }

      job.stage = "creating_khmer_voice_and_mp4";

      const built = await createDubbedVideo(
        req,
        null,
        result.segments,
        {
          returnFile: true,
          inputPath: req.file.path
        }
      );

      job.output = built.output;
      job.work = built.work;
      job.size = built.size;
      job.duration = result.duration;
      job.segmentCount = result.segments.length;
      job.stage = "completed";
      job.status = "completed";
      job.finishedAt = Date.now();

    } catch (error) {
      job.status = "failed";
      job.stage = "failed";
      job.error = String(error?.message || error);
      job.finishedAt = Date.now();

      await fs.promises.unlink(job.input).catch(() => {});

      if (job.work) {
        await fs.promises.rm(job.work, {
          recursive: true,
          force: true
        }).catch(() => {});
      }

    } finally {
      if (activeMediaJobId === id) {
        activeMediaJobId = null;
      }
    }
  });
}));app.get("/api/video/jobs/:id", (req, res) => {
  const job = videoJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងារវីដេអូនេះ"
    });
  }

  res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    error: job.error,
    size: job.size || 0,
    duration: job.duration || 0,
    segmentCount: job.segmentCount || 0
  });
});

app.get("/api/video/jobs/:id/download", (req, res) => {
  const job = videoJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងារវីដេអូនេះ"
    });
  }

  if (job.status !== "completed" || !job.output) {
    return res.status(409).json({
      ok: false,
      error: "វីដេអូមិនទាន់រួចរាល់ទេ"
    });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="khmer-video-dub.mp4"'
  );
  res.setHeader("Cache-Control", "no-store");

  res.sendFile(job.output, error => {
    if (error) {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: "ទាញយក MP4 មិនបាន"
        });
      }
      return;
    }

    fs.promises.unlink(job.input).catch(() => {});

    if (job.work) {
      fs.promises.rm(job.work, {
        recursive: true,
        force: true
      }).catch(() => {});
    }

    videoJobs.delete(job.id);
  });
});app.post("/api/series/jobs", requireGeminiKey, seriesUpload.array("videos", MAX_SERIES_FILES), asyncRoute(async (req, res) => {
  const files = req.files || [];

  pruneFinishedJobs(seriesJobs);

  if (activeMediaJobId) {
    await Promise.all(
      files.map(file => fs.promises.unlink(file.path).catch(() => {}))
    );

    return res.status(409).json({
      ok: false,
      error: "មានការងារវីដេអូកំពុងដំណើរការ សូមរង់ចាំ"
    });
  }

  if (files.length < 2) {
    await Promise.all(
      files.map(file => fs.promises.unlink(file.path).catch(() => {}))
    );

    return res.status(400).json({
      ok: false,
      error: "សូមជ្រើសរើសយ៉ាងតិច ២ ភាគ"
    });
  }

  if (files.length > MAX_SERIES_FILES) {
    return res.status(400).json({
      ok: false,
      error: "អាចជ្រើសរើសបានអតិបរមា ២០ ភាគ"
    });
  }

  const totalBytes = files.reduce(
    (sum, file) => sum + file.size,
    0
  );

  if (totalBytes > MAX_SERIES_TOTAL_MB * 1024 * 1024) {
    await Promise.all(
      files.map(file => fs.promises.unlink(file.path).catch(() => {}))
    );

    return res.status(413).json({
      ok: false,
      error: "ទំហំវីដេអូសរុបលើសកំណត់"
    });
  }

  const id = randomUUID();
  activeMediaJobId = id;

  const work = path.join(TMP, "series-" + id);

  await fs.promises.mkdir(work, { recursive: true });

  const job = {
    id,
    status: "processing",
    stage: "queued",
    createdAt: Date.now(),
    currentEpisode: 0,
    totalEpisodes: files.length,
    episodes: files.map(file => ({
      name: path.basename(file.originalname || "episode.mp4"),
      status: "queued"
    })),
    inputFiles: files.map(file => file.path),
    output: null,
    work,
    size: 0,
    error: null
  };

  seriesJobs.set(id, job);

  res.status(202).json({
    ok: true,
    jobId: id,
    status: job.status,
    totalEpisodes: files.length
  });

  setImmediate(async () => {
    const normalizedFiles = [];

    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const episode = job.episodes[index];

        job.currentEpisode = index + 1;
        episode.status = "processing";

        job.stage = `episode_${index + 1}_analyzing`;

        const result = await analyzeAndTranslateVideo(
          file.path,
          getMimeType(file),
          file.originalname
        );

        if (!result.segments.length) {
          throw new Error(
            `ភាគ ${index + 1} មិនមានសំឡេងនិយាយ`
          );
        }

        job.stage = `episode_${index + 1}_creating_voice`;

        const built = await createDubbedVideo(
          { file, body: req.body },
          null,
          result.segments,
          {
            returnFile: true,
            inputPath: file.path
          }
        );

        const normalized = path.join(
          work,
          `episode-${String(index + 1).padStart(2, "0")}.mp4`
        );

        await runFfmpeg([
          "-y",
          "-i", built.output,
          "-vf",
          "scale=432:768:force_original_aspect_ratio=decrease,pad=432:768:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
          "-map", "0:v:0",
          "-map", "0:a:0",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "26",
          "-c:a", "aac",
          "-b:a", "128k",
          "-movflags", "+faststart",
          normalized
        ]);

        normalizedFiles.push(normalized);

        episode.status = "completed";

        await fs.promises.unlink(file.path).catch(() => {});

        await fs.promises.rm(
          built.work,
          { recursive: true, force: true }
        ).catch(() => {});
  }      job.stage = "joining_all_episodes";

      const concatList = path.join(work, "episodes.txt");

      const listContent = normalizedFiles
        .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
        .join("\n") + "\n";

      await fs.promises.writeFile(
        concatList,
        listContent,
        "utf8"
      );

      job.output = path.join(
        work,
        "Khmer-Complete-Series.mp4"
      );

      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatList,
        "-c", "copy",
        "-movflags", "+faststart",
        job.output
      ]);

      const stat = await fs.promises.stat(job.output);

      if (!stat.size) {
        throw new Error("មិនអាចបង្កើតវីដេអូរឿងភាគបានទេ");
      }

      job.size = stat.size;
      job.stage = "completed";
      job.status = "completed";
      job.finishedAt = Date.now();

    } catch (error) {

      job.status = "failed";
      job.stage = "failed";

      job.error = String(
        error?.message || "បកប្រែរឿងភាគមិនបាន"
      );

      job.finishedAt = Date.now();

      await Promise.all(
        job.inputFiles.map(file =>
          fs.promises.unlink(file).catch(() => {})
        )
      );

      await fs.promises.rm(
        work,
        { recursive: true, force: true }
      ).catch(() => {});

    } finally {

      if (activeMediaJobId === id) {
        activeMediaJobId = null;
      }

    }
  });
}));app.get("/api/series/jobs/:id", (req, res) => {
  const job = seriesJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងាររឿងភាគនេះ"
    });
  }

  res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    currentEpisode: job.currentEpisode,
    totalEpisodes: job.totalEpisodes,
    episodes: job.episodes,
    size: job.size || 0,
    error: job.error
  });
});app.get("/api/series/jobs/:id/download", (req, res) => {
  const job = seriesJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "រកមិនឃើញការងាររឿងភាគនេះ"
    });
  }

  if (job.status !== "completed" || !job.output) {
    return res.status(409).json({
      ok: false,
      error: "រឿងភាគមិនទាន់រួចរាល់ទេ"
    });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="Khmer-Complete-Series.mp4"'
  );
  res.setHeader("Cache-Control", "no-store");

  res.sendFile(job.output, error => {
    if (error) {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: "ទាញយកវីដេអូរឿងភាគមិនបាន"
        });
      }
      return;
    }

    fs.promises.rm(
      job.work,
      { recursive: true, force: true }
    ).catch(() => {});

    seriesJobs.delete(job.id);
  });
});
