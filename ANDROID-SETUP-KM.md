# របៀបរៀបចំ Android APK

## ស្ថានភាពបច្ចុប្បន្ន
- `index.html` ជា Web UI និងអាចបង្កើត SRT/TXT ពីអត្ថបទដែលអ្នកបញ្ចូលដោយដៃ។
- Capacitor ត្រូវបានកំណត់ជាគម្រោង Android wrapper។
- មិនទាន់មាន backend សម្រាប់ speech-to-text, AI translation, OCR ឬ Khmer MP3 TTS ទេ។
- មិនទាន់មាន Native Overlay service ទេ។ កុំបង្ហាញថាមុខងារទាំងនេះរួចរាល់រហូតដល់បានភ្ជាប់ និងសាកល្បងពិត។

## បង្កើត Android project
ត្រូវការកុំព្យូទ័រ ឬ Cloud build ដែលមាន Node.js និង Android SDK៖

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android
```

បន្ទាប់មក Build APK ក្នុង Android Studio។ ការបង្កើត Android project និងការចុះហត្ថលេខា APK មិនអាចធ្វើដោយការបើក HTML ក្នុង browser តែប៉ុណ្ណោះទេ។

## Overlay permission
Native Android ត្រូវស្នើសុំសិទ្ធិ `Settings.canDrawOverlays()` ហើយបើមិនទាន់អនុញ្ញាត ត្រូវបើក Settings screen ដោយ Intent `ACTION_MANAGE_OVERLAY_PERMISSION`។ ត្រូវពន្យល់អ្នកប្រើថាហេតុអ្វីត្រូវការសិទ្ធិនេះ និងចាប់ផ្តើម overlay service តែបន្ទាប់ពីអ្នកប្រើអនុញ្ញាតដោយច្បាស់លាស់។

## សុវត្ថិភាព API
កុំដាក់ API key នៅក្នុង HTML, JavaScript client ឬ repository សាធារណៈ។ រក្សា key នៅ backend secret/environment variables។ Upload endpoint ត្រូវពិនិត្យ MIME type និងទំហំឯកសារ, ដំណើរការជា chunks, លុប temporary uploads ក្រោយដំណើរការ និងត្រឡប់លទ្ធផលពិតប្រាកដជាមួយ error status។ កុំបង្ហាញ success មុនពេល server ឆ្លើយតបជោគជ័យ។

## តេស្តលើទូរស័ព្ទពិត
1. ជ្រើសរើសវីដេអូ MP4 ដែលគាំទ្រ។
2. សាកល្បង SRT/TXT និងពិនិត្យពេលវេលា។
3. សាកល្បង upload ឯកសារធំ និង network failure។
4. សាកល្បងការសុំសិទ្ធិ Overlay និងបិទ/បើក service។
5. ផ្ទៀងផ្ទាត់ថា temporary files ត្រូវបានលុប។
