"""
Khmer AI Translator Pro - Flask backend
Features:
- Health check and configuration status
- Upload a video and ask Gemini to translate spoken dialogue into Khmer
- Return structured segments and a valid SRT subtitle
- Optional plain-text translation endpoint
- Configurable upload limit and model name

Important:
- This backend does NOT yet render a dubbed MP4 or generate Khmer voice audio.
- A video URL is not downloaded automatically. Upload the actual video file instead.
- Long videos may exceed Gemini/API limits, server timeouts, or provider file limits.
  For videos over one hour, use a background job/queue and split the video into chunks.
"""

import json
import os
import re
import tempfile
import time
from pathlib import Path

from flask import Flask, jsonify, request, make_response
from google import genai
from google.genai import types

app = Flask(__name__)

# -------------------- Configuration --------------------
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "2048"))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

ALLOWED_EXTENSIONS = {
    ".mp4", ".mov", ".m4v", ".webm", ".mpeg", ".mpg", ".avi", ".3gp"
}


# -------------------- Common helpers --------------------
def cors_headers(response):
    """Allow browser frontends to call this API. Restrict origins in production."""
    origin = os.environ.get("FRONTEND_ORIGIN", "*")
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Max-Age"] = "86400"
    return response


@app.after_request
def add_cors(response):
    return cors_headers(response)


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify({
        "success": False,
        "error": f"វីដេអូធំពេក។ ទំហំអតិបរមាដែល Server កំណត់គឺ {MAX_UPLOAD_MB} MB។"
    }), 413


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"success": False, "error": "រកមិនឃើញ API endpoint នេះទេ។"}), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    return jsonify({"success": False, "error": "មិនគាំទ្រវិធីស្នើសុំនេះទេ។"}), 405


def api_error(message, status=400, details=None):
    payload = {"success": False, "error": message}
    if details and os.environ.get("EXPOSE_ERROR_DETAILS", "false").lower() == "true":
        payload["details"] = str(details)
    return jsonify(payload), status


def require_client():
    if client is None:
        return api_error(
            "មិនទាន់កំណត់ GEMINI_API_KEY នៅក្នុង Environment Variables របស់ Server ទេ។",
            503
        )
    return None


def clean_json_text(text):
    """Remove common Markdown JSON fences returned by a model."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def parse_segments(response_text):
    """Parse Gemini's JSON response and normalize segment fields."""
    raw = clean_json_text(response_text)
    data = json.loads(raw)

    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("segments", [])
    else:
        items = []

    segments = []
    for item in items:
        if not isinstance(item, dict):
            continue
        start = float(item.get("start", 0) or 0)
        end = float(item.get("end", start + 2) or (start + 2))
        text = str(item.get("khmer", item.get("text", ""))).strip()
        if not text:
            continue
        start = max(0.0, start)
        end = max(start + 0.2, end)
        segments.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "source": str(item.get("source", "")).strip(),
            "khmer": text
        })

    segments.sort(key=lambda x: x["start"])
    return segments


