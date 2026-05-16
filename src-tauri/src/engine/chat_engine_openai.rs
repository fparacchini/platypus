use crate::configuration::state::ServiceAccess;
use crate::repository::settings_repository::get_setting;
use async_openai::{
    config::OpenAIConfig,
    types::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        ChatCompletionRequestAssistantMessageArgs, ChatCompletionRequestMessage,
        CreateChatCompletionRequestArgs,
    },
    Client as OpenAIClient,
};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_MODEL: &str = "gpt-5.4";

#[derive(Serialize, Deserialize)]
pub struct Message {
    role: String,
    content: String,
}

#[tauri::command]
pub async fn send_prompt_to_openai(
    app_handle: tauri::AppHandle,
    conversation_history: Vec<Message>,
    _is_first_message: bool,
    _combined_activity_text: String,
    _model_id: Option<String>,
    _project_id: Option<i64>, // Project ID for chunk-based retrieval
) -> Result<(), String> {
    let api_key_setting = app_handle.db(|db| get_setting(db, "api_key_open_ai").expect("Failed on api_key_open_ai"));
    let base_url_setting = app_handle.db(|db| get_setting(db, "openai_api_base").expect("Failed on openai_api_base"));


    // Initialize the OpenAI client with the API key
    let config = if !base_url_setting.setting_value.trim().is_empty() {
        OpenAIConfig::new()
            .with_api_key(&api_key_setting.setting_value)
            .with_api_base(url::Url::parse(&base_url_setting.setting_value).expect("Invalid OpenAI base URL"))
    } else {
        OpenAIConfig::new().with_api_key(&api_key_setting.setting_value)
    };
    let client = OpenAIClient::with_config(config);


    // Create a chat completion request with the system message and user input.
    // Note: GPT-5.x models reject `max_tokens` and require `max_completion_tokens`,
    // which the async-openai 0.23 builder doesn't expose. Skipping the cap is fine —
    // the system prompt already constrains output to ≤18 characters.
    let messages: Vec<ChatCompletionRequestMessage> = conversation_history
        .into_iter()
        .map(|msg| match msg.role.as_str() {
            "system" => ChatCompletionRequestSystemMessageArgs::default()
                .content(msg.content)
                .build()
                .unwrap()
                .into(),
            "assistant" => ChatCompletionRequestAssistantMessageArgs::default()
                .content(msg.content)
                .build()
                .unwrap()
                .into(),
            _ => ChatCompletionRequestUserMessageArgs::default()
                .content(msg.content)
                .build()
                .unwrap()
                .into(),
        })
        .collect();

    let request = CreateChatCompletionRequestArgs::default()
        .model(DEFAULT_MODEL)
        .messages(messages)
        .build()
        .map_err(|e| format!("chat completion request_error: {}", e))?;

    // Send the request to OpenAI and await the response, converting any OpenAIError to a String
    let response = client
        .chat()
        .create(request)
        .await
        .map_err(|e| format!("generate_conversation_name OpenAI API request failed: {}", e))?;

    // Extract the first message content safely from the response
    let _generated_name = response.choices[0]
        .message
        .content
        .as_ref() // Convert Option<String> to Option<&String>
        .map(|s| s.trim().to_string()) // Trim and convert to String if Some
        .unwrap_or_else(|| "Unnamed Conversation".to_string()); // Provide fallback if None

    Ok(())
}

// OpenAI-compatible models listing

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelInfo>,
}

#[derive(Deserialize)]
struct OpenAIModelInfo {
    id: String,
    owned_by: Option<String>,
}

#[tauri::command]
pub async fn list_openai_models(
    app_handle: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let api_key_setting = app_handle
        .db(|db| get_setting(db, "api_key_open_ai").map_err(|e| e.to_string()))?;

    if api_key_setting.setting_value.is_empty() {
        return Err("OpenAI API key not configured".to_string());
    }

    let base_url_setting = app_handle
        .db(|db| get_setting(db, "openai_api_base").map_err(|e| e.to_string()))?;

    let base_url = if !base_url_setting.setting_value.trim().is_empty() {
        base_url_setting.setting_value.clone()
    } else {
        "https://api.openai.com".to_string()
    };

    let base_trimmed = base_url.trim_end_matches('/');
    let models_url = if base_trimmed.ends_with("/v1") {
        format!("{}/models", base_trimmed)
    } else {
        format!("{}/v1/models", base_trimmed)
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&models_url)
        .header("Authorization", format!("Bearer {}", api_key_setting.setting_value))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to {}: {}", base_url, e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API returned {}: {}", status, body));
    }

    let models_response: OpenAIModelsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))?;

    Ok(models_response.data.into_iter().map(|m| m.id).collect())
}
