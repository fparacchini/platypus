// Prevents additional console window on Windows in release!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::sync::Arc;

use chrono::Local;
use lazy_static::lazy_static;
use log::info;
use rusqlite::Connection;
use serde_derive::{Deserialize, Serialize};
use tauri::utils::config::AppUrl;
use tauri::SystemTray;
use tauri::{AppHandle, Manager, State, SystemTrayEvent, WindowUrl};
use tauri::{CustomMenuItem, SystemTrayMenu};
use tauri_plugin_log::LogTarget;
use tokio::sync::Mutex;

use configuration::settings::Settings;
use engine::diarization_engine::{
    batch_recluster, diarization_model_path, format_segments_as_plain_text,
    merge_adjacent_segments, rediarize_existing_text, DiarizationEngine, DiarizedSegment,
    StreamingDiarizer,
};

use crate::bootstrap::{fix_path_env, prerequisites, setup_directories};
use crate::configuration::database;
use crate::configuration::database::drop_database_handle;
use crate::configuration::state::{AppState, ServiceAccess};
use crate::engine::chat_engine::{name_conversation, send_prompt_to_llm};
use crate::engine::chat_engine_openai::{send_prompt_to_openai, list_openai_models, list_openai_audio_models};
use crate::engine::chat_engine_gemini::{name_conversation_gemini, send_prompt_to_gemini};
use crate::engine::chat_engine_local::{name_conversation_local, send_prompt_to_local, list_local_models};
use crate::engine::clean_up_engine::clean_up;
use crate::engine::document_cleanup_engine::{clean_up_document_with_llm, summarize_as_meeting_notes, generate_slides_from_document, polish_transcript_with_llm, generate_note_title_with_llm};
use crate::engine::podcast_generator::{generate_podcast_from_document, list_elevenlabs_voices};
use crate::engine::meeting_popup::{meeting_popup_dismiss, meeting_popup_start_recording};
use crate::engine::url_ingestion::ingest_url_command;
use crate::engine::similarity_search_engine::SyncSimilaritySearch;
use crate::entity::chat_item::{Chat, StoredMessage};
use crate::entity::permission::Permission;
use crate::entity::project::Project;
use crate::entity::setting::Setting;
use crate::permissions::permission_engine::init_permissions;
use crate::repository::chat_db_repository;
use crate::repository::chunk_repository::{save_chunks_for_document, get_chunk_full_text};
use crate::repository::permissions_repository::{get_permissions, update_permission};
use crate::repository::project_repository::{
    delete_project, fetch_all_projects, add_blank_document, save_project, update_project, get_activity_text_from_project, get_activity_plain_text, get_project_id_for_document, update_activity_text, update_activity_name, update_activity_diarization_json, delete_project_document, ensure_unassigned_project, move_document_to_project, get_all_documents,
    get_activity_transcript_workspace, update_activity_transcript_workspace,
};
use crate::repository::settings_repository::{get_setting, get_settings, insert_or_update_setting};
use tauri_plugin_autostart::MacosLauncher;

mod bootstrap;
mod configuration;
mod engine;
mod entity;
pub mod permissions;
mod repository;

#[derive(Clone, Serialize)]
struct Payload {
    data: bool,
}

