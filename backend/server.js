async function transcribeAudio(
  audioBuffer,
  filename,
  mimeType = "audio/mpeg"
) {
  const form = new FormData();

  form.append(
    "file",
    new Blob([audioBuffer], { type: mimeType }),
    filename
  );

  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");

  const response = await fetch(
    `${API_URL}/audio/transcriptions`,
    {
      method: "POST",
      headers: authHeaders(),
      body: form
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Audio transcription failed"
    );
  }

  return data;
}
