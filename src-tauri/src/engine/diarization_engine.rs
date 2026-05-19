use anyhow::{anyhow, Result};
use log::{info, warn};
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

const WE_SPEAKER_MIN_FRAMES: usize = 50;

#[derive(Debug, Clone, Copy)]
enum InputLayout {
    BatchMelsFrames,
    BatchFramesMels,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizedSegment {
    pub speaker_id: u32,
    pub text: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub language: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StreamingDiarizer {
    centroids: Vec<Vec<f32>>,
    centroid_sample_counts: Vec<u32>,
    threshold: f32,
    max_speakers: usize,
    stable_speaker_id: Option<u32>,
    candidate_speaker_id: Option<u32>,
    candidate_count: u8,
    recent_primary_ids: VecDeque<u32>,
}

#[derive(Debug, Clone, Copy)]
pub struct SpeakerAssignment {
    pub speaker_id: u32,
    pub secondary_speaker_id: Option<u32>,
    pub is_overlap: bool,
}

impl StreamingDiarizer {
    pub fn new(threshold: f32, max_speakers: usize) -> Self {
        Self {
            centroids: Vec::new(),
            centroid_sample_counts: Vec::new(),
            threshold,
            max_speakers,
            stable_speaker_id: None,
            candidate_speaker_id: None,
            candidate_count: 0,
            recent_primary_ids: VecDeque::new(),
        }
    }

    pub fn reset(&mut self) {
        self.centroids.clear();
        self.centroid_sample_counts.clear();
        self.stable_speaker_id = None;
        self.candidate_speaker_id = None;
        self.candidate_count = 0;
        self.recent_primary_ids.clear();
    }

    pub fn assign_speaker(&mut self, embedding: &[f32]) -> u32 {
        self.assign_speaker_with_overlap(embedding).speaker_id
    }

    pub fn assign_speaker_with_overlap(&mut self, embedding: &[f32]) -> SpeakerAssignment {
        const OVERLAP_MIN_SIM: f32 = 0.60;
        const OVERLAP_MAX_GAP: f32 = 0.15;

        if embedding.is_empty() {
            return SpeakerAssignment {
                speaker_id: 0,
                secondary_speaker_id: None,
                is_overlap: false,
            };
        }

        let mut best_idx: Option<usize> = None;
        let mut best_score = f32::MIN;
        let mut second_idx: Option<usize> = None;
        let mut second_score = f32::MIN;

        for (idx, centroid) in self.centroids.iter().enumerate() {
            let score = cosine_similarity(embedding, centroid);
            if score > best_score {
                second_score = best_score;
                second_idx = best_idx;
                best_score = score;
                best_idx = Some(idx);
            } else if score > second_score {
                second_score = score;
                second_idx = Some(idx);
            }
        }

        if best_idx.is_none() {
            self.centroids.push(embedding.to_vec());
            self.centroid_sample_counts.push(1);
            let speaker_id = self.smooth_primary_speaker(1);
            return SpeakerAssignment {
                speaker_id,
                secondary_speaker_id: None,
                is_overlap: false,
            };
        }

        let idx = best_idx.unwrap();
        if best_score < self.threshold && self.centroids.len() < self.max_speakers {
            self.centroids.push(embedding.to_vec());
            self.centroid_sample_counts.push(1);
            let speaker_id = self.smooth_primary_speaker(self.centroids.len() as u32);
            return SpeakerAssignment {
                speaker_id,
                secondary_speaker_id: None,
                is_overlap: false,
            };
        }

        let is_overlap = second_idx.is_some()
            && best_score >= OVERLAP_MIN_SIM
            && second_score >= OVERLAP_MIN_SIM
            && (best_score - second_score).abs() <= OVERLAP_MAX_GAP;

        if is_overlap {
            return SpeakerAssignment {
                speaker_id: (idx + 1) as u32,
                secondary_speaker_id: second_idx.map(|s| (s + 1) as u32),
                is_overlap: true,
            };
        }

        let sample_count = self.centroid_sample_counts.get(idx).copied().unwrap_or(1);
        let (retain_weight, new_weight) = centroid_update_weights(sample_count);

        // Adaptive centroid update: learn fast early, then stabilize.
        if let Some(existing) = self.centroids.get_mut(idx) {
            for i in 0..existing.len().min(embedding.len()) {
                existing[i] = retain_weight * existing[i] + new_weight * embedding[i];
            }
            normalize(existing);
        }

        if let Some(count) = self.centroid_sample_counts.get_mut(idx) {
            *count = count.saturating_add(1);
        }

        let speaker_id = self.smooth_primary_speaker((idx + 1) as u32);

        SpeakerAssignment {
            speaker_id,
            secondary_speaker_id: None,
            is_overlap: false,
        }
    }

    fn smooth_primary_speaker(&mut self, raw_speaker_id: u32) -> u32 {
        const HISTORY_LIMIT: usize = 5;
        const SWITCH_CONFIRMATIONS: u8 = 2;

        let output = match self.stable_speaker_id {
            None => {
                self.stable_speaker_id = Some(raw_speaker_id);
                self.candidate_speaker_id = None;
                self.candidate_count = 0;
                raw_speaker_id
            }
            Some(stable) if raw_speaker_id == stable => {
                self.candidate_speaker_id = None;
                self.candidate_count = 0;
                stable
            }
            Some(stable) => {
                if self.candidate_speaker_id == Some(raw_speaker_id) {
                    self.candidate_count = self.candidate_count.saturating_add(1);
                } else {
                    self.candidate_speaker_id = Some(raw_speaker_id);
                    self.candidate_count = 1;
                }

                if self.candidate_count >= SWITCH_CONFIRMATIONS {
                    self.stable_speaker_id = Some(raw_speaker_id);
                    self.candidate_speaker_id = None;
                    self.candidate_count = 0;
                    raw_speaker_id
                } else {
                    stable
                }
            }
        };

        self.recent_primary_ids.push_back(output);
        while self.recent_primary_ids.len() > HISTORY_LIMIT {
            self.recent_primary_ids.pop_front();
        }

        output
    }
}

fn centroid_update_weights(sample_count: u32) -> (f32, f32) {
    if sample_count <= 5 {
        return (0.5, 0.5);
    }

    if sample_count >= 50 {
        return (0.95, 0.05);
    }

    let t = (sample_count - 5) as f32 / 45.0;
    let retain_weight = 0.5 + (0.45 * t);
    (retain_weight, 1.0 - retain_weight)
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len().min(b.len()) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn normalize(v: &mut [f32]) {
    let norm = (v.iter().map(|x| x * x).sum::<f32>()).sqrt().max(1e-8);
    for x in v.iter_mut() {
        *x /= norm;
    }
}

pub struct DiarizationEngine {
    model_path: PathBuf,
    session: Mutex<Session>,
    input_layout: Mutex<Option<InputLayout>>,
}

impl DiarizationEngine {
    pub fn load(model_path: PathBuf) -> Result<Self> {
        if !model_path.exists() {
            return Err(anyhow!("Diarization model not found at {:?}", model_path));
        }

        let session = Session::builder()?.commit_from_file(&model_path)?;
        info!("Diarization model ready at {:?}", model_path);
        Ok(Self {
            model_path,
            session: Mutex::new(session),
            input_layout: Mutex::new(None),
        })
    }

    pub fn embed(&self, log_mel: &[Vec<f32>]) -> Result<Vec<f32>> {
        if log_mel.is_empty() {
            return Ok(Vec::new());
        }

        let n_mels = log_mel.first().map(|frame| frame.len()).unwrap_or(0);
        if n_mels == 0 || log_mel.iter().any(|frame| frame.len() != n_mels) {
            return Ok(Vec::new());
        }

        let prepared = prepare_log_mel(log_mel, n_mels);
        let cached_layout = *self
            .input_layout
            .lock()
            .map_err(|_| anyhow!("Diarization input layout mutex poisoned"))?;

        if let Some(layout) = cached_layout {
            if let Ok(embedding) = self.run_embedding(&prepared, n_mels, layout) {
                return Ok(embedding);
            }
        }

        for layout in [InputLayout::BatchMelsFrames, InputLayout::BatchFramesMels] {
            match self.run_embedding(&prepared, n_mels, layout) {
                Ok(embedding) => {
                    *self
                        .input_layout
                        .lock()
                        .map_err(|_| anyhow!("Diarization input layout mutex poisoned"))? =
                        Some(layout);
                    return Ok(embedding);
                }
                Err(err) => {
                    warn!("Diarization inference failed for {:?}: {}", layout, err);
                }
            }
        }

        Err(anyhow!(
            "Diarization inference failed for all supported input layouts"
        ))
    }

    pub fn model_path(&self) -> &PathBuf {
        &self.model_path
    }

    fn run_embedding(
        &self,
        prepared: &[f32],
        n_mels: usize,
        layout: InputLayout,
    ) -> Result<Vec<f32>> {
        let frame_count = prepared.len() / n_mels;
        if frame_count == 0 {
            return Ok(Vec::new());
        }

        let shape = match layout {
            InputLayout::BatchMelsFrames => vec![1usize, n_mels, frame_count],
            InputLayout::BatchFramesMels => vec![1usize, frame_count, n_mels],
        };
        let input = Tensor::<f32>::from_array((shape, prepared.to_vec().into_boxed_slice()))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow!("Diarization session mutex poisoned"))?;
        let outputs = session.run(ort::inputs![input])?;
        if outputs.len() == 0 {
            return Err(anyhow!("Diarization model returned no outputs"));
        }

        let (_, data) = outputs[0].try_extract_tensor::<f32>()?;
        if data.is_empty() {
            return Ok(Vec::new());
        }

        let mut embedding = data.to_vec();
        normalize(&mut embedding);
        Ok(embedding)
    }
}

fn prepare_log_mel(log_mel: &[Vec<f32>], n_mels: usize) -> Vec<f32> {
    let frame_count = log_mel.len().max(WE_SPEAKER_MIN_FRAMES);
    let mut flattened = vec![0.0f32; frame_count * n_mels];

    for (frame_idx, frame) in log_mel.iter().enumerate() {
        let base = frame_idx * n_mels;
        flattened[base..(base + n_mels)].copy_from_slice(frame);
    }

    if log_mel.len() < frame_count {
        let src_start = (log_mel.len().saturating_sub(1)) * n_mels;
        let last_frame = if log_mel.is_empty() {
            vec![0.0f32; n_mels]
        } else {
            flattened[src_start..(src_start + n_mels)].to_vec()
        };
        for frame_idx in log_mel.len()..frame_count {
            let base = frame_idx * n_mels;
            flattened[base..(base + n_mels)].copy_from_slice(&last_frame);
        }
    }

    flattened
}

pub fn diarization_model_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hermeneia_notes")
        .join("models")
}

pub fn diarization_model_path() -> PathBuf {
    diarization_model_dir().join("wespeaker-resnet34-lm.onnx")
}

pub fn is_diarization_model_downloaded() -> bool {
    let path = diarization_model_path();
    path.exists() && path.metadata().map(|m| m.len() > 1_000_000).unwrap_or(false)
}

pub async fn download_diarization_model(app_handle: &tauri::AppHandle) -> Result<()> {
    use futures::StreamExt;
    use std::io::Write;
    use tauri::Manager;

    const MODEL_URL: &str = "https://huggingface.co/wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/wespeaker_resnet34_LM.onnx";

    let dir = diarization_model_dir();
    std::fs::create_dir_all(&dir)?;

    let dest = diarization_model_path();
    let tmp = dest.with_extension("onnx.tmp");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;

    let resp = client.get(MODEL_URL).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "Diarization model download failed with status {}",
            resp.status()
        ));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&tmp)?;
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let percent = ((downloaded as f64 / total_size as f64) * 100.0) as u8;
            if percent != last_percent {
                last_percent = percent;
                if let Some(w) = app_handle.get_window("main") {
                    let _ = w.emit(
                        "diarization-download-progress",
                        serde_json::json!({ "percent": percent }),
                    );
                }
            }
        }
    }

    drop(file);
    std::fs::rename(&tmp, &dest)?;
    info!("Diarization model downloaded successfully to {:?}", dest);
    Ok(())
}

