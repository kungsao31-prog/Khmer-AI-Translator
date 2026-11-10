const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
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
function makeWav(pcm, sampleRate=24000, channels=1) {
  const header=Buffer.alloc(44), size=pcm.length;
  header.write("RIFF",0);header.writeUInt32LE(36+size,4);header.write("WAVE",8);header.write("fmt ",12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*channels*2,28);header.writeUInt16LE(channels*2,32);header.writeUInt16LE(16,34);header.write("data",36);header.writeUInt32LE(size,40);
  return Buffer.concat([header,pcm]);
}
app.get("/",(req,res)=>res.json({service:"Khmer AI Translator Pro Backend",status:"online"}));
app.get("/api/health",(req,res)=>res.json({ok:true,service:"Khmer AI Translator Pro",aiConfigured:Boolean(API_KEY)}));

app.post("/api/translate",requireKey,async(req,res)=>{
  try {
    const sourceText=String(req.body.sourceText||req.body.text||"").trim();
    const sourceLang=String(req.body.sourceLang||"auto");
    if(!sourceText)return res.status(400).json({error:"សូមបញ្ចូលអត្ថបទដើម"});
    if(sourceText.length>30000)return res.status(413).json({error:"អត្ថបទវែងពេក សូមបែងចែកជាផ្នែក"});
    const data=await geminiGenerate(TEXT_MODEL,{contents:[{role:"user",parts:[{text:"អ្នកជាអ្នកបកប្រែជំនាញ។ បកប្រែអត្ថបទពី "+sourceLang+" ទៅជាភាសាខ្មែរធម្មជាតិ ត្រឹមត្រូវ និងរក្សាន័យដើម។ រក្សាឈ្មោះ លេខ និងលំដាប់សន្ទនា។ បញ្ចេញតែអត្ថបទខ្មែរ។\n\n"+sourceText}]}],generationConfig:{temperature:0.2}});
    const translatedText=getText(data);
    if(!translatedText)throw new Error("Gemini មិនបានផ្ដល់លទ្ធផលបកប្រែ");
    res.json({ok:true,success:true,originalText:sourceText,translatedText,khmerText:translatedText,targetLanguage:"Khmer"});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.post("/api/process-video",requireKey,upload.single("video"),async(req,res)=>{
  let remoteFile;
  try {
    if(!req.file)return res.status(400).json({error:"សូមជ្រើសរើសវីដេអូជាមុន"});
    const sourceLang=String(req.body.sourceLang||"auto");
    remoteFile=await uploadGeminiFile(req.file.path,req.file.mimetype||"video/mp4",req.file.originalname||"uploaded-video");
    const prompt="Analyze the entire video from beginning to end. Listen to all spoken dialogue. Source language: "+sourceLang+". Translate every spoken segment into natural spoken Khmer. Return ONLY valid JSON: {\"segments\":[{\"start\":0.0,\"end\":2.5,\"source\":\"original words\",\"khmer\":\"Khmer translation\"}]}. Timestamps are seconds from the start. Do not invent dialogue or timestamps. Include all audible speech.";
    const data=await geminiGenerate(TEXT_MODEL,{contents:[{role:"user",parts:[{fileData:{mimeType:remoteFile.mimeType||req.file.mimetype,fileUri:remoteFile.uri}},{text:prompt}]}],generationConfig:{responseMimeType:"application/json",temperature:0.2}});
    const raw=getText(data).replace(/^\s*```(?:json)?/i,"").replace(/```\s*$/i,"").trim();
    const parsed=JSON.parse(raw);
    const segments=Array.isArray(parsed.segments)?parsed.segments.map((s,i)=>({id:i+1,start:Math.max(0,Number(s.start)||0),end:Math.max(Number(s.start)||0,Number(s.end)||((Number(s.start)||0)+2)),source:String(s.source||""),khmer:String(s.khmer||"")})).filter(s=>s.khmer):[];
    if(!segments.length)throw new Error("Gemini មិនបានបង្កើតចំណងជើងរងទេ");
    res.json({ok:true,segments,sourceText:segments.map(s=>s.source).join("\n"),khmerText:segments.map(s=>s.khmer).join("\n")});
  } catch(e) { res.status(502).json({error:e.message}); }
  finally { if(remoteFile?.name)await deleteGeminiFile(remoteFile.name); if(req.file?.path)try{fs.unlinkSync(req.file.path)}catch(_){} }
});

app.post("/api/tts",requireKey,async(req,res)=>{
  try {
    const text=String(req.body.text||"").trim(), gender=req.body.gender==="male"?"male":"female";
    if(!text)return res.status(400).json({error:"សូមបញ្ចូលអត្ថបទខ្មែរ"});
    if(text.length>4000)return res.status(413).json({error:"អត្ថបទវែងពេក សូមបែងចែកជាផ្នែក"});
    const voice=gender==="male"?"Charon":"Kore";
    const data=await geminiGenerate(TTS_MODEL,{contents:[{parts:[{text:"Read the following Khmer text aloud naturally and clearly.\n"+text}]}],generationConfig:{responseModalities:["AUDIO"],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:voice}}}}});
    const part=(data.candidates?.[0]?.content?.parts||[]).find(p=>p.inlineData?.data);
    if(!part)throw new Error("Gemini TTS មិនបានផ្ដល់ទិន្នន័យសំឡេង។ ពិនិត្យថា TTS model អាចប្រើបានសម្រាប់ API Key របស់អ្នកឬអត់។");
    const pcm=Buffer.from(part.inlineData.data,"base64");
    const mime=part.inlineData.mimeType||"audio/L16;rate=24000";
    const rate=Number((mime.match(/rate=(\d+)/)||[])[1]||24000);
    const wav=makeWav(pcm,rate,1);
    res.setHeader("Content-Type","audio/wav");res.setHeader("Content-Disposition",'attachment; filename="khmer-voice.wav"');res.send(wav);
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError)return res.status(413).json({error:"ឯកសារធំពេក ឬមិនអាចទទួលយកបាន។ កម្រិត "+MAX_VIDEO_MB+" MB"});
  res.status(500).json({error:err.message||"Server error"});
});
app.listen(PORT,"0.0.0.0",()=>console.log("Khmer AI Translator Pro running on port "+PORT));