def srt_timestamp(seconds):
    milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def segments_to_srt(segments):
    blocks = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(
            f"{index}\n"
            f"{srt_timestamp(segment['start'])} --> {srt_timestamp(segment['end'])}\n"
            f"{segment['khmer']}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def build_translation_prompt(style="natural", speaker_labels=False):
    style_text = {
        "natural": "ប្រើភាសាខ្មែរធម្មជាតិ ស្តាប់ងាយ និងរក្សាអត្ថន័យដើម",
        "formal": "ប្រើភាសាខ្មែរផ្លូវការ និងច្បាស់លាស់",
        "simple": "ប្រើពាក្យខ្មែរសាមញ្ញ ងាយយល់សម្រាប់មនុស្សទូទៅ"
    }.get(style, "ប្រើភាសាខ្មែរធម្មជាតិ និងរក្សាអត្ថន័យដើម")

    speaker_rule = (
        "បើអាចសម្គាល់អ្នកនិយាយបាន សូមបញ្ចូល speaker ជា Speaker 1, Speaker 2 ជាដើម។"
        if speaker_labels else
        "កុំបង្កើតឈ្មោះអ្នកនិយាយ ប្រសិនបើមិនចាំបាច់។"
    )

    return f"""
សូមស្តាប់សំឡេងនិយាយនៅក្នុងវីដេអូ ហើយបកប្រែអ្វីដែលបាននិយាយទៅជាភាសាខ្មែរ។
គោលការណ៍៖
1. {style_text}។
2. រក្សាអត្ថន័យ មិនបន្ថែមព័ត៌មានដែលមិនមានក្នុងសំឡេង។
3. បង្កើត subtitle ជាប្រយោគខ្លីៗ តាមលំដាប់ពេលវេលា។
4. ពេល start និង end ត្រូវជាវិនាទីគិតចាប់ពីដើមវីដេអូ។
5. កុំបង្កើត timestamp ដោយស្មាន ប្រសិនបើមិនអាចកំណត់បាន សូមប្រើការប៉ាន់ប្រមាណដែលសមហេតុផល។
6. អក្សរខ្មែរត្រូវសរសេរពេញលេញ ត្រឹមត្រូវ រួមទាំងស្រៈ ជើងអក្សរ និងសញ្ញាវណ្ណយុត្តិ។
7. {speaker_rule}
8. រំលងតន្ត្រី ឬសំឡេងរំខានដែលគ្មានពាក្យនិយាយ។

សូមឆ្លើយតែ JSON សុទ្ធ តាមទម្រង់នេះ ដោយគ្មាន Markdown និងគ្មានការពន្យល់ក្រៅ JSON៖
{{
  "segments": [
    {{
      "start": 0.0,
      "end": 3.5,
      "source": "original spoken words if recognized",
      "khmer": "អត្ថបទបកប្រែជាភាសាខ្មែរ",
      "speaker": "Speaker 1"
    }}
  ]
}}
"""


# -------------------- Routes --------------------
@app.route("/", methods=["GET"])
def health_check():
    return jsonify({
        "status": "online",
        "service": "Khmer AI Translator Pro",
        "message": "Khmer AI Translator Backend is running!",
        "gemini_configured": client is not None,
        "model": GEMINI_MODEL,
        "max_upload_mb": MAX_UPLOAD_MB,
        "features": {
            "video_upload": True,
            "khmer_translation": True,
            "srt_subtitles": True,
            "speaker_labels": True,
            "khmer_voice_dubbing": False,
            "mp4_rendering": False,
            "video_url_import": False
        }
    }), 200


@app.route("/health", methods=["GET"])
def health():
    return health_check()


@app.route("/translate-video", methods=["POST", "OPTIONS"])
def translate_video():
    if request.method == "OPTIONS":
        return make_response("", 204)

    missing = require_client()
    if missing:
        return missing

    temp_path = None
    uploaded_file = None

    try:
        video_file = request.files.get("video") or request.files.get("file")
        if not video_file or not video_file.filename:
            return api_error(
                "សូមជ្រើសរើស និងផ្ញើឯកសារវីដេអូក្នុង field ឈ្មោះ video។ "
                "មុខងារផ្ញើ URL មិនទាន់គាំទ្រទេ។",
                400
            )

        suffix = Path(video_file.filename).suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            return api_error(
                "ប្រភេទវីដេអូមិនទាន់គាំទ្រទេ។ សូមប្រើ MP4, MOV, WEBM, AVI ឬប្រភេទវីដេអូទូទៅ។",
                415
            )

        style = request.form.get("style", "natural")
        speaker_labels = request.form.get("speaker_labels", "false").lower() == "true"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            video_file.save(temp_file)
            temp_path = temp_file.name

        if os.path.getsize(temp_path) == 0:
            return api_error("ឯកសារវីដេអូទទេ ឬមិនអាចអានបាន។", 400)

        # Upload video to Gemini Files API.
        uploaded_file = client.files.upload(file=temp_path)

        # Wait until the uploaded video is ready for processing, when file state exists.
        # Some SDK/API versions may return a file without a state field.
        for _ in range(60):
            state = getattr(uploaded_file, "state", None)
            state_name = getattr(state, "name", str(state)).upper() if state else ""
            if "PROCESSING" not in state_name:
                break
            time.sleep(2)
            uploaded_file = client.files.get(name=uploaded_file.name)
        else:
            return api_error("ការរៀបចំវីដេអូយូរពេក។ សូមសាកល្បងម្ដងទៀត។", 504)

        state = getattr(uploaded_file, "state", None)
        state_name = getattr(state, "name", str(state)).upper() if state else ""
        if "FAILED" in state_name:
            return api_error("Gemini មិនអាចដំណើរការឯកសារវីដេអូនេះបានទេ។", 422)

        prompt = build_translation_prompt(style, speaker_labels)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[uploaded_file, prompt],
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json"
            )
        )

        response_text = getattr(response, "text", None) or ""
        if not response_text.strip():
            return api_error("AI មិនបានផ្តល់លទ្ធផលទេ។ សូមសាកល្បងជាមួយវីដេអូមួយផ្សេងទៀត។", 502)

        try:
            segments = parse_segments(response_text)
        except (ValueError, TypeError, json.JSONDecodeError):
            return jsonify({
                "success": False,
                "error": "AI បានត្រឡប់ទិន្នន័យមិនមែន JSON ត្រឹមត្រូវ។ សូមសាកល្បងម្ដងទៀត។",
                "raw_result": response_text[:12000]
            }), 502

        if not segments:
            return api_error("មិនរកឃើញប្រយោគនិយាយដែលអាចបកប្រែបានទេ។", 422)

        srt_text = segments_to_srt(segments)
        return jsonify({
            "success": True,
            "message": "បកប្រែ និងបង្កើត Subtitle បានជោគជ័យ។",
            "translation_result": srt_text,
            "srt": srt_text,
            "segments": segments,
            "segment_count": len(segments),
            "source_filename": Path(video_file.filename).name,
            "note": "លទ្ធផលនេះជាអត្ថបទ និង SRT ប៉ុណ្ណោះ។ មិនទាន់បង្កើតសំឡេងខ្មែរ ឬ MP4 dubbed ទេ។"
        }), 200

    except Exception as exc:
        # Avoid exposing API keys or internal server details to clients.
        app.logger.exception("Video translation failed")
        return api_error(
            "មានបញ្ហាក្នុងការបកប្រែវីដេអូ។ សូមពិនិត្យ API Key, ទំហំវីដេអូ និង Server Logs រួចសាកល្បងម្ដងទៀត។",
            500,
            details=exc
        )

    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                app.logger.warning("Could not remove temporary upload file")
        if uploaded_file and client:
            try:
                client.files.delete(name=uploaded_file.name)
            except Exception:
                app.logger.warning("Could not delete temporary Gemini file")


