# ដំឡើង Local Backend លើ Android តាម Termux

ឯកសារនេះបន្ថែម Server ក្នុងទូរស័ព្ទសម្រាប់កម្មវិធី Khmer AI Translator Pro។ វាដំណើរការជាមួយ Render Cloud ដោយកម្មវិធីពិនិត្យ Render ជាមុន ហើយប្រើ Local Server ប្រសិនបើ Render មិនឆ្លើយតប។

## អ្វីដែលត្រូវដឹងមុន
- Local Server នេះរត់ក្នុង Termux មិនមែនជាសេវាដែលដំណើរការដោយស្វ័យប្រវត្តិខាងក្នុង APK ទេ។
- ត្រូវបើក Termux និងទុក Server ឱ្យដំណើរការ មុនពេលជ្រើស Local Server។
- Local Server នៅតែត្រូវការអ៊ីនធឺណិតដើម្បីហៅ Gemini API។ វាមិនមែនជា AI Offline ទេ។
- កុំដាក់ API Key ក្នុង HTML, APK ឬ GitHub។ ដាក់វាតែក្នុង Environment របស់ Termux និង Render ប៉ុណ្ណោះ។

## 1. ដំឡើងឧបករណ៍ក្នុង Termux
បើក Termux ហើយរត់ពាក្យបញ្ជាទាំងនេះ៖

```bash
pkg update -y && pkg upgrade -y
pkg install nodejs-lts git ffmpeg -y
```

## 2. ទាញយក Backend
```bash
cd ~
git clone https://github.com/kungsao31-prog/Khmer-AI-Translator.git
cd Khmer-AI-Translator/backend
npm install --omit=dev
```

បើថតគម្រោងមានស្រាប់ សូមប្រើ៖
```bash
cd ~/Khmer-AI-Translator
git pull
cd backend
npm install --omit=dev
```

## 3. កំណត់ Local Server
ដាក់ Gemini API Key ផ្ទាល់ខ្លួនរបស់អ្នកជំនួសពាក្យ YOUR_GEMINI_API_KEY៖

```bash
export PORT=3000
export FFMPEG_PATH="$PREFIX/bin/ffmpeg"
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
npm start
```

កុំផ្ញើ API Key មកក្នុង Chat ឬបញ្ចូលក្នុង GitHub។ ទុក Termux បើក និងកុំបិទ session ដែលកំពុងរត់ Server។

## 4. ពិនិត្យ Local Server
បើក browser នៅទូរស័ព្ទ ហើយចូល៖

```text
http://127.0.0.1:3000/api/health
```

គួរតែឃើញ JSON ដែលមាន `"ok": true`, `"geminiConfigured": true` និង `"ffmpegConfigured": true`។

## 5. កំណត់ក្នុង APK
នៅផ្ទាំង «ការភ្ជាប់ Backend»៖
- Render Cloud URL: បញ្ចូល URL ពិតប្រាកដរបស់ Web Service ក្នុង Render (HTTPS)។
- Android Local URL: `http://127.0.0.1:3000`។
- ចុច «រក្សាទុក និងពិនិត្យ Server ទាំងពីរ»។

កម្មវិធីនឹងពិនិត្យ Render ជាមុន បន្ទាប់មក Local។ Server ដែលមានសុខភាពល្អ និងមាន Gemini API Key នឹងត្រូវជ្រើសជាមុន។ បើ Render មិនឆ្លើយតប វានឹងប្រើ Local ប្រសិនបើ Termux Server កំពុងដំណើរការ។

## ដោះស្រាយបញ្ហា
- `Failed to fetch`: ពិនិត្យថា Termux Server កំពុងដំណើរការ និង URL Local ត្រឹមត្រូវ។
- `geminiConfigured: false`: កំណត់ GEMINI_API_KEY ក្នុង Termux ម្តងទៀត ហើយចាប់ផ្ដើម Server ឡើងវិញ។
- `ffmpegConfigured: false`: ដំណើរការ `pkg install ffmpeg -y` ហើយពិនិត្យ `echo $PREFIX/bin/ffmpeg`។
- បើបិទ Termux ឬ Android សម្លាប់ដំណើរការក្រោយខ្នង Local Server នឹងឈប់។ បើក Termux ហើយរត់ `npm start` ម្តងទៀត។
- ការបរាជ័យរបស់ Gemini API, កូតា ឬអ៊ីនធឺណិតនៅតែអាចប៉ះពាល់ដល់ Render និង Local ដូចគ្នា។
