# Khmer AI Translator Pro 🇰🇭

Mobile-first Khmer video translation project for Chinese, Thai, English, and Vietnamese source media.

## Working in this first frontend version
- Responsive mobile interface.
- Select and preview a local video.
- Choose a source language or Auto Detect (selection UI only).
- Enter source text and Khmer translation manually.
- Preview Khmer subtitle lines over the video with configurable timing.
- Export UTF-8 Khmer SRT and TXT files.
- Test browser/device speech synthesis if a Khmer voice is installed.

## Not connected yet
Automatic speech recognition from uploaded video, automatic AI translation, OCR of on-screen captions, reliable male/female Khmer MP3 generation, precise speech alignment, and floating overlay above other Android apps require backend services and native Android code. The interface reports these limitations instead of pretending they work.

## Run
Open index.html in a modern browser, or enable GitHub Pages. HTTPS is recommended for mobile testing.

## Next stages
1. Secure backend for speech-to-text, translation, OCR, and Khmer TTS.
2. Timestamped segment alignment and downloadable MP3.
3. Capacitor Android wrapper.
4. Native Android overlay permission and floating subtitle service.
5. Build and test APK on a physical Android phone.

Never commit API keys, passwords, or provider credentials to this public repository.