@app.route("/translate-text", methods=["POST", "OPTIONS"])
def translate_text():
    if request.method == "OPTIONS":
        return make_response("", 204)

    missing = require_client()
    if missing:
        return missing

    data = request.get_json(silent=True) or {}
    source_text = str(data.get("text", "")).strip()
    if not source_text:
        return api_error("សូមបញ្ចូលអត្ថបទដែលត្រូវបកប្រែ។", 400)

    if len(source_text) > 30000:
        return api_error("អត្ថបទវែងពេក។ សូមបំបែកជាផ្នែកតូចៗ។", 413)

    style = data.get("style", "natural")
    prompt = (
        "បកប្រែអត្ថបទខាងក្រោមទៅជាភាសាខ្មែរ។ "
        "រក្សាអត្ថន័យដើម ប្រើអក្ខរាវិរុទ្ធខ្មែរត្រឹមត្រូវ និងកុំបន្ថែមព័ត៌មាន។\n\n"
        f"អត្ថបទ៖\n{source_text}"
    )

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt + f"\nរបៀបសរសេរ៖ {style}",
            config=types.GenerateContentConfig(temperature=0.2)
        )
        translated = getattr(response, "text", None) or ""
        if not translated.strip():
            return api_error("AI មិនបានផ្តល់លទ្ធផលបកប្រែទេ។", 502)
        return jsonify({"success": True, "translation": translated.strip()})
    except Exception as exc:
        app.logger.exception("Text translation failed")
        return api_error("មិនអាចបកប្រែអត្ថបទបានទេ។ សូមពិនិត្យ Server Logs។", 500, exc)


@app.route("/download-srt", methods=["POST", "OPTIONS"])
def download_srt():
    if request.method == "OPTIONS":
        return make_response("", 204)

    data = request.get_json(silent=True) or {}
    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        return api_error("សូមផ្ញើ segments ជាបញ្ជីដែលមានទិន្នន័យ។", 400)

    try:
        normalized = []
        for item in segments:
            if not isinstance(item, dict):
                continue
            normalized.append({
                "start": max(0.0, float(item.get("start", 0))),
                "end": max(0.2, float(item.get("end", 0.2))),
                "khmer": str(item.get("khmer", item.get("text", ""))).strip()
            })
        srt_text = segments_to_srt(normalized)
        response = make_response(srt_text)
        response.headers["Content-Type"] = "text/plain; charset=utf-8"
        response.headers["Content-Disposition"] = 'attachment; filename="khmer_subtitles.srt"'
        return response
    except (TypeError, ValueError) as exc:
        return api_error("ទិន្នន័យ timestamp មិនត្រឹមត្រូវទេ។", 400, exc)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