pub fn merge_adjacent_segments(segments: &[DiarizedSegment]) -> Vec<DiarizedSegment> {
    if segments.is_empty() {
        return Vec::new();
    }

    let mut merged: Vec<DiarizedSegment> = Vec::new();
    for seg in segments {
        if let Some(last) = merged.last_mut() {
            if last.speaker_id == seg.speaker_id {
                if !last.text.is_empty() && !seg.text.is_empty() {
                    last.text.push(' ');
                }
                last.text.push_str(&seg.text);
                continue;
            }
        }
        merged.push(seg.clone());
    }

    merged
}

pub fn batch_recluster(segments: &mut [DiarizedSegment], max_speakers: usize) {
    if segments.is_empty() || max_speakers == 0 {
        return;
    }

    // Start implementation: keep deterministic IDs in this phase.
    // Full agglomerative re-clustering over embeddings lands next.
    if segments.len() > 400 {
        warn!("Skipping recluster for very long transcript ({} chunks)", segments.len());
    }
}

fn split_into_text_units(text: &str) -> Vec<String> {
    let normalized = text
        .replace('\n', " ")
        .replace('\r', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if normalized.is_empty() {
        return Vec::new();
    }

    let mut units: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in normalized.chars() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | ';' | ':') {
            let chunk = current.trim();
            if !chunk.is_empty() {
                units.push(chunk.to_string());
            }
            current.clear();
        }
    }

    let trailing = current.trim();
    if !trailing.is_empty() {
        units.push(trailing.to_string());
    }

    if units.is_empty() {
        return vec![normalized];
    }

    // Merge very short units to reduce noisy speaker switches.
    let mut merged: Vec<String> = Vec::new();
    for unit in units {
        if unit.len() < 28 {
            if let Some(last) = merged.last_mut() {
                last.push(' ');
                last.push_str(&unit);
                continue;
            }
        }
        merged.push(unit);
    }

    merged
}

