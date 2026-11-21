# CineKhmer AI — ផែនការបន្ថែមមុខងារ Live Dubbing

> គោលការណ៍សុវត្ថិភាព៖ ការងារនេះធ្វើលើ branch `feature/cinekhmer-live-dubbing` ប៉ុណ្ណោះ។ មិនកែ ឬលុប `main` ទេ រហូតដល់បានសាកល្បង និងមានការយល់ព្រម merge។

## មុខងារដែលត្រូវរក្សា
- ការជ្រើសរើស/ផ្ទុកវីដេអូ MP4។
- ការស្គាល់សំឡេង និងបកប្រែទៅខ្មែរ។
- សំឡេងខ្មែរ Piseth (ប្រុស) និង Sreymom (ស្រី)។
- បង្កើត MP4 ដែលមានសំឡេងខ្មែរ និង subtitle ខ្មែរ។
- SRT/MP3/MP4 download, progress និងបណ្ណាល័យឯកសារក្នុងកម្មវិធី។
- Backend URL និង health check ដដែល។

## គោលដៅ Live mode
1. អ្នកប្រើបើក CineKhmer AI ហើយចុច «ចាប់ផ្ដើមបកប្រែផ្ទាល់»។
2. ពន្យល់ និងស្នើសុំសិទ្ធិ Android MediaProjection ដោយច្បាស់ (បើចាប់សំឡេងពីកម្មវិធីផ្សេង)។
3. ចាប់សំឡេងតាម Android AudioPlaybackCapture លើ Android 10+ ប្រសិនបើកម្មវិធីប្រភពអនុញ្ញាត។
4. ប្រើ microphone capture ជាជម្រើសបម្រុង ដោយបង្ហាញស្ថានភាពថាកំពុងប្រើ microphone។
5. ផ្ញើ audio chunks ទៅ backend តាម session ដែលមានកំណត់ទំហំ និងពេលវេលា។
6. Backend បម្លែង speech-to-text, បកប្រែជាខ្មែរ និងបង្កើត TTS ជាបន្តបន្ទាប់។
7. Android overlay បង្ហាញ Khmer captions; audio playback ជាសំឡេងខ្មែរ ដោយមាន controls សម្រាប់ volume/stop។
8. មាន stop, permission-denied, network-lost, quota, retry និង cleanup states។

## ការកំណត់ Android ដែលត្រូវបង្ហាញជាក់លាក់
- AudioPlaybackCapture មិនអាចចាប់សំឡេងពីគ្រប់កម្មវិធីបានទេ។ កម្មវិធីប្រភពអាចបិទការចាប់សំឡេង ហើយ DRM អាចរារាំង។
- Android ត្រូវការការយល់ព្រម MediaProjection ពីអ្នកប្រើ។ ការបង្ហាញ Overlay ត្រូវការសិទ្ធិ «Display over other apps»។
- មិនអាចបង្ខំ YouTube/Facebook/TikTok ឬកម្មវិធីផ្សេងឱ្យ mute original audio បានគ្រប់ករណីទេ។ ត្រូវផ្ដល់ការណែនាំបន្ថយសំឡេងដើមដោយដៃ។
- Live dubbing មាន latency ព្រោះត្រូវស្គាល់សំឡេង បកប្រែ និងបង្កើត TTS។ កុំបង្ហាញថា real-time zero-delay។
- កុំដាក់ Gemini/API keys នៅក្នុង Android APK ឬ HTML។ រក្សាទុកនៅ Render environment variables។

## លំដាប់ការងារ និងលក្ខខណ្ឌទទួលយក
### A. Native Android foundation
- បន្ថែម MediaProjection permission flow, foreground capture service, AudioPlaybackCapture/microphone fallback និង overlay service។
- បន្ថែម controls ក្នុង UI ដោយមិនប៉ះ panel វីដេអូចាស់។
- តេស្ត build APK និង Android permission lifecycle។

### B. Live backend
- បង្កើត session/chunk endpoints, input validation, rate/size limits និង session cleanup។
- បន្ថែម speech recognition/translation/TTS pipeline ដែលគាំទ្រ audio chunks។
- បញ្ជូន status និង captions តាម session ដោយមិនរក្សាទុក audio យូរជាងចាំបាច់។

### C. Integrate and test
- តេស្ត Android 10+ និង Android 13, microphone fallback, permission denial, app switch, screen lock, network interruption និង quota errors។
- វាស់ latency និងសំឡេង/អក្សរខ្មែរ។
- តេស្តមុខងារចាស់ទាំងអស់ឡើងវិញ មុនបង្កើត Pull Request សម្រាប់ពិនិត្យ។
- មិន merge ទៅ main រហូតដល់ build និងការសាកល្បងទាំងអស់ឆ្លងកាត់។

## ស្ថានភាព
- [x] បង្កើត branch ដាច់ដោយឡែកពី main។
- [ ] Native capture និង overlay service។
- [ ] Live audio backend។
- [ ] UI integration និង APK build។
- [ ] Device testing និង regression test។
