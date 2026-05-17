use std::path::{Path, PathBuf};
use reqwest::{self, StatusCode};
use anyhow::{Result, anyhow};
use log::{info, warn, error};
use std::time::Duration;
use std::process::Command;

const OPENAI_AUDIO_LIMIT_BYTES: u64 = 24 * 1024 * 1024;

fn detect_audio_mime(file_path: &str) -> &'static str {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn file_size_bytes(path: &Path) -> Result<u64> {
    Ok(std::fs::metadata(path)?.len())
}

fn run_ffmpeg(args: &[&str]) -> Result<()> {
    let output = Command::new("ffmpeg").args(args).output()?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(anyhow!("ffmpeg failed: {}", stderr.trim()))
    }
}

fn ensure_ogg_compatibility(input_path: &Path, temp_dir: &Path) -> Result<PathBuf> {
    let ext = input_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ext != "ogg" && ext != "oga" {
        return Ok(input_path.to_path_buf());
    }

    let converted = temp_dir.join("normalized_from_ogg.wav");
    info!("Normalizing .ogg input to wav for Whisper compatibility");
    run_ffmpeg(&[
        "-y",
        "-i",
        input_path.to_string_lossy().as_ref(),
        "-ar",
        "16000",
        "-ac",
        "1",
        converted.to_string_lossy().as_ref(),
    ])?;
    Ok(converted)
}

fn compress_to_target_size(input_path: &Path, temp_dir: &Path) -> Result<PathBuf> {
    let original_size = file_size_bytes(input_path)?;
    if original_size <= OPENAI_AUDIO_LIMIT_BYTES {
        return Ok(input_path.to_path_buf());
    }

    info!(
        "Audio file is {} MB, trying compression ladder to fit {} MB limit",
        original_size / (1024 * 1024),
        OPENAI_AUDIO_LIMIT_BYTES / (1024 * 1024)
    );

    // Keep speech intelligibility while shrinking aggressively when needed.
    for bitrate in ["64k", "48k", "32k"] {
        let out_path = temp_dir.join(format!("compressed_{}.mp3", bitrate));
        run_ffmpeg(&[
            "-y",
            "-i",
            input_path.to_string_lossy().as_ref(),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-b:a",
            bitrate,
            out_path.to_string_lossy().as_ref(),
        ])?;

        let size = file_size_bytes(&out_path)?;
        info!(
            "Compression attempt {} produced {} MB",
            bitrate,
            size / (1024 * 1024)
        );

        if size <= OPENAI_AUDIO_LIMIT_BYTES {
            return Ok(out_path);
        }
    }

    Err(anyhow!(
        "Audio remains too large after compression attempts (still above {} MB)",
        OPENAI_AUDIO_LIMIT_BYTES / (1024 * 1024)
    ))
}

fn split_audio_for_chunked_transcription(input_path: &Path, temp_dir: &Path) -> Result<Vec<PathBuf>> {
    let chunk_pattern = temp_dir.join("chunk_%03d.mp3");

    // Segment in 20-minute chunks; with 32k mono speech this stays well below 24MB.
    run_ffmpeg(&[
        "-y",
        "-i",
        input_path.to_string_lossy().as_ref(),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-b:a",
        "32k",
        "-f",
        "segment",
        "-segment_time",
        "1200",
        "-reset_timestamps",
        "1",
        chunk_pattern.to_string_lossy().as_ref(),
    ])?;

    let mut chunks = Vec::new();
    for entry in std::fs::read_dir(temp_dir)? {
        let path = entry?.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if file_name.starts_with("chunk_") && file_name.ends_with(".mp3") {
            chunks.push(path);
        }
    }

    chunks.sort();

    if chunks.is_empty() {
        return Err(anyhow!("Failed to create audio chunks for large file"));
    }

    for chunk in &chunks {
        let size = file_size_bytes(chunk)?;
        if size > OPENAI_AUDIO_LIMIT_BYTES {
            return Err(anyhow!(
                "Chunk {} is still above {} MB",
                chunk.display(),
                OPENAI_AUDIO_LIMIT_BYTES / (1024 * 1024)
            ));
        }
    }

    Ok(chunks)
}

