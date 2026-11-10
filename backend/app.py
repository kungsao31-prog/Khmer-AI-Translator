import os
import tempfile
from flask import Flask, request, jsonify
from google import genai

app = Flask(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

@app.route('/', methods=['GET'])
def health_check():
    return jsonify({
        "status": "online",
        "message": "Khmer AI Translator Backend is running!",
        "gemini_configured": client is not None
    }), 200

@app.route('/translate-video', methods=['POST'])
def translate_video():
    if not client:
        return jsonify({"success": False, "error": "Gemini API Key is missing on the server backend."}), 500
    
    temp_vid_path = None
    uploaded_file = None
    
    try:
        video_file = request.files.get('video')
        data = request.get_json(silent=True) or {}
        video_url = data.get('video_url')

        if not video_file and not video_url:
            return jsonify({"success": False, "error": "សូមបញ្ជូន File វីដេអូ ឬ Video URL មកជាមួយ។"}), 400

        # ករណីផ្ញើមកជា File វីដេអូផ្ទាល់
        if video_file:
            with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as temp_vid:
                video_file.save(temp_vid.name)
                temp_vid_path = temp_vid.name

            # 1. Upload ទៅកាន់ Gemini Files API
            uploaded_file = client.files.upload(file=temp_vid_path)

            # 2. បង្កើត Prompt សម្រាប់បកប្រែ និងបង្កើត SRT
            prompt = (
                "សូមស្តាប់វីដេអូនេះ បកប្រែអត្ថន័យជាភាសាខ្មែរ និងបង្កើតជាទម្រង់អត្ថបទរង SRT "
                "(មានម៉ោងចាប់ផ្តើម និងបញ្ចប់ ព្រមទាំងអត្ថបទបកប្រែជាភាសាខ្មែរ)។"
            )
            
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=[uploaded_file, prompt]
            )

            result_text = response.text if response and hasattr(response, 'text') else "មិនមានលទ្ធផលត្រឡប់មកវិញទេ។"

            return jsonify({
                "success": True,
                "translation_result": result_text
            }), 200

        # ករណីផ្ញើមកជា Video URL
        elif video_url:
            prompt = (
                f"សូមវិភាគ និងបកប្រែវីដេអូពីតំណភ្ជាប់នេះ (URL: {video_url}) ទៅជាភាសាខ្មែរ "
                "ព្រមទាំងបង្កើតជាទម្រង់ SRT Subtitle ជូនខ្ញុំផង។"
            )
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt
            )
            
            result_text = response.text if response and hasattr(response, 'text') else "មិនមានលទ្ធផលត្រឡប់មកវិញទេ។"
            
            return jsonify({
                "success": True,
                "translation_result": result_text
            }), 200

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    finally:
        # សម្អាតឯកសារបណ្តោះអាសន្នចេញពី Server ជានិច្ច
        if temp_vid_path and os.path.exists(temp_vid_path):
            try:
                os.unlink(temp_vid_path)
            except Exception:
                pass
        # សម្អាត ፋይልពី Gemini Server
        if uploaded_file and client:
            try:
                client.files.delete(name=uploaded_file.name)
            except Exception:
                pass

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
          
