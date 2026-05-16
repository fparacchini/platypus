use rusqlite_from_row::FromRow;
use serde_derive::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, FromRow, Clone)]
pub struct Settings {
    pub is_dev_mode: bool,
    pub interval: String,
    pub auto_start: bool,
    pub api_choice: String,
    pub api_key_claude: String,
    pub api_key_open_ai: String,
    pub openai_api_base: String,
    pub api_key_gemini: String,
    pub local_model_url: String,
    pub vectorization_enabled: bool,
    pub rag_top_k: i32,
    pub meeting_detection_enabled: bool,
    pub model_claude: String,
    pub model_openai: String,
    pub model_gemini: String,
    pub use_local_transcription: bool,
    pub whisper_model: String,
    pub use_diarization: bool,
    pub max_speakers: i32,
    pub polish_language_mode: String,
    pub polish_target_language: String,
    pub api_key_elevenlabs: String,
    pub embed_api_base: String,
    pub embed_model: String,
}