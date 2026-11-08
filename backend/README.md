# Backend integration plan

The current frontend supports local video preview, manual Khmer text entry, timed subtitle preview, and SRT/TXT export.

## Planned server endpoints
- POST /api/transcribe — accept video/audio and source language (auto, zh, th, en, vi); return transcript segments with start/end times.
- POST /api/translate — accept source text and language pair; return Khmer translation while preserving segment order.
- POST /api/tts — accept Khmer text/segments and voice (male/female); return generated MP3 audio.
- POST /api/ocr — detect on-screen text from video frames with timestamps and Khmer translations.
- POST /api/align — align Khmer subtitle/audio segments to the source video timeline.

## Security and reliability
- Store provider API keys only as server-side environment secrets.
- Enforce upload size/duration limits and process long videos in chunks.
- Validate media types and delete temporary uploads after processing.
- Never report transcription, translation, OCR, or MP3 success unless the server actually returned a result.
- Native Android overlay must request the user's explicit Display over other apps permission.

## Android packaging
Wrap the web interface with Capacitor, then add a native Android overlay module and test on a real device. A normal browser page cannot draw over other apps or reliably export browser speech synthesis as MP3.
