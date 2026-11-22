import os
import shutil
import subprocess
import tempfile
from flask import Flask, request, jsonify
from google import genai
from google.genai import types

app = Flask(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


def extract_fast_audio(video_path: str) -> str | None:
    """បំបែកយកតែសំឡេង MP3 ទំហំតូចដើម្បីឱ្យ Upload និងបកប្រែលឿន។"""
    if not shutil.which("ffmpeg"):
        return None

    audio_path = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3").name
    cmd = [
        "ffmpeg",
        "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "libmp3lame",
        "-ar", "16000",
        "-ac", "1",
        "-b:a", "48k",
        audio_path,
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        if os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
            return audio_path
    except Exception:
        pass

    if os.path.exists(audio_path):
        try:
            os.unlink(audio_path)
        except Exception:
            pass
    return None


@app.route("/", methods=["GET"])
@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "online",
        "message": "Khmer AI Translator Backend is running!",
        "gemini_configured": client is not None,
    }), 200


@app.route("/translate-video", methods=["POST"])
def translate_video():
    if not client:
        return jsonify({"success": False, "error": "Gemini API Key is missing on the server backend."}), 500

    temp_vid_path = None
    temp_audio_path = None
    uploaded_file = None

    try:
        video_file = request.files.get("video")
        data = request.get_json(silent=True) or {}
        video_url = data.get("video_url")

        if not video_file and not video_url:
            return jsonify({"success": False, "error": "សូមបញ្ជូន File វីដេអូ ឬ Video URL មកជាមួយ។"}), 400

        prompt = (
            "សូមស្តាប់ និងបកប្រែជាភាសាខ្មែរឱ្យបានរហ័ស និងច្បាស់លាស់ ជាទម្រង់អត្ថបទរង SRT "
            "(មានលេខលំដាប់ ម៉ោងចាប់ផ្តើម -> ម៉ោងបញ្ចប់ និងអត្ថបទភាសាខ្មែរ)។ មិនបាច់ពន្យល់បន្ថែមទេ។"
        )

        if video_file:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as temp_vid:
                video_file.save(temp_vid.name)
                temp_vid_path = temp_vid.name

            # ព្យាយាមបំបែកយកតែសំឡេង MP3 ដើម្បីឱ្យ Upload និងបកប្រែលឿនជាងវីដេអូ
            temp_audio_path = extract_fast_audio(temp_vid_path)
            file_to_upload = temp_audio_path if temp_audio_path else temp_vid_path

            uploaded_file = client.files.upload(file=file_to_upload)

            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[uploaded_file, prompt],
                config=types.GenerateContentConfig(temperature=0.2),
            )

            result_text = response.text if response and getattr(response, "text", None) else "មិនមានលទ្ធផលត្រឡប់មកវិញទេ។"

            return jsonify({
                "success": True,
                "used_audio_only": temp_audio_path is not None,
                "translation_result": result_text,
            }), 200

        elif video_url:
            url_prompt = (
                f"សូមវិភាគ និងបកប្រែខ្លឹមសារវីដេអូពីតំណភ្ជាប់នេះ (URL: {video_url}) ទៅជាភាសាខ្មែរ "
                "ជាទម្រង់ SRT Subtitle ដោយខ្លី និងច្បាស់លាស់។"
            )
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=url_prompt,
                config=types.GenerateContentConfig(temperature=0.2),
            )

            result_text = response.text if response and getattr(response, "text", None) else "មិនមានលទ្ធផលត្រឡប់មកវិញទេ។"

            return jsonify({
                "success": True,
                "translation_result": result_text,
            }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        for path in (temp_vid_path, temp_audio_path):
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except Exception:
                    pass
        if uploaded_file and client:
            try:
                client.files.delete(name=uploaded_file.name)
            except Exception:
                pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
    