async fn transcribe_single_file(
    client: &reqwest::Client,
    file_path: &Path,
    api_key: &str,
    model: &str,
    base_url: &str,
) -> Result<String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav")
        .to_string();
    let mime_type = detect_audio_mime(file_path.to_string_lossy().as_ref());

    let transcription_url = if base_url.trim().is_empty() {
        "https://api.openai.com/v1/audio/transcriptions".to_string()
    } else {
        let trimmed = base_url.trim_end_matches('/');
        if trimmed.ends_with("/v1") {
            format!("{}/audio/transcriptions", trimmed)
        } else {
            format!("{}/v1/audio/transcriptions", trimmed)
        }
    };

    for attempt in 0..5 {
        if attempt > 0 {
            info!("Retry attempt {} for transcription", attempt);
        }

        let file_bytes = std::fs::read(file_path)?;

        // Build form parts manually to support dynamic model name
        let boundary = "------------------------a1b2c3d4e5f6";
        let model_field = format!(
            "--{}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{}\r\n",
            boundary, model
        );
        let format_field = format!(
            "--{}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\ntext\r\n",
            boundary
        );
        let file_field = format!(
            "--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            boundary, file_name, mime_type
        );
        let terminator = format!("\r\n--{}--\r\n", boundary);

        let body_bytes: Vec<u8> = model_field
            .into_bytes()
            .into_iter()
            .chain(format_field.into_bytes())
            .chain(file_field.into_bytes())
            .chain(file_bytes.into_iter())
            .chain(terminator.into_bytes())
            .collect();

        let response_result = client
            .post(&transcription_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", format!("multipart/form-data; boundary={}", boundary))
            .body(body_bytes)
            .send()
            .await;

        match response_result {
            Ok(response) => {
                if response.status().is_success() {
                    let text = response.text().await?;
                    info!("Transcription successful, length: {}", text.len());
                    return Ok(text);
                }

                let status = response.status();
                let error_text = response.text().await.unwrap_or_default();
                error!("Transcription failed with status {}: {}", status, error_text);

                if status == StatusCode::TOO_MANY_REQUESTS || (status.as_u16() >= 500 && status.as_u16() < 600) {
                    let sleep_duration = Duration::from_secs(2u64.pow(attempt));
                    warn!(
                        "Rate limited or server error, sleeping for {}s before retry",
                        sleep_duration.as_secs()
                    );
                    tokio::time::sleep(sleep_duration).await;
                    continue;
                }

                return Err(anyhow!("OpenAI API error {}: {}", status, error_text));
            }
            Err(err) => {
                error!("Request error: {}", err);
                let sleep_duration = Duration::from_secs(2u64.pow(attempt));
                warn!(
                    "Connection error, sleeping for {}s before retry",
                    sleep_duration.as_secs()
                );
                tokio::time::sleep(sleep_duration).await;
            }
        }
    }

    Err(anyhow!("Failed to transcribe audio after multiple attempts"))
}

/// Transcribe audio using OpenAI-compatible Whisper API
pub async fn transcribe_with_openai(
    file_path: &str,
    api_key: &str,
    model: &str,
    base_url: &str,
) -> Result<String> {
    info!("Transcribing with OpenAI Whisper API (model: {}, url: {}): {}", model, base_url, file_path);

    let input_path = Path::new(file_path);
    let temp_dir = tempfile::Builder::new().prefix("platypus_transcribe_").tempdir()?;

    let normalized_path = ensure_ogg_compatibility(input_path, temp_dir.path())?;
    let normalized_size = file_size_bytes(&normalized_path)?;
    info!("Prepared audio size: {} bytes", normalized_size);

    // Build client with longer timeout (120 seconds for large files)
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;

    if normalized_size <= OPENAI_AUDIO_LIMIT_BYTES {
        return transcribe_single_file(&client, &normalized_path, api_key, model, base_url).await;
    }

    // First attempt: compress and retry as a single file.
    if let Ok(compressed_path) = compress_to_target_size(&normalized_path, temp_dir.path()) {
        let size = file_size_bytes(&compressed_path)?;
        if size <= OPENAI_AUDIO_LIMIT_BYTES {
            return transcribe_single_file(&client, &compressed_path, api_key, model, base_url).await;
        }
    }

    // Fallback: split into chunks and concatenate transcriptions.
    warn!(
        "Audio still too large after compression; switching to chunked transcription"
    );

    let chunks = split_audio_for_chunked_transcription(&normalized_path, temp_dir.path())?;
    info!("Created {} chunk(s) for transcription", chunks.len());

    let mut full_transcript = String::new();
    for (idx, chunk_path) in chunks.iter().enumerate() {
        info!(
            "Transcribing chunk {}/{}: {}",
            idx + 1,
            chunks.len(),
            chunk_path.display()
        );

        let chunk_text = transcribe_single_file(&client, chunk_path, api_key, model, base_url).await?;
        if !full_transcript.is_empty() {
            full_transcript.push_str("\n");
        }
        full_transcript.push_str(chunk_text.trim());
    }

    Ok(full_transcript)
}
