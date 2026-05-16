use std::error::Error;
use async_openai::{types::CreateEmbeddingRequestArgs, Client, config::OpenAIConfig};

const DEFAULT_EMBED_MODEL: &str = "text-embedding-3-small";

// Correct async function for computing vector embeddings
pub async fn compute_vector_embedding(text: &str, api_key: &str, api_base: Option<&str>, model: Option<&str>) -> Result<Vec<f32>, Box<dyn Error>> {
    let config: OpenAIConfig = if let Some(base) = api_base {
        if !base.trim().is_empty() {
            OpenAIConfig::new()
                .with_api_key(api_key)
                .with_api_base(url::Url::parse(base).expect("Invalid OpenAI base URL"))
        } else {
            OpenAIConfig::new().with_api_key(api_key)
        }
    } else {
        OpenAIConfig::new().with_api_key(api_key)
    };

    let embed_model = model.unwrap_or(DEFAULT_EMBED_MODEL);

    let client = Client::with_config(config);
    let request = CreateEmbeddingRequestArgs::default()
        .model(embed_model)
        .input([text])
        .build()?;
    let response = client.embeddings().create(request).await?;
    Ok(response.data[0].embedding.clone())
}