fn text_embedding(text: &str, dims: usize) -> Vec<f32> {
    let mut vec = vec![0.0f32; dims];
    if dims == 0 {
        return vec;
    }

    for token in text
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
    {
        let mut hash: u64 = 1469598103934665603;
        for b in token.bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(1099511628211);
        }
        let idx = (hash as usize) % dims;
        vec[idx] += 1.0;
    }

    normalize(&mut vec);
    vec
}

pub fn rediarize_existing_text(text: &str, max_speakers: usize) -> Vec<DiarizedSegment> {
    let units = split_into_text_units(text);
    if units.is_empty() {
        return Vec::new();
    }

    let mut diarizer = StreamingDiarizer::new(0.84, max_speakers.max(1));
    let mut segments = Vec::with_capacity(units.len());

    for unit in units {
        let embedding = text_embedding(&unit, 64);
        let speaker_id = diarizer.assign_speaker(&embedding);
        segments.push(DiarizedSegment {
            speaker_id,
            text: unit,
            start_ms: None,
            end_ms: None,
            language: None,
        });
    }

    merge_adjacent_segments(&segments)
}

pub fn format_segments_as_plain_text(segments: &[DiarizedSegment]) -> String {
    segments
        .iter()
        .map(|s| format!("Speaker {}: {}", s.speaker_id, s.text.trim()))
        .collect::<Vec<String>>()
        .join("\n")
}