#[derive(Clone, Serialize)]
struct AudioImportProcessedResult {
    note_html: String,
    raw_text: String,
    diarization_json: Option<String>,
    note_title: String,
    polish_applied: bool,
    polished_text: Option<String>,
    diarization_model: Option<String>,
    synthesis_model: Option<String>,
    polish_language_mode: Option<String>,
    polish_target_language: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TranscriptRawSegment {
    speaker_id: u32,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    text: String,
    original_text: Option<String>,
    language: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TranscriptWorkspaceMetadata {
    diarization_model: String,
    synthesis_model: String,
    source_language: String,
    target_language: String,
    polish_language_mode: String,
}

#[derive(Clone, Serialize)]
struct TranscriptWorkspaceResponse {
    has_workspace: bool,
    raw_segments: Vec<TranscriptRawSegment>,
    polished_text: String,
    diarization_model: String,
    synthesis_model: String,
    source_language: String,
    target_language: String,
    polish_language_mode: String,
}

#[cfg(debug_assertions)]
const USE_LOCALHOST_SERVER: bool = false;
#[cfg(not(debug_assertions))]
const USE_LOCALHOST_SERVER: bool = true;

lazy_static! {
    static ref HNSW: SyncSimilaritySearch = Arc::new(Mutex::new(None));
    static ref WHISPER_ENGINE: Arc<std::sync::Mutex<Option<crate::engine::whisper_engine::WhisperEngine>>> =
        Arc::new(std::sync::Mutex::new(None));
    static ref ACCUMULATED_TRANSCRIPT: Arc<std::sync::Mutex<String>> =
        Arc::new(std::sync::Mutex::new(String::new()));
    static ref DIARIZATION_ENGINE: Arc<std::sync::Mutex<Option<DiarizationEngine>>> =
        Arc::new(std::sync::Mutex::new(None));
    static ref STREAMING_DIARIZER: Arc<std::sync::Mutex<StreamingDiarizer>> =
        Arc::new(std::sync::Mutex::new(StreamingDiarizer::new(0.75, 6)));
    static ref DIARIZED_SEGMENTS: Arc<std::sync::Mutex<Vec<DiarizedSegment>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    static ref TRANSCRIPT_CURSOR_MS: Arc<std::sync::Mutex<u64>> =
        Arc::new(std::sync::Mutex::new(0));
}

//#[cfg(any(target_os = "macos"))]
//static ACCESSIBILITY_PERMISSIONS_GRANTED: AtomicBool = AtomicBool::new(false);

#[tokio::main]
async fn main() {
    let port = 5173;
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_oauth::init());

    fix_path_env::fix_all_vars().expect("Failed to load env");
    let tray = build_system_tray();

    let mut context = tauri::generate_context!();

    let url = format!("http://localhost:{}", port).parse().unwrap();
    let window_url = WindowUrl::External(url);

    if USE_LOCALHOST_SERVER == true {
        context.config_mut().build.dist_dir = AppUrl::Url(window_url.clone());
        context.config_mut().build.dev_path = AppUrl::Url(window_url.clone());
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([LogTarget::Stdout, LogTarget::Webview])
                .level_for("hnsw_rs", log::LevelFilter::Warn)
                .level_for("html5ever", log::LevelFilter::Warn)
                .level_for("selectors", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_positioner::init())
        .system_tray(tray)
        .on_system_tray_event(|app, event| match event {
            // Ensure the window is toggled when the tray icon is clicked
            SystemTrayEvent::LeftClick { .. } => {
                let window = app.get_window("main").unwrap();
                if window.is_visible().unwrap() {
                    window.hide().unwrap();
                } else {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "start_stop_recording" => {
                    let wrapped_window = app.get_window("main");
                    if let Some(window) = wrapped_window {
                        window
                            .emit("toggle_recording", Payload { data: true })
                            .unwrap();
                    }
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            update_settings,
            get_latest_settings,
            get_app_version,
            send_prompt_to_llm,
            send_prompt_to_openai,
            send_prompt_to_gemini,
            send_prompt_to_local,
            list_openai_models,
            list_openai_audio_models,

            name_conversation_gemini,
            name_conversation_local,
            list_local_models,
            name_conversation,
            create_chat,
            get_all_chats,
            create_message,
            get_messages_by_chat_id,
            update_chat_name,
            update_app_permissions,
            get_app_permissions,
            get_projects,
            save_app_project,
            update_app_project,
            delete_app_project,
            delete_chat,
            get_chunk_text,
            prompt_for_accessibility_permissions,
            get_app_project_activity_text,
            update_project_activity_text,
            update_project_activity_diarization,
            rediarize_existing_recording,
            vectorize_document_chunks,
            add_project_blank_activity,
            update_project_activity_name,
            delete_project_activity,
            ensure_unassigned_activity,
            update_project_activity_content,
            get_app_project_activity_plain_text,
            get_project_activity_transcript_workspace,
            regenerate_project_activity_polished_transcript,
            update_project_activity_transcript_workspace_data,
            get_all_project_documents,
            start_audio_recording,
            stop_audio_recording,
            read_audio_file,
            transcribe_audio,
            transcribe_audio_with_segments,
            import_audio_file,
            import_audio_file_enriched,
            extract_document_text,
            ingest_url_command,
            clean_up_document_with_llm,
            polish_transcript_with_llm,
            auto_polish_diarized_transcript,
            summarize_as_meeting_notes,
            generate_slides_from_document,
            generate_podcast_from_document,
            list_elevenlabs_voices,
            check_whisper_model,
            download_whisper_model,
            init_whisper_model,
            check_diarization_model,
            download_diarization_model,
            init_diarization_model,
            get_transcript,
            meeting_popup_dismiss,
            meeting_popup_start_recording,
        ])
        .manage(AppState {
            db: Default::default(),
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                event.window().hide().unwrap(); // Hide window on close
            }
            _ => {}
        })
        .setup(move |app| {
            let args: Vec<String> = env::args().collect();
            let should_start_minimized = args.contains(&"--minimized".to_string());

            let window = app.get_window("main").unwrap();

            if should_start_minimized {
                window.hide().unwrap();
            } else {
                window.show().unwrap();
            }

            let app_handle = app.handle();
            let _ = setup_directories::setup_dirs(
                app_handle
                    .path_resolver()
                    .app_data_dir()
                    .unwrap()
                    .to_str()
                    .unwrap(),
            );
            prerequisites::check_and_install_prerequisites(
                app_handle
                    .path_resolver()
                    .resource_dir()
                    .unwrap()
                    .to_str()
                    .unwrap(),
            );
            clean_up(app_handle.path_resolver().app_data_dir().unwrap());
            setup_keypress_listener(&app_handle);

            // Load meeting detection setting from DB and start the detector thread
            let detection_enabled = app_handle.db(|db| {
                get_setting(db, "meeting_detection_enabled")
                    .map(|s| s.setting_value == "true")
                    .unwrap_or(false)
            });
            engine::meeting_detector::MEETING_DETECTION_ENABLED
                .store(detection_enabled, std::sync::atomic::Ordering::Relaxed);
            engine::meeting_detector::start_meeting_detection(app_handle.clone());

            init_app_permissions(app_handle);
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
    drop_database_handle().await;
}

fn build_system_tray() -> SystemTray {
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let tray_menu = SystemTrayMenu::new()
        .add_item(quit);
    SystemTray::new().with_menu(tray_menu)
}

#[tauri::command]
fn get_app_version() -> String {
    // Version populated at build time from tauri.conf.json
    env!("CARGO_PKG_VERSION").to_string()
}

fn setup_keypress_listener(app_handle: &AppHandle) {
    let app_state: State<AppState> = app_handle.state();

    let db: Connection =
        database::initialize_database(&app_handle).expect("Database initialization failed!");
    *app_state.db.lock().unwrap() = Some(db);
}

#[tauri::command]
fn get_latest_settings(app_handle: AppHandle) -> Result<Vec<Setting>, ()> {
    let settings = app_handle.db(|db| get_settings(db).unwrap());
    return Ok(settings);
}

#[tauri::command]
async fn update_settings(app_handle: AppHandle, settings: Settings) {
    info!("update_settings: {:?}", settings);
    app_handle.db(|db| {
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("interval"),
                setting_value: format!("{}", settings.interval),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("is_dev_mode"),
                setting_value: format!("{}", settings.is_dev_mode),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("auto_start"),
                setting_value: format!("{}", settings.auto_start),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("api_choice"),
                setting_value: format!("{}", settings.api_choice),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("api_key_claude"),
                setting_value: format!("{}", settings.api_key_claude),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("api_key_open_ai"),
                setting_value: format!("{}", settings.api_key_open_ai),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("api_key_gemini"),
                setting_value: format!("{}", settings.api_key_gemini),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("openai_api_base"),
                setting_value: format!("{}", settings.openai_api_base),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("local_model_url"),
                setting_value: format!("{}", settings.local_model_url),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("vectorization_enabled"),
                setting_value: format!("{}", settings.vectorization_enabled),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("rag_top_k"),
                setting_value: format!("{}", settings.rag_top_k),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("meeting_detection_enabled"),
                setting_value: format!("{}", settings.meeting_detection_enabled),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("model_claude"),
                setting_value: settings.model_claude.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("model_openai"),
                setting_value: settings.model_openai.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("model_gemini"),
                setting_value: settings.model_gemini.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("use_local_transcription"),
                setting_value: format!("{}", settings.use_local_transcription),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("whisper_model"),
                setting_value: settings.whisper_model.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("use_diarization"),
                setting_value: format!("{}", settings.use_diarization),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("max_speakers"),
                setting_value: format!("{}", settings.max_speakers),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("diarization_mode"),
                setting_value: settings.diarization_mode.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("polish_language_mode"),
                setting_value: settings.polish_language_mode.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("polish_target_language"),
                setting_value: settings.polish_target_language.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("api_key_elevenlabs"),
                setting_value: settings.api_key_elevenlabs.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("embed_api_base"),
                setting_value: settings.embed_api_base.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("embed_model"),
                setting_value: settings.embed_model.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("transcription_model"),
                setting_value: settings.transcription_model.clone(),
            },
        )
        .unwrap();
        // Customizable system prompts
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("prompt_cleanup_system"),
                setting_value: settings.prompt_cleanup_system.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("prompt_note_title_system"),
                setting_value: settings.prompt_note_title_system.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("prompt_transcript_cleanup"),
                setting_value: settings.prompt_transcript_cleanup.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("prompt_meeting_summary_system"),
                setting_value: settings.prompt_meeting_summary_system.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("prompt_slides_system"),
                setting_value: settings.prompt_slides_system.clone(),
            },
        )
        .unwrap();
        insert_or_update_setting(
            db,
            Setting {
                setting_key: String::from("prompt_podcast_script_system"),
                setting_value: settings.prompt_podcast_script_system.clone(),
            },
        )
        .unwrap();
    });

    // Update the runtime flag so the detection loop picks up the change immediately
    engine::meeting_detector::MEETING_DETECTION_ENABLED
        .store(settings.meeting_detection_enabled, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn init_app_permissions(app_handle: AppHandle) {
    init_permissions(app_handle);
}

#[tauri::command]
fn update_app_permissions(app_handle: AppHandle, app_path: String, allow: bool) {
    app_handle.db(|database| {
        update_permission(database, app_path, allow).expect("Failed to update permission");
    })
}

#[tauri::command]
fn get_app_permissions(app_handle: AppHandle) -> Result<Vec<Permission>, ()> {
    let permissions = app_handle.db(|database| get_permissions(database).unwrap());
    return Ok(permissions);
}

#[tauri::command]
fn get_projects(app_handle: AppHandle) -> Result<Vec<Project>, ()> {
    let projects = app_handle.db(|database| fetch_all_projects(database).unwrap());
    return Ok(projects);
}

#[tauri::command]
fn save_app_project(
    app_handle: AppHandle,
    name: &str,
    activities: Vec<i64>,
) -> Result<Vec<i64>, ()> {
    app_handle.db(|database| save_project(database, name, &activities).unwrap());
    return Ok(activities);
}

#[tauri::command]
fn update_app_project(
    app_handle: AppHandle,
    id: i64,
    name: &str,
    activities: Vec<i64>,
) -> Result<Vec<i64>, ()> {
    app_handle.db(|database| update_project(database, id, name, &activities).unwrap());
    return Ok(activities);
}

#[tauri::command]
fn delete_app_project(app_handle: AppHandle, project_id: i64) -> Result<i64, ()> {
    app_handle.db(|database| delete_project(database, project_id).unwrap());
    return Ok(project_id);
}

#[tauri::command]
fn create_chat(app_handle: AppHandle, name: &str) -> Result<i64, String> {
    app_handle
        .db(|db| chat_db_repository::create_chat(db, name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_all_chats(app_handle: AppHandle) -> Result<Vec<Chat>, String> {
    app_handle
        .db(|db| chat_db_repository::get_all_chats(db))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_message(
    app_handle: AppHandle,
    chat_id: i64,
    role: &str,
    content: &str,
    sources: Option<String>,
) -> Result<i64, String> {
    app_handle
        .db(|db| chat_db_repository::create_message(db, chat_id, role, content, sources.as_deref()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_messages_by_chat_id(
    app_handle: AppHandle,
    chat_id: i64,
) -> Result<Vec<StoredMessage>, String> {
    app_handle
        .db(|db| chat_db_repository::get_messages_by_chat_id(db, chat_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_chat_name(app_handle: AppHandle, chat_id: i64, name: &str) -> Result<bool, String> {
    app_handle
        .db(|db| chat_db_repository::update_chat(db, chat_id, name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat(app_handle: AppHandle, chat_id: i64) -> Result<bool, String> {
    app_handle
        .db(|db| chat_db_repository::delete_chat(db, chat_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_chunk_text(app_handle: AppHandle, chunk_id: i64) -> Result<Option<String>, String> {
    app_handle
        .db(|db| get_chunk_full_text(db, chunk_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_project_activity_text(
    app_handle: AppHandle,
    project_id: i64,
    activity_id: i64,
) -> Result<String, ()> {
    // Properly propagate errors instead of unwrapping
    let text = app_handle.db(|database| {
        match get_activity_text_from_project(database, project_id, activity_id) {
            Ok(text) => Ok(text),
            Err(_) => Err(())  // Or provide more specific error information
        }
    })?;  // Propagate error with ? operator
    
    Ok(text)
}

#[tauri::command]
fn get_app_project_activity_plain_text(
    app_handle: AppHandle,
    activity_id: i64,
) -> Result<(String, String), String> {
    app_handle
        .db(|database| get_activity_plain_text(database, activity_id))
        .map_err(|e| e.to_string())
}

/// Get all documents across all projects for the "Add content to Platypus" modal
#[tauri::command]
fn get_all_project_documents(
    app_handle: AppHandle,
) -> Result<Vec<(i64, String, String, String)>, String> {
    app_handle
        .db(|database| get_all_documents(database))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_project_activity_content(
    app_handle: AppHandle,
    document_id: i64,
    target_project_id: i64,
) -> Result<(), String> {
    app_handle
        .db(|database| {
            move_document_to_project(database, document_id, target_project_id)
                .map_err(|e| e.to_string())
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_project_activity_text(
    app_handle: AppHandle,
    activity_id: i64,
    text: &str,
) -> Result<(), String> {
    // Update the document text (this also generates plain_text)
    app_handle
        .db(|db| update_activity_text(db, activity_id, text))
        .map_err(|e| e.to_string())?;
    
    // Only chunk if vectorization is enabled
    let vectorization_enabled = app_handle
        .db(|db| get_setting(db, "vectorization_enabled"))
        .map(|s| s.setting_value == "true")
        .unwrap_or(false);

    if vectorization_enabled {
        let (project_id, plain_text) = app_handle
            .db(|db| {
                let project_id = get_project_id_for_document(db, activity_id)?;
                let (_, plain_text) = get_activity_plain_text(db, activity_id)?;
                Ok::<(i64, String), rusqlite::Error>((project_id, plain_text))
            })
            .map_err(|e| e.to_string())?;

        app_handle
            .db(|db| save_chunks_for_document(db, activity_id, project_id, &plain_text))
            .map_err(|e| e.to_string())?;

        info!("Document {} updated and chunked", activity_id);
    } else {
        info!("Document {} updated (vectorization disabled, skipping chunking)", activity_id);
    }
    Ok(())
}

#[tauri::command]
fn update_project_activity_diarization(
    app_handle: AppHandle,
    activity_id: i64,
    diarization_json: &str,
) -> Result<(), String> {
    app_handle
        .db(|db| update_activity_diarization_json(db, activity_id, diarization_json))
        .map_err(|e| e.to_string())
}

fn default_transcript_workspace_metadata(app_handle: &AppHandle) -> TranscriptWorkspaceMetadata {
    TranscriptWorkspaceMetadata {
        diarization_model: "local:text-clustering-v1".to_string(),
        synthesis_model: active_synthesis_model_label(app_handle),
        source_language: "original".to_string(),
        target_language: get_polish_target_language(app_handle),
        polish_language_mode: get_polish_language_mode(app_handle),
    }
}

fn active_synthesis_model_label(app_handle: &AppHandle) -> String {
    let (provider, model_id) = get_active_provider_and_model(app_handle);
    let model = model_id.unwrap_or_else(|| "default".to_string());
    format!("{}:{}", provider, model)
}

fn normalize_raw_segments(raw_segments_json: &str) -> Result<Vec<TranscriptRawSegment>, String> {
    let trimmed = raw_segments_json.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    if let Ok(segments) = serde_json::from_str::<Vec<TranscriptRawSegment>>(trimmed) {
        return Ok(segments);
    }

    if let Ok(legacy_segments) = serde_json::from_str::<Vec<DiarizedSegment>>(trimmed) {
        let mapped = legacy_segments
            .into_iter()
            .map(|s| TranscriptRawSegment {
                speaker_id: s.speaker_id,
                start_ms: s.start_ms,
                end_ms: s.end_ms,
                text: s.text.clone(),
                original_text: Some(s.text),
                language: s.language,
            })
            .collect::<Vec<_>>();
        return Ok(mapped);
    }

    Err("Invalid raw transcript segments JSON".to_string())
}

fn transcript_segments_to_diarized(segments: &[TranscriptRawSegment]) -> Vec<DiarizedSegment> {
    segments
        .iter()
        .map(|s| DiarizedSegment {
            speaker_id: s.speaker_id,
            text: s.text.clone(),
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            language: s.language.clone(),
        })
        .collect()
}

fn parse_workspace_metadata(
    metadata_json: &str,
    fallback: TranscriptWorkspaceMetadata,
) -> TranscriptWorkspaceMetadata {
    if metadata_json.trim().is_empty() {
        return fallback;
    }

    serde_json::from_str::<TranscriptWorkspaceMetadata>(metadata_json).unwrap_or(fallback)
}

#[tauri::command]
fn update_project_activity_transcript_workspace_data(
    app_handle: AppHandle,
    activity_id: i64,
    raw_segments_json: String,
    polished_text: Option<String>,
    diarization_model: Option<String>,
    synthesis_model: Option<String>,
    source_language: Option<String>,
    target_language: Option<String>,
    polish_language_mode: Option<String>,
) -> Result<(), String> {
    let segments = normalize_raw_segments(&raw_segments_json)?;
    if segments.is_empty() {
        return Err("No raw transcript segments to store".to_string());
    }

    let mut metadata = default_transcript_workspace_metadata(&app_handle);
    if let Some(v) = diarization_model.filter(|v| !v.trim().is_empty()) {
        metadata.diarization_model = v;
    }
    if let Some(v) = synthesis_model.filter(|v| !v.trim().is_empty()) {
        metadata.synthesis_model = v;
    }
    if let Some(v) = source_language.filter(|v| !v.trim().is_empty()) {
        metadata.source_language = v;
    }
    if let Some(v) = target_language.filter(|v| !v.trim().is_empty()) {
        metadata.target_language = v;
    }
    if let Some(v) = polish_language_mode.filter(|v| !v.trim().is_empty()) {
        metadata.polish_language_mode = v;
    }

    let polished_value = polished_text.unwrap_or_default();
    let metadata_json = serde_json::to_string(&metadata)
        .map_err(|e| format!("Failed to serialize transcript metadata: {}", e))?;
    let normalized_raw_json = serde_json::to_string(&segments)
        .map_err(|e| format!("Failed to serialize transcript raw segments: {}", e))?;

    app_handle
        .db(|db| {
            update_activity_transcript_workspace(
                db,
                activity_id,
                &normalized_raw_json,
                &polished_value,
                &metadata_json,
            )
        })
        .map_err(|e| e.to_string())?;

    let legacy_segments = transcript_segments_to_diarized(&segments);
    let legacy_json = serde_json::to_string(&legacy_segments)
        .map_err(|e| format!("Failed to serialize legacy diarization payload: {}", e))?;
    app_handle
        .db(|db| update_activity_diarization_json(db, activity_id, &legacy_json))
        .map_err(|e| e.to_string())?;

    let rendered_html = if polished_value.trim().is_empty() {
        compose_raw_only_html_with_segments(&legacy_segments)
    } else {
        compose_polished_and_raw_html_with_segments(&polished_value, &legacy_segments)
    };
    update_project_activity_text(app_handle, activity_id, &rendered_html)?;

    Ok(())
}

#[tauri::command]
fn get_project_activity_transcript_workspace(
    app_handle: AppHandle,
    activity_id: i64,
) -> Result<TranscriptWorkspaceResponse, String> {
    let (raw_json, polished_text, metadata_json, legacy_diarization_json, _) = app_handle
        .db(|db| get_activity_transcript_workspace(db, activity_id))
        .map_err(|e| e.to_string())?;

    let mut segments = normalize_raw_segments(&raw_json)?;
    if segments.is_empty() && !legacy_diarization_json.trim().is_empty() {
        segments = normalize_raw_segments(&legacy_diarization_json)?;
    }

    if segments.is_empty() {
        return Ok(TranscriptWorkspaceResponse {
            has_workspace: false,
            raw_segments: Vec::new(),
            polished_text: String::new(),
            diarization_model: String::new(),
            synthesis_model: String::new(),
            source_language: String::new(),
            target_language: String::new(),
            polish_language_mode: String::new(),
        });
    }

    let metadata = parse_workspace_metadata(
        &metadata_json,
        default_transcript_workspace_metadata(&app_handle),
    );

    Ok(TranscriptWorkspaceResponse {
        has_workspace: true,
        raw_segments: segments,
        polished_text,
        diarization_model: metadata.diarization_model,
        synthesis_model: metadata.synthesis_model,
        source_language: metadata.source_language,
        target_language: metadata.target_language,
        polish_language_mode: metadata.polish_language_mode,
    })
}

#[tauri::command]
async fn regenerate_project_activity_polished_transcript(
    app_handle: AppHandle,
    activity_id: i64,
) -> Result<String, String> {
    let workspace = get_project_activity_transcript_workspace(app_handle.clone(), activity_id)?;
    if !workspace.has_workspace || workspace.raw_segments.is_empty() {
        return Err("Raw transcript workspace is not available for this note".to_string());
    }

    let raw_text = workspace
        .raw_segments
        .iter()
        .map(|s| format!("Speaker {}: {}", s.speaker_id, s.text.trim()))
        .collect::<Vec<_>>()
        .join("\n");

    let polished = auto_polish_diarized_transcript(app_handle.clone(), raw_text).await?;
    update_project_activity_transcript_workspace_data(
        app_handle.clone(),
        activity_id,
        serde_json::to_string(&workspace.raw_segments)
            .map_err(|e| format!("Failed to serialize raw segments for regeneration: {}", e))?,
        Some(polished.clone()),
        Some(workspace.diarization_model),
        Some(active_synthesis_model_label(&app_handle)),
        Some(workspace.source_language),
        Some(get_polish_target_language(&app_handle)),
        Some(get_polish_language_mode(&app_handle)),
    )?;

    Ok(polished)
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn text_to_html_with_breaks(input: &str) -> String {
    escape_html(input).replace('\n', "<br/>")
}

fn compose_polished_and_raw_html(polished_text: &str, raw_text: &str) -> String {
    format!(
        "<h2>Polished transcript</h2><p>{}</p><hr/><h3>Raw transcript</h3><pre style=\"white-space: pre-wrap;\">{}</pre>",
        text_to_html_with_breaks(polished_text),
        escape_html(raw_text)
    )
}

fn compose_raw_only_html(raw_text: &str) -> String {
    format!(
        "<h3>Raw transcript</h3><pre style=\"white-space: pre-wrap;\">{}</pre>",
        escape_html(raw_text)
    )
}

fn speaker_color_hex(speaker_id: u32) -> &'static str {
    const COLORS: [&str; 6] = ["#0D9488", "#7C3AED", "#EA580C", "#2563EB", "#DB2777", "#16A34A"];
    COLORS[((speaker_id.saturating_sub(1)) as usize) % COLORS.len()]
}

fn compose_raw_only_html_with_segments(segments: &[DiarizedSegment]) -> String {
    let mut html = String::from("<h3>Raw transcript</h3>");
    for seg in segments {
        let color = speaker_color_hex(seg.speaker_id);
        let timing = match (seg.start_ms, seg.end_ms) {
            (Some(s), Some(e)) => format!("<span style=\"color:#6B7280; font-size:12px;\">[{} - {}]</span> ", s / 1000, e / 1000),
            (Some(s), None) => format!("<span style=\"color:#6B7280; font-size:12px;\">[{}]</span> ", s / 1000),
            _ => String::new(),
        };
        html.push_str(&format!(
            "<p>{}<strong style=\"color:{};\">Speaker {}:</strong> {}</p>",
            timing,
            color,
            seg.speaker_id,
            text_to_html_with_breaks(seg.text.trim())
        ));
    }
    html
}

fn compose_polished_and_raw_html_with_segments(polished_text: &str, segments: &[DiarizedSegment]) -> String {
    let mut html = format!(
        "<h2>Polished transcript</h2><p>{}</p><hr/><h3>Raw transcript</h3>",
        text_to_html_with_breaks(polished_text)
    );

    for seg in segments {
        let color = speaker_color_hex(seg.speaker_id);
        let timing = match (seg.start_ms, seg.end_ms) {
            (Some(s), Some(e)) => format!("<span style=\"color:#6B7280; font-size:12px;\">[{} - {}]</span> ", s / 1000, e / 1000),
            (Some(s), None) => format!("<span style=\"color:#6B7280; font-size:12px;\">[{}]</span> ", s / 1000),
            _ => String::new(),
        };
        html.push_str(&format!(
            "<p>{}<strong style=\"color:{};\">Speaker {}:</strong> {}</p>",
            timing,
            color,
            seg.speaker_id,
            text_to_html_with_breaks(seg.text.trim())
        ));
    }

    html
}

fn fallback_short_title_from_text(text: &str) -> String {
    let cleaned = text
        .replace('\n', " ")
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.trim().is_empty() {
        "Imported audio note".to_string()
    } else {
        cleaned
    }
}

fn sanitize_short_title(title: &str) -> String {
    let mut cleaned = title
        .replace('\n', " ")
        .replace('"', "")
        .replace('\'', "")
        .trim()
        .to_string();

    if cleaned.contains(':') {
        cleaned = cleaned.split(':').next().unwrap_or(&cleaned).trim().to_string();
    }

    if cleaned.len() > 60 {
        cleaned = cleaned.chars().take(60).collect::<String>().trim().to_string();
    }

    if cleaned.is_empty() {
        "Imported audio note".to_string()
    } else {
        cleaned
    }
}

fn emit_audio_import_progress(
    app_handle: &AppHandle,
    file_path: &str,
    stage: &str,
    progress: f32,
    detail: &str,
) {
    if let Some(window) = app_handle.get_window("main") {
        let _ = window.emit(
            "audio-import-progress",
            serde_json::json!({
                "file_path": file_path,
                "stage": stage,
                "progress": progress,
                "detail": detail,
            }),
        );
    }
}

async fn generate_smart_note_title(app_handle: &AppHandle, source_text: &str) -> String {
    let (provider, model_id) = get_active_provider_and_model(app_handle);
    let short = match generate_note_title_with_llm(
        app_handle.clone(),
        source_text.to_string(),
        provider,
        model_id,
    )
    .await
    {
        Ok(title) => sanitize_short_title(&title),
        Err(err) => {
            log::warn!("Short title generation failed, using fallback: {}", err);
            fallback_short_title_from_text(source_text)
        }
    };

    let timestamp = Local::now().format("%Y-%m-%d %H:%M").to_string();
    format!("{} - {}", timestamp, short)
}

fn get_polish_language_mode(app_handle: &AppHandle) -> String {
    app_handle
        .db(|db| get_setting(db, "polish_language_mode"))
        .map(|s| {
            if s.setting_value.trim().is_empty() {
                "keep_original".to_string()
            } else {
                s.setting_value
            }
        })
        .unwrap_or_else(|_| "keep_original".to_string())
}

fn get_polish_target_language(app_handle: &AppHandle) -> String {
    app_handle
        .db(|db| get_setting(db, "polish_target_language"))
        .map(|s| {
            if s.setting_value.trim().is_empty() {
                "Italian".to_string()
            } else {
                s.setting_value
            }
        })
        .unwrap_or_else(|_| "Italian".to_string())
}

fn get_active_provider_and_model(app_handle: &AppHandle) -> (String, Option<String>) {
    let provider = app_handle
        .db(|db| get_setting(db, "api_choice"))
        .map(|s| {
            if s.setting_value.trim().is_empty() {
                "claude".to_string()
            } else {
                s.setting_value
            }
        })
        .unwrap_or_else(|_| "claude".to_string());

    let model_key = match provider.as_str() {
        "openai" => "model_openai",
        "gemini" => "model_gemini",
        "local" => "",
        _ => "model_claude",
    };

    let model = if model_key.is_empty() {
        None
    } else {
        app_handle
            .db(|db| get_setting(db, model_key))
            .map(|s| {
                let trimmed = s.setting_value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            })
            .unwrap_or(None)
    };

    (provider, model)
}

#[tauri::command]
async fn auto_polish_diarized_transcript(
    app_handle: AppHandle,
    raw_text: String,
) -> Result<String, String> {
    if raw_text.trim().is_empty() {
        return Err("Transcript is empty".to_string());
    }

    let (provider, model_id) = get_active_provider_and_model(&app_handle);
    let language_mode = get_polish_language_mode(&app_handle);
    let target_language = get_polish_target_language(&app_handle);

    polish_transcript_with_llm(
        app_handle,
        raw_text,
        provider,
        model_id,
        Some(language_mode),
        Some(target_language),
    )
    .await
}

#[tauri::command]
async fn rediarize_existing_recording(
    app_handle: AppHandle,
    activity_id: i64,
) -> Result<Vec<DiarizedSegment>, String> {
    let max_speakers = get_max_speakers(&app_handle);
    let (_, source_text) = app_handle
        .db(|db| get_activity_plain_text(db, activity_id))
        .map_err(|e| e.to_string())?;

    if source_text.trim().is_empty() {
        return Err("Document has no text to diarize".to_string());
    }

    let segments = rediarize_existing_text(&source_text, max_speakers);
    if segments.is_empty() {
        return Err("Unable to extract diarization segments from existing text".to_string());
    }

    let diarization_json = serde_json::to_string(&segments)
        .map_err(|e| format!("Failed to serialize diarization: {}", e))?;
    app_handle
        .db(|db| update_activity_diarization_json(db, activity_id, &diarization_json))
        .map_err(|e| e.to_string())?;

    let rendered = format_segments_as_plain_text(&segments);
    let polished_text = match auto_polish_diarized_transcript(app_handle.clone(), rendered.clone()).await {
        Ok(polished) => Some(polished),
        Err(err) => {
            log::warn!("Auto-polish after re-diarization failed: {}", err);
            None
        }
    };

    update_project_activity_transcript_workspace_data(
        app_handle,
        activity_id,
        diarization_json,
        polished_text,
        Some("local:text-clustering-v1".to_string()),
        None,
        Some("original".to_string()),
        None,
        None,
    )?;

    Ok(segments)
}

/// Vectorize all unvectorized chunks for a document
/// Called after document is saved when vectorization is enabled
/// Uses per-project vector indices for proper scoping
#[tauri::command]
async fn vectorize_document_chunks(
    app_handle: AppHandle,
    document_id: i64,
) -> Result<i32, String> {
    use crate::repository::chunk_repository::mark_chunk_as_vectorized;
    use crate::engine::project_vector_engine::{add_chunk_to_project_vectors, sync_project_vectors};
    use log::{info, error};
    
    // Check if vectorization is enabled
    let vectorization_enabled = app_handle
        .db(|db| get_setting(db, "vectorization_enabled"))
        .map(|s| s.setting_value == "true")
        .unwrap_or(false);
    
    if !vectorization_enabled {
        info!("Vectorization disabled, skipping for document {}", document_id);
        return Ok(0);
    }
    
    // Get OpenAI API key
    let api_key = app_handle
        .db(|db| get_setting(db, "api_key_open_ai"))
        .map(|s| s.setting_value)
        .unwrap_or_default();

    // Get embedding endpoint settings (allow local server override)
    let embed_api_base = app_handle
        .db(|db| get_setting(db, "embed_api_base"))
        .map(|s| s.setting_value)
        .unwrap_or_default();
    let embed_model = app_handle
        .db(|db| get_setting(db, "embed_model"))
        .map(|s| s.setting_value)
        .unwrap_or_default();
    let embed_api_base_opt: Option<&str> = if embed_api_base.is_empty() { None } else { Some(&embed_api_base) };
    let embed_model_opt: Option<&str> = if embed_model.is_empty() { None } else { Some(&embed_model) };

    if api_key.is_empty() && embed_api_base_opt.is_none() {
        info!("No OpenAI API key, skipping vectorization for document {}", document_id);
        return Ok(0);
    }
    
    // Get project_id for the document
    let project_id = app_handle
        .db(|db| get_project_id_for_document(db, document_id))
        .map_err(|e| e.to_string())?;
    
    // Get unvectorized chunks for this document
    let chunks = app_handle
        .db(|db| {
            let mut stmt = db.prepare(
                "SELECT id, document_id, project_id, chunk_index, chunk_text, is_vectorized
                 FROM document_chunks 
                 WHERE document_id = ?1 AND is_vectorized = 0"
            )?;
            
            let chunks: Vec<crate::repository::chunk_repository::DocumentChunk> = stmt.query_map(
                rusqlite::params![document_id],
                |row| {
                    Ok(crate::repository::chunk_repository::DocumentChunk {
                        id: row.get(0)?,
                        document_id: row.get(1)?,
                        project_id: row.get(2)?,
                        chunk_index: row.get(3)?,
                        chunk_text: row.get(4)?,
                        is_vectorized: row.get::<_, i32>(5)? == 1,
                    })
                }
            )?.collect::<Result<Vec<_>, _>>()?;
            
            Ok::<Vec<crate::repository::chunk_repository::DocumentChunk>, rusqlite::Error>(chunks)
        })
        .map_err(|e| e.to_string())?;
    
    if chunks.is_empty() {
        info!("No chunks to vectorize for document {}", document_id);
        return Ok(0);
    }
    
    info!("Vectorizing {} chunks for document {} in project {}", chunks.len(), document_id, project_id);
    
    let mut vectorized_count = 0;
    
    for chunk in chunks {
        // Add to project-specific vector index
        if let Err(e) = add_chunk_to_project_vectors(
            &app_handle,
            project_id,
            chunk.id,
            &chunk.chunk_text,
            &api_key,
            embed_api_base_opt,
            embed_model_opt,
        ).await {
            error!("Failed to vectorize chunk {}: {}", chunk.id, e);
            continue;
        }
        
        // Mark as vectorized in DB
        if let Err(e) = app_handle.db(|db| mark_chunk_as_vectorized(db, chunk.id)) {
            error!("Failed to mark chunk {} as vectorized: {}", chunk.id, e);
            continue;
        }
        
        vectorized_count += 1;
    }
    
    // Sync project's vector index to disk
    if let Err(e) = sync_project_vectors(&app_handle, project_id).await {
        error!("Failed to sync project {} vector index: {}", project_id, e);
    }
    
    info!("Vectorized {} chunks for document {} in project {}", vectorized_count, document_id, project_id);
    Ok(vectorized_count)
}

#[tauri::command]
fn add_project_blank_activity(
    app_handle: AppHandle,
    project_id: i64,
) -> Result<i64, String> {
    app_handle
        .db(|db| add_blank_document(db, project_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ensure_unassigned_activity(app_handle: AppHandle) -> Result<i64, String> {
  app_handle
    .db(|db| {
      // First ensure unassigned project exists
      let unassigned_project_id = ensure_unassigned_project(db)?;
      // Then add blank document to it
      add_blank_document(db, unassigned_project_id)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_project_activity_name(
    app_handle: AppHandle,
    activity_id: i64,
    name: &str,
) -> Result<(), String> {
    app_handle
        .db(|db| update_activity_name(db, activity_id, name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project_activity(
    app_handle: AppHandle,
    activity_id: i64,
) -> Result<(), String> {
    app_handle
        .db(|db| delete_project_document(db, activity_id))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn prompt_for_accessibility_permissions() {
    // No-op - accessibility permissions no longer needed
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn prompt_for_accessibility_permissions() {
    // No-op for non-macOS platforms
}

// Audio recording commands — dual mode (file-based for OpenAI, buffer for local Whisper)
#[tauri::command]
async fn start_audio_recording(app_handle: AppHandle, use_local: bool) -> Result<String, String> {
    if use_local {
        crate::engine::audio_engine::start_recording_local().await?;
        let use_diarization = get_use_diarization(&app_handle);
        let max_speakers = get_max_speakers(&app_handle);

        // Clear accumulated transcript
        {
            let mut t = ACCUMULATED_TRANSCRIPT.lock().unwrap();
            t.clear();
        }
        {
            let mut segs = DIARIZED_SEGMENTS.lock().unwrap();
            segs.clear();
        }
        {
            let mut cursor = TRANSCRIPT_CURSOR_MS.lock().unwrap();
            *cursor = 0;
        }
        {
            let mut diarizer = STREAMING_DIARIZER.lock().unwrap();
            *diarizer = StreamingDiarizer::new(0.75, max_speakers);
            diarizer.reset();
        }

        // Spawn the realtime transcription loop
        let handle = app_handle.clone();
        tokio::spawn(async move {
            realtime_transcription_loop(handle, use_diarization).await;
        });
        Ok("local".to_string())
    } else {
        crate::engine::audio_engine::start_recording().await
    }
}

#[tauri::command]
async fn stop_audio_recording(app_handle: AppHandle, use_local: bool) -> Result<String, String> {
    if use_local {
        let use_diarization = get_use_diarization(&app_handle);
        let max_speakers = get_max_speakers(&app_handle);

        crate::engine::audio_engine::stop_recording_local().await?;
        // Give the realtime loop a moment to finish
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // Process any remaining samples
        let remaining = crate::engine::audio_engine::drain_all_samples();
        if !remaining.is_empty() {
            let device_rate = crate::engine::audio_engine::DEVICE_SAMPLE_RATE
                .load(std::sync::atomic::Ordering::SeqCst);
            let chunk_ms = if device_rate > 0 {
                ((remaining.len() as u64) * 1000) / (device_rate as u64)
            } else {
                0
            };
            if let Some((text, speaker_id)) =
                process_and_transcribe_chunk(&remaining, use_diarization)
            {
                let mut t = ACCUMULATED_TRANSCRIPT.lock().unwrap();
                if !t.is_empty() {
                    t.push(' ');
                }
                t.push_str(&text);

                if let Some(sid) = speaker_id {
                    let mut cursor = TRANSCRIPT_CURSOR_MS.lock().unwrap();
                    let start_ms = *cursor;
                    let end_ms = start_ms.saturating_add(chunk_ms);
                    *cursor = end_ms;
                    DIARIZED_SEGMENTS
                        .lock()
                        .unwrap()
                        .push(DiarizedSegment {
                            speaker_id: sid,
                            text,
                            start_ms: Some(start_ms),
                            end_ms: Some(end_ms),
                            language: None,
                        });
                }
            }
        }
        // Emit final transcript
        let final_text = {
            let t = ACCUMULATED_TRANSCRIPT.lock().unwrap();
            t.clone()
        };

        let final_segments = if use_diarization {
            let mut segs = DIARIZED_SEGMENTS.lock().unwrap().clone();
            batch_recluster(&mut segs, max_speakers);
            merge_adjacent_segments(&segs)
        } else {
            Vec::new()
        };

        if let Some(w) = app_handle.get_window("main") {
            let _ = w.emit("transcript-update", serde_json::json!({
                "text": final_text,
                "segments": final_segments,
                "is_final": true
            }));
        }
        Ok(final_text)
    } else {
        crate::engine::audio_engine::stop_recording().await
    }
}

#[tauri::command]
fn read_audio_file(file_path: String) -> Result<Vec<u8>, String> {
    crate::engine::audio_engine::read_audio_file(&file_path)
}

#[tauri::command]
async fn transcribe_audio(
    app_handle: AppHandle,
    file_path: String,
) -> Result<String, String> {
    log::info!("Transcribing audio file: {}", file_path);

    let transcription = transcribe_audio_with_preferred_provider(&app_handle, &file_path)
        .await
        .map_err(|e| format!("Transcription failed: {}", e))?;

    // Clean up the audio file after transcription
    if let Err(err) = std::fs::remove_file(&file_path) {
        log::warn!("Failed to delete audio file {}: {}", file_path, err);
    } else {
        log::info!("Successfully deleted audio file: {}", file_path);
    }

    Ok(transcription)
}

#[derive(serde::Serialize)]
struct TranscriptionResult {
    text: String,
    segments: Vec<TranscriptRawSegment>,
}

#[tauri::command]
async fn transcribe_audio_with_segments(
    app_handle: AppHandle,
    file_path: String,
) -> Result<TranscriptionResult, String> {
    log::info!("Transcribing audio file with segments: {}", file_path);

    let (text, segments) = transcribe_audio_with_preferred_provider_inner(&app_handle, &file_path)
        .await
        .map_err(|e| format!("Transcription failed: {}", e))?;

    // Clean up the audio file after transcription
    if let Err(err) = std::fs::remove_file(&file_path) {
        log::warn!("Failed to delete audio file {}: {}", file_path, err);
    } else {
        log::info!("Successfully deleted audio file: {}", file_path);
    }

    Ok(TranscriptionResult { text, segments })
}

#[tauri::command]
async fn import_audio_file(
    app_handle: AppHandle,
    file_path: String,
) -> Result<String, String> {
    log::info!("Importing and transcribing audio file: {}", file_path);

    if !std::path::Path::new(&file_path).exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if !matches!(ext.as_str(), "ogg" | "wav" | "mp3") {
        return Err(format!(
            "Unsupported audio format: {}. Supported formats: ogg, wav, mp3",
            ext
        ));
    }

    transcribe_audio_with_preferred_provider(&app_handle, &file_path)
        .await
        .map_err(|e| format!("Audio import transcription failed: {}", e))
}

#[tauri::command]
async fn import_audio_file_enriched(
    app_handle: AppHandle,
    file_path: String,
) -> Result<AudioImportProcessedResult, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    log::info!("Importing and post-processing audio file: {}", file_path);
    emit_audio_import_progress(&app_handle, &file_path, "validating", 0.05, "Validating input file");

    if !std::path::Path::new(&file_path).exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if !matches!(ext.as_str(), "ogg" | "wav" | "mp3") {
        return Err(format!(
            "Unsupported audio format: {}. Supported formats: ogg, wav, mp3",
            ext
        ));
    }

    // Emit initial transcribing progress
    emit_audio_import_progress(&app_handle, &file_path, "transcribing", 0.1, "Transcribing audio");

    // Spawn heartbeat task to show progress while transcribing
    let transcription_done = Arc::new(AtomicBool::new(false));
    let heartbeat_done = transcription_done.clone();
    let app_handle_hb = app_handle.clone();
    let file_path_hb = file_path.clone();
    
    let heartbeat_task = tokio::spawn(async move {
        let mut progress: f32 = 0.1;
        while !heartbeat_done.load(Ordering::Relaxed) {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            if heartbeat_done.load(Ordering::Relaxed) {
                break;
            }
            // Gradually increase progress from 0.1 to 0.33 while transcribing
            progress = (progress + 0.02).min(0.33);
            emit_audio_import_progress(&app_handle_hb, &file_path_hb, "transcribing", progress, "Transcribing audio");
        }
    });

    let (transcription, segments) = transcribe_audio_with_preferred_provider_inner(&app_handle, &file_path)
        .await
        .map_err(|e| {
            transcription_done.store(true, Ordering::Relaxed);
            format!("Audio import transcription failed: {}", e)
        })?;

    transcription_done.store(true, Ordering::Relaxed);
    let _ = heartbeat_task.await;

    let diarization_mode = get_diarization_mode(&app_handle);
    let use_diarization = get_use_diarization(&app_handle);
    emit_audio_import_progress(&app_handle, &file_path, "titling", 0.72, "Generating note title");
    let note_title = generate_smart_note_title(&app_handle, &transcription).await;

    // OpenAI diarization: segments already populated from transcription
    let is_openai_diarization = diarization_mode == "openai" && !segments.is_empty();

    if !use_diarization && !is_openai_diarization {
        emit_audio_import_progress(&app_handle, &file_path, "completed", 1.0, "Completed without diarization");
        return Ok(AudioImportProcessedResult {
            note_html: compose_raw_only_html(&transcription),
            raw_text: transcription,
            diarization_json: None,
            note_title,
            polish_applied: false,
            polished_text: None,
            diarization_model: None,
            synthesis_model: Some(active_synthesis_model_label(&app_handle)),
            polish_language_mode: Some(get_polish_language_mode(&app_handle)),
            polish_target_language: Some(get_polish_target_language(&app_handle)),
        });
    }

    let (final_segments, raw_text, diarization_model_str) = if is_openai_diarization {
        // Use segments from OpenAI transcription directly
        let model_label = format!("openai:{}", get_transcription_model(&app_handle));
        let diarized_segments: Vec<DiarizedSegment> = segments.iter().map(|s| DiarizedSegment {
            speaker_id: s.speaker_id,
            text: s.text.clone(),
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            language: s.language.clone(),
        }).collect();
        let raw_text = format_segments_as_plain_text(&diarized_segments);
        let diarization_json = serde_json::to_string(&diarized_segments)
            .map_err(|e| format!("Failed to serialize diarization: {}", e))?;
        let (note_html, polish_applied, polished_text) = match auto_polish_diarized_transcript(app_handle.clone(), raw_text.clone()).await {
            Ok(polished) => (compose_polished_and_raw_html_with_segments(&polished, &diarized_segments), true, Some(polished)),
            Err(err) => {
                log::warn!("Auto-polish after OpenAI diarization failed: {}", err);
                (compose_raw_only_html_with_segments(&diarized_segments), false, None)
            }
        };
        emit_audio_import_progress(&app_handle, &file_path, "completed", 1.0, "Audio import completed with OpenAI diarization");
        return Ok(AudioImportProcessedResult {
            note_html,
            raw_text,
            diarization_json: Some(diarization_json),
            note_title,
            polish_applied,
            polished_text,
            diarization_model: Some(model_label),
            synthesis_model: Some(active_synthesis_model_label(&app_handle)),
            polish_language_mode: Some(get_polish_language_mode(&app_handle)),
            polish_target_language: Some(get_polish_target_language(&app_handle)),
        });
    } else {
        // Local WeSpeaker diarization
        emit_audio_import_progress(&app_handle, &file_path, "diarizing", 0.78, "Detecting speakers");
        let max_speakers = get_max_speakers(&app_handle);
        let segs = rediarize_existing_text(&transcription, max_speakers);
        if segs.is_empty() {
            emit_audio_import_progress(&app_handle, &file_path, "completed", 1.0, "Completed without speaker segments");
            return Ok(AudioImportProcessedResult {
                note_html: compose_raw_only_html(&transcription),
                raw_text: transcription,
                diarization_json: None,
                note_title,
                polish_applied: false,
                polished_text: None,
                diarization_model: None,
                synthesis_model: Some(active_synthesis_model_label(&app_handle)),
                polish_language_mode: Some(get_polish_language_mode(&app_handle)),
                polish_target_language: Some(get_polish_target_language(&app_handle)),
            });
        }
        let raw_text = format_segments_as_plain_text(&segs);
        (segs, raw_text, "local:text-clustering-v1".to_string())
    };

    let diarization_json = serde_json::to_string(&final_segments)
        .map_err(|e| format!("Failed to serialize diarization: {}", e))?;

    emit_audio_import_progress(&app_handle, &file_path, "polishing", 0.9, "Polishing transcript");
    let (note_html, polish_applied, polished_text) = match auto_polish_diarized_transcript(app_handle.clone(), raw_text.clone()).await {
        Ok(polished) => (compose_polished_and_raw_html_with_segments(&polished, &final_segments), true, Some(polished)),
        Err(err) => {
            log::warn!("Auto-polish after audio import failed: {}", err);
            (compose_raw_only_html_with_segments(&final_segments), false, None)
        }
    };

    emit_audio_import_progress(&app_handle, &file_path, "completed", 1.0, "Audio import completed");

    Ok(AudioImportProcessedResult {
        note_html,
        raw_text,
        diarization_json: Some(diarization_json),
        note_title,
        polish_applied,
        polished_text,
        diarization_model: Some(diarization_model_str),
        synthesis_model: Some(active_synthesis_model_label(&app_handle)),
        polish_language_mode: Some(get_polish_language_mode(&app_handle)),
        polish_target_language: Some(get_polish_target_language(&app_handle)),
    })
}

async fn transcribe_audio_with_preferred_provider(
    app_handle: &AppHandle,
    file_path: &str,
) -> Result<String, String> {
    let (text, _) = transcribe_audio_with_preferred_provider_inner(app_handle, file_path).await?;
    Ok(text)
}

async fn transcribe_audio_with_preferred_provider_inner(
    app_handle: &AppHandle,
    file_path: &str,
) -> Result<(String, Vec<TranscriptRawSegment>), String> {
    let use_local = get_use_local_transcription(app_handle);
    if use_local {
        return transcribe_audio_with_local_model(app_handle, file_path).await
            .map(|text| (text, Vec::new()));
    }

    let diarization_mode = get_diarization_mode(app_handle);
    let is_openai_diarization = diarization_mode == "openai";

    let openai_api_key = get_openai_api_key(app_handle);
    if openai_api_key.is_empty() {
        log::warn!("OpenAI API key missing, falling back to local transcription");
        return transcribe_audio_with_local_model(app_handle, file_path).await
            .map(|text| (text, Vec::new()));
    }

    let transcription_model = get_transcription_model(app_handle);
    let model = if transcription_model.is_empty() {
        "whisper-1".to_string()
    } else {
        transcription_model
    };
    let openai_base_url = get_openai_api_base(app_handle);

    if is_openai_diarization {
        match crate::engine::transcription_engine::transcribe_with_openai_diarized(
            file_path,
            &openai_api_key,
            &model,
            &openai_base_url,
        )
        .await
        {
            Ok(openai_segments) => {
                let segments: Vec<TranscriptRawSegment> = openai_segments
                    .into_iter()
                    .map(|s| TranscriptRawSegment {
                        speaker_id: s.speaker
                            .as_ref()
                            .and_then(|sp| sp.trim().trim_start_matches('S').trim_start_matches('s').split_whitespace().next())
                            .and_then(|sp| sp.trim_start_matches('#').parse::<u32>().ok())
                            .unwrap_or(0),
                        start_ms: s.start.map(|v| v as u64),
                        end_ms: s.end.map(|v| v as u64),
                        text: s.text.trim().to_string(),
                        original_text: None,
                        language: None,
                    })
                    .collect();
                let text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                Ok((text, segments))
            }
            Err(err) => {
                let err_text = err.to_string();
                if should_fallback_to_local(&err_text) {
                    log::warn!("OpenAI diarization failed with auth/config error; falling back to local model");
                    transcribe_audio_with_local_model(app_handle, file_path).await
                        .map(|text| (text, Vec::new()))
                } else {
                    log::warn!("OpenAI diarization failed: {}; falling back to plain transcription", err_text);
                    // Fallback to plain transcription
                    crate::engine::transcription_engine::transcribe_with_openai(
                        file_path,
                        &openai_api_key,
                        &model,
                        &openai_base_url,
                    )
                    .await
                    .map(|text| (text, Vec::new()))
                    .map_err(|e| sanitize_openai_error(&e.to_string()))
                }
            }
        }
    } else {
        match crate::engine::transcription_engine::transcribe_with_openai(
            file_path,
            &openai_api_key,
            &model,
            &openai_base_url,
        )
        .await
        {
            Ok(text) => Ok((text, Vec::new())),
            Err(err) => {
                let err_text = err.to_string();
                if should_fallback_to_local(&err_text) {
                    log::warn!("OpenAI transcription failed with auth/config error; falling back to local model");
                    transcribe_audio_with_local_model(app_handle, file_path).await
                        .map(|text| (text, Vec::new()))
                } else {
                    Err(sanitize_openai_error(&err_text))
                }
            }
        }
    }
}

fn get_openai_api_key(app_handle: &AppHandle) -> String {
    app_handle.db(|db| {
        get_setting(db, "api_key_open_ai")
            .map(|s| s.setting_value)
            .unwrap_or_default()
    })
}

fn get_openai_api_base(app_handle: &AppHandle) -> String {
    app_handle.db(|db| {
        get_setting(db, "openai_api_base")
            .map(|s| s.setting_value)
            .unwrap_or_default()
    })
}

fn get_use_local_transcription(app_handle: &AppHandle) -> bool {
    app_handle.db(|db| {
        get_setting(db, "use_local_transcription")
            .map(|s| s.setting_value == "true")
            .unwrap_or(false)
    })
}

fn should_fallback_to_local(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("invalid_api_key")
        || lower.contains("incorrect api key")
        || lower.contains("401")
        || lower.contains("unauthorized")
}

fn sanitize_openai_error(err: &str) -> String {
    let lower = err.to_ascii_lowercase();
    if lower.contains("invalid_api_key") || lower.contains("incorrect api key") {
        "OpenAI API key non valida. Verifica la chiave nelle impostazioni oppure usa la trascrizione locale.".to_string()
    } else {
        err.to_string()
    }
}

async fn ensure_whisper_engine_initialized(app_handle: &AppHandle) -> Result<(), String> {
    {
        let guard = WHISPER_ENGINE.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
    }

    let model_id = get_whisper_model_id(app_handle);
    let engine = tokio::task::spawn_blocking(move || {
        crate::engine::whisper_engine::WhisperEngine::load(&model_id)
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
    .map_err(|e| {
        format!(
            "Local Whisper model non disponibile: {}. Scarica e inizializza il modello locale dalle impostazioni.",
            e
        )
    })?;

    let mut guard = WHISPER_ENGINE.lock().unwrap();
    *guard = Some(engine);
    Ok(())
}

async fn transcribe_audio_with_local_model(
    app_handle: &AppHandle,
    file_path: &str,
) -> Result<String, String> {
    ensure_whisper_engine_initialized(app_handle).await?;

    let input_path = file_path.to_string();
    tokio::task::spawn_blocking(move || {
        let tmp = tempfile::Builder::new()
            .prefix("platypus_local_transcribe_")
            .suffix(".wav")
            .tempfile()
            .map_err(|e| format!("Failed to allocate temporary wav file: {}", e))?;

        let wav_path = tmp.path().to_string_lossy().to_string();
        let ffmpeg_output = std::process::Command::new("ffmpeg")
            .arg("-y")
            .arg("-i")
            .arg(&input_path)
            .arg("-ar")
            .arg("16000")
            .arg("-ac")
            .arg("1")
            .arg("-c:a")
            .arg("pcm_s16le")
            .arg(&wav_path)
            .output()
            .map_err(|e| {
                format!(
                    "Failed to run ffmpeg for local transcription ({}). Install ffmpeg and retry.",
                    e
                )
            })?;

        if !ffmpeg_output.status.success() {
            let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
            return Err(format!(
                "ffmpeg conversion failed for local transcription: {}",
                stderr.trim()
            ));
        }

        let mut reader = hound::WavReader::open(&wav_path)
            .map_err(|e| format!("Failed to open normalized wav file: {}", e))?;
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|s| s.map(|v| v as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed reading wav samples: {}", e))?;

        let guard = WHISPER_ENGINE.lock().unwrap();
        let engine = guard
            .as_ref()
            .ok_or_else(|| "Whisper engine not initialized".to_string())?;

        engine
            .transcribe(&samples)
            .map_err(|e| format!("Local Whisper transcription failed: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

// Whisper model management commands
fn get_whisper_model_id(app_handle: &AppHandle) -> String {
    app_handle.db(|db| {
        get_setting(db, "whisper_model")
            .map(|s| s.setting_value)
            .unwrap_or_default()
    })
}

fn get_transcription_model(app_handle: &AppHandle) -> String {
    app_handle.db(|db| {
        get_setting(db, "transcription_model")
            .map(|s| s.setting_value)
            .unwrap_or_default()
    })
}

fn get_use_diarization(app_handle: &AppHandle) -> bool {
    app_handle.db(|db| {
        get_setting(db, "use_diarization")
            .map(|s| s.setting_value == "true")
            .unwrap_or(false)
    })
}

fn get_max_speakers(app_handle: &AppHandle) -> usize {
    app_handle.db(|db| {
        get_setting(db, "max_speakers")
            .ok()
            .and_then(|s| s.setting_value.parse::<usize>().ok())
            .filter(|v| *v > 0 && *v <= 12)
            .unwrap_or(6)
    })
}

fn get_diarization_mode(app_handle: &AppHandle) -> String {
    app_handle.db(|db| {
        get_setting(db, "diarization_mode")
            .map(|s| s.setting_value)
            .unwrap_or_default()
    })
}

#[tauri::command]
fn check_whisper_model(app_handle: AppHandle) -> bool {
    let model_id = get_whisper_model_id(&app_handle);
    crate::engine::whisper_engine::is_model_downloaded(&model_id)
}

#[tauri::command]
async fn download_whisper_model(app_handle: AppHandle) -> Result<(), String> {
    let model_id = get_whisper_model_id(&app_handle);
    crate::engine::whisper_engine::download_model(&app_handle, &model_id)
        .await
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
async fn init_whisper_model(app_handle: AppHandle) -> Result<(), String> {
    let model_id = get_whisper_model_id(&app_handle);
    let engine = tokio::task::spawn_blocking(move || {
        crate::engine::whisper_engine::WhisperEngine::load(&model_id)
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
    .map_err(|e| format!("{}", e))?;

    let mut guard = WHISPER_ENGINE.lock().unwrap();
    *guard = Some(engine);
    info!("Whisper engine initialized");
    Ok(())
}

#[tauri::command]
fn check_diarization_model() -> bool {
    crate::engine::diarization_engine::is_diarization_model_downloaded()
}

#[tauri::command]
async fn download_diarization_model(app_handle: AppHandle) -> Result<(), String> {
    crate::engine::diarization_engine::download_diarization_model(&app_handle)
        .await
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
async fn init_diarization_model() -> Result<(), String> {
    let path = diarization_model_path();
    let engine = tokio::task::spawn_blocking(move || DiarizationEngine::load(path))
        .await
        .map_err(|e| format!("Join error: {}", e))?
        .map_err(|e| format!("{}", e))?;

    let mut guard = DIARIZATION_ENGINE.lock().unwrap();
    *guard = Some(engine);
    info!("Diarization engine initialized");
    Ok(())
}

#[tauri::command]
fn get_transcript() -> String {
    let t = ACCUMULATED_TRANSCRIPT.lock().unwrap();
    t.clone()
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Process a chunk of raw audio: resample → transcribe with Whisper.
/// No RMS gate — Whisper itself handles silence (returns empty), so we let
/// every chunk through to avoid dropping quiet speech (soft speakers, laptop
/// speaker playback, distant voices).
fn process_and_transcribe_chunk(
    raw_samples: &[f32],
    use_diarization: bool,
) -> Option<(String, Option<u32>)> {
    use crate::engine::audio_processor::resample;
    use crate::engine::mel_filterbank::extract_log_mel;

    const DIARIZATION_MIN_RMS: f32 = 0.0035;

    let device_rate = crate::engine::audio_engine::DEVICE_SAMPLE_RATE
        .load(std::sync::atomic::Ordering::SeqCst);
    if device_rate == 0 {
        return None;
    }

    // Resample directly to 16kHz for Whisper. Whisper-large-v3-turbo is robust
    // to noise on its own, and RNNoise was crushing speech amplitude.
    let samples_16k = match resample(raw_samples, device_rate, 16000) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Resample to 16kHz failed: {}", e);
            return None;
        }
    };

    // Transcribe
    let guard = WHISPER_ENGINE.lock().unwrap();
    if let Some(engine) = guard.as_ref() {
        match engine.transcribe(&samples_16k) {
            Ok(text) if !text.is_empty() => {
                if !use_diarization {
                    return Some((text, None));
                }

                let diarization_guard = DIARIZATION_ENGINE.lock().unwrap();
                let diarization = match diarization_guard.as_ref() {
                    Some(d) => d,
                    None => return Some((text, None)),
                };

                let chunk_rms = compute_rms(&samples_16k);
                if chunk_rms < DIARIZATION_MIN_RMS {
                    log::debug!(
                        "Skipping diarization for low-energy chunk (rms={:.6})",
                        chunk_rms
                    );
                    return Some((text, None));
                }

                let mel = extract_log_mel(&samples_16k, 80);
                if mel.is_empty() {
                    return Some((text, None));
                }

                let embedding = match diarization.embed(&mel) {
                    Ok(e) if !e.is_empty() => e,
                    Ok(_) => return Some((text, None)),
                    Err(err) => {
                        log::warn!("Diarization embed failed: {}", err);
                        return Some((text, None));
                    }
                };

                let assignment = STREAMING_DIARIZER
                    .lock()
                    .unwrap()
                    .assign_speaker_with_overlap(&embedding);
                if assignment.is_overlap {
                    log::debug!(
                        "Overlap detected between speakers {} and {:?}",
                        assignment.speaker_id,
                        assignment.secondary_speaker_id
                    );
                }
                Some((text, Some(assignment.speaker_id)))
            }
            Ok(_) => None,
            Err(e) => {
                log::warn!("Whisper transcription error: {}", e);
                None
            }
        }
    } else {
        log::warn!("Whisper engine not initialized");
        None
    }
}

/// Realtime transcription loop — polls the audio buffer every 50ms,
/// accumulates ~2s chunks, transcribes, and emits events
async fn realtime_transcription_loop(app_handle: AppHandle, use_diarization: bool) {
    use crate::engine::audio_engine::{IS_RECORDING, DEVICE_SAMPLE_RATE, take_new_samples};

    let mut pending: Vec<f32> = Vec::new();
    let mut silence_count: u32 = 0;

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        if !IS_RECORDING.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        let new = take_new_samples();
        if new.is_empty() {
            continue;
        }
        pending.extend_from_slice(&new);

        let device_rate = DEVICE_SAMPLE_RATE.load(std::sync::atomic::Ordering::SeqCst);
        if device_rate == 0 {
            continue;
        }

        let chunk_duration_samples = (device_rate as usize) * 3; // 3 seconds
        let min_chunk_samples = (device_rate as usize) * 2;    // 2 seconds minimum

        // Check if we have enough for a chunk, or if there's a silence gap
        let rms = compute_rms(&new);

        if rms < 0.005 {
            silence_count += 1;
        } else {
            silence_count = 0;
        }

        let should_process = pending.len() >= chunk_duration_samples
            || (silence_count >= 10 && pending.len() >= min_chunk_samples);

        if !should_process {
            continue;
        }

        let chunk: Vec<f32> = pending.drain(..).collect();
        silence_count = 0;

        // Transcribe on a blocking thread to avoid blocking the async runtime
        let app = app_handle.clone();
        let transcript_arc = ACCUMULATED_TRANSCRIPT.clone();
        let segments_arc = DIARIZED_SEGMENTS.clone();
        let cursor_arc = TRANSCRIPT_CURSOR_MS.clone();
        let chunk_len = chunk.len();
        let chunk_rate = device_rate;
        tokio::task::spawn_blocking(move || {
            if let Some((text, speaker_id)) = process_and_transcribe_chunk(&chunk, use_diarization)
            {
                let mut t = transcript_arc.lock().unwrap();
                if !t.is_empty() {
                    t.push(' ');
                }
                t.push_str(&text);
                let current = t.clone();
                drop(t);

                let mut chunk_start_ms: Option<u64> = None;
                let mut chunk_end_ms: Option<u64> = None;

                if let Some(sid) = speaker_id {
                    let chunk_ms = if chunk_rate > 0 {
                        ((chunk_len as u64) * 1000) / (chunk_rate as u64)
                    } else {
                        0
                    };
                    let (start_ms, end_ms) = {
                        let mut cursor = cursor_arc.lock().unwrap();
                        let start = *cursor;
                        let end = start.saturating_add(chunk_ms);
                        *cursor = end;
                        (start, end)
                    };
                    chunk_start_ms = Some(start_ms);
                    chunk_end_ms = Some(end_ms);
                    segments_arc
                        .lock()
                        .unwrap()
                        .push(DiarizedSegment {
                            speaker_id: sid,
                            text: text.clone(),
                            start_ms: Some(start_ms),
                            end_ms: Some(end_ms),
                            language: None,
                        });
                }

                if let Some(w) = app.get_window("main") {
                    let _ = w.emit("transcript-update", serde_json::json!({
                        "text": current,
                        "speaker_id": speaker_id,
                        "chunk_text": text,
                        "start_ms": chunk_start_ms,
                        "end_ms": chunk_end_ms,
                        "is_final": false
                    }));
                }
            }
        });
    }
}

// Document import commands
#[tauri::command]
async fn extract_document_text(file_path: String) -> Result<String, String> {
    use std::path::Path;
    
    log::info!("Extracting text from document: {}", file_path);
    
    // Check if file exists
    if !Path::new(&file_path).exists() {
        return Err(format!("File not found: {}", file_path));
    }
    
    // Determine file type based on extension
    let path = Path::new(&file_path);
    let extension = path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .unwrap_or_default();
    
    log::info!("File extension detected: {}", extension);
    
    match extension.as_str() {
        "pdf" => {
            log::info!("Attempting to extract text from PDF...");
            extract_text_from_pdf(&file_path)
        },
        "txt" | "md" | "rtf" => {
            log::info!("Reading text file...");
            read_text_file(&file_path)
        },
        "docx" => {
            log::info!("Attempting to extract text from DOCX...");
            extract_text_from_docx(&file_path)
        },
        _ => Err(format!("Unsupported file format: {}. Supported formats: PDF, TXT, MD, RTF, DOCX", extension))
    }
}

fn extract_text_from_pdf(file_path: &str) -> Result<String, String> {
    match pdf_extract::extract_text(file_path) {
        Ok(text) => {
            log::info!("Successfully extracted {} characters from PDF", text.len());
            if text.trim().is_empty() {
                Err("PDF appears to be empty or contains only images/non-text content".to_string())
            } else {
                Ok(text)
            }
        },
        Err(err) => {
            log::error!("PDF extraction error: {:?}", err);
            Err(format!("Failed to extract text from PDF: {}. Make sure the PDF contains text (not just images).", err))
        }
    }
}

fn extract_text_from_docx(file_path: &str) -> Result<String, String> {
    // Read the file bytes
    let bytes = std::fs::read(file_path).map_err(|e| format!("Failed to read DOCX file: {}", e))?;
    
    log::info!("DOCX file size: {} bytes", bytes.len());
    
    // DOCX files are ZIP archives containing XML
    // We'll extract text from the document.xml inside
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Failed to open DOCX archive: {}", e))?;
    
    // Find and read word/document.xml
    let mut doc_xml = archive.by_name("word/document.xml")
        .map_err(|_| "DOCX file does not contain document.xml")?;
    
    let mut xml_content = String::new();
    std::io::Read::read_to_string(&mut doc_xml, &mut xml_content)
        .map_err(|e| format!("Failed to read document.xml: {}", e))?;
    
    // Extract text between <w:t> tags (Word text elements)
    let mut extracted_text = String::new();
    let mut in_text_element = false;
    let mut current_text = String::new();
    let mut tag_buffer = String::new();
    let mut in_tag = false;
    
    for c in xml_content.chars() {
        if c == '<' {
            in_tag = true;
            tag_buffer.clear();
            if !current_text.is_empty() && in_text_element {
                extracted_text.push_str(&current_text);
                current_text.clear();
            }
        } else if c == '>' {
            in_tag = false;
            // Check if it's a text element opening or closing
            if tag_buffer.starts_with("w:t") && !tag_buffer.starts_with("w:t ") || tag_buffer.starts_with("w:t ") {
                in_text_element = true;
            } else if tag_buffer == "/w:t" {
                in_text_element = false;
            } else if tag_buffer == "/w:p" {
                // End of paragraph - add newline
                extracted_text.push('\n');
            }
        } else if in_tag {
            tag_buffer.push(c);
        } else if in_text_element {
            current_text.push(c);
        }
    }
    
    let trimmed = extracted_text.trim().to_string();
    if trimmed.is_empty() {
        Err("DOCX file appears to be empty or could not be parsed".to_string())
    } else {
        log::info!("Successfully extracted {} characters from DOCX", trimmed.len());
        Ok(trimmed)
    }
}

fn read_text_file(file_path: &str) -> Result<String, String> {
    match std::fs::read_to_string(file_path) {
        Ok(content) => {
            log::info!("Successfully read {} characters from text file", content.len());
            Ok(content)
        },
        Err(e) => {
            log::error!("Error reading text file: {:?}", e);
            Err(format!("Failed to read text file: {}", e))
        }
    }
}
