import { useEffect, useState } from "react";
import {
  Box,
  Flex,
  Text,
  Switch,
  Select,
  VStack,
  Input,
  Button,
  useToast,
  Spinner,
} from "@chakra-ui/react";
import { useGlobalSettings } from "../Providers/SettingsProvider";
import { invoke } from "@tauri-apps/api/tauri";

type LocalSettings = {
  autoStart: boolean;
  apiChoice: "claude" | "openai" | "gemini" | "local";
  apiKeyOpenAi: string;
  openAiApiBase: string;
  apiKeyClaude: string;
  apiKeyGemini: string;
  localModelUrl: string;
  vectorizationEnabled: boolean;
  ragTopK: number;
  meetingDetectionEnabled: boolean;
  modelClaude: string;
  modelOpenai: string;
  modelGemini: string;
  useLocalTranscription: boolean;
  whisperModel: string;
  transcriptionModel: string;
  useDiarization: boolean;
  maxSpeakers: number;
  polishLanguageMode: "keep_original" | "translate";
  polishTargetLanguage: string;
  apiKeyElevenlabs: string;
  promptCleanupSystem: string;
  promptNoteTitleSystem: string;
  promptTranscriptCleanup: string;
  promptMeetingSummarySystem: string;
  promptSlidesSystem: string;
  promptPodcastScriptSystem: string;
};

type PromptKey =
  | "promptCleanupSystem"
  | "promptNoteTitleSystem"
  | "promptTranscriptCleanup"
  | "promptMeetingSummarySystem"
  | "promptSlidesSystem"
  | "promptPodcastScriptSystem";

type ModelOption = {
  id: string;
  name: string;
};

const CLOUD_MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
];

export const GeneralSettings = () => {
  const toast = useToast();
  const { settings, update } = useGlobalSettings();
  const [localSettings, setLocalSettings] = useState<LocalSettings>({
    autoStart: settings.auto_start,
    apiChoice: settings.api_choice,
    apiKeyOpenAi: settings.api_key_open_ai,
    openAiApiBase: settings.openai_api_base,
    apiKeyClaude: settings.api_key_claude,
    apiKeyGemini: settings.api_key_gemini,
    localModelUrl: settings.local_model_url,
    vectorizationEnabled: settings.vectorization_enabled,
    ragTopK: settings.rag_top_k,
    meetingDetectionEnabled: settings.meeting_detection_enabled,
    modelClaude: settings.model_claude,
    modelOpenai: settings.model_openai,
    modelGemini: settings.model_gemini,
    useLocalTranscription: settings.use_local_transcription,
    whisperModel: settings.whisper_model,
    transcriptionModel: settings.transcription_model,
    useDiarization: settings.use_diarization,
    maxSpeakers: settings.max_speakers,
    polishLanguageMode: settings.polish_language_mode,
    polishTargetLanguage: settings.polish_target_language,
    apiKeyElevenlabs: settings.api_key_elevenlabs,
    promptCleanupSystem: settings.prompt_cleanup_system,
    promptNoteTitleSystem: settings.prompt_note_title_system,
    promptTranscriptCleanup: settings.prompt_transcript_cleanup,
    promptMeetingSummarySystem: settings.prompt_meeting_summary_system,
    promptSlidesSystem: settings.prompt_slides_system,
    promptPodcastScriptSystem: settings.prompt_podcast_script_system,
  });

  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    setLocalSettings({
      autoStart: settings.auto_start,
      apiChoice: settings.api_choice,
      apiKeyOpenAi: settings.api_key_open_ai,
      openAiApiBase: settings.openai_api_base,
      apiKeyClaude: settings.api_key_claude,
      apiKeyGemini: settings.api_key_gemini,
      localModelUrl: settings.local_model_url,
      vectorizationEnabled: settings.vectorization_enabled,
      ragTopK: settings.rag_top_k,
      meetingDetectionEnabled: settings.meeting_detection_enabled,
      modelClaude: settings.model_claude,
      modelOpenai: settings.model_openai,
      modelGemini: settings.model_gemini,
      useLocalTranscription: settings.use_local_transcription,
      whisperModel: settings.whisper_model,
      transcriptionModel: settings.transcription_model,
      useDiarization: settings.use_diarization,
      maxSpeakers: settings.max_speakers,
      polishLanguageMode: settings.polish_language_mode,
      polishTargetLanguage: settings.polish_target_language,
      apiKeyElevenlabs: settings.api_key_elevenlabs,
      promptCleanupSystem: settings.prompt_cleanup_system,
      promptNoteTitleSystem: settings.prompt_note_title_system,
      promptTranscriptCleanup: settings.prompt_transcript_cleanup,
      promptMeetingSummarySystem: settings.prompt_meeting_summary_system,
      promptSlidesSystem: settings.prompt_slides_system,
      promptPodcastScriptSystem: settings.prompt_podcast_script_system,
    });
  }, [settings]);

  // Fetch available models based on selected endpoint
  useEffect(() => {
    const apiChoice = localSettings.apiChoice;

    if (apiChoice === "claude" || apiChoice === "gemini") {
      const cloud = CLOUD_MODELS.filter(
        (m) =>
          (apiChoice === "claude" && m.id.includes("claude")) ||
          (apiChoice === "gemini" && m.id.includes("gemini"))
      );
      setAvailableModels(cloud);
      setModelsLoading(false);
      return;
    }

    if (apiChoice === "openai") {
      setModelsLoading(true);
      invoke<string[]>("list_openai_models")
        .then((result) => {
          setAvailableModels(result.map((id) => ({ id, name: id })));
          setModelsLoading(false);
        })
        .catch(() => {
          // Fallback to cloud models if fetch fails
          const cloud = CLOUD_MODELS.filter((m) => m.id.includes("gpt"));
          setAvailableModels(cloud);
          setModelsLoading(false);
        });
      return;
    }

    if (apiChoice === "local") {
      setModelsLoading(true);
      invoke<string[]>("list_local_models")
        .then((result) => {
          setAvailableModels(result.map((name) => ({ id: name, name })));
          setModelsLoading(false);
        })
        .catch(() => {
          setAvailableModels([]);
          setModelsLoading(false);
        });
      return;
    }
  }, [localSettings.apiChoice]);

  const savedSuccessfullyToast = () => {
    toast({
      title: "Setttings saved sucessfully",
      status: "success",
      duration: 2000,
      isClosable: true,
    });
  };

  const handleAutoStartChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const isChecked = event.target.checked;
    await update({ ...settings, auto_start: isChecked });
  };

  type ApiChoice = "claude" | "openai" | "gemini" | "local";
  const handleApiChoiceChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const apiChoice = event.target.value as ApiChoice;
    setLocalSettings((prevState) => ({ ...prevState, apiChoice }));
  };

  const onChangeOpenAiApiKey = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      apiKeyOpenAi: event.target.value,
    }));
  };
  const onChangeClaueApiKey = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      apiKeyClaude: event.target.value,
    }));
  };
  const onChangeGeminiApiKey = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      apiKeyGemini: event.target.value,
    }));
  };
  const onChangeLocalModelUrl = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      localModelUrl: event.target.value,
    }));
  };
  const onSave = () => {
    update({
      ...settings,
      auto_start: localSettings.autoStart,
      api_choice: localSettings.apiChoice,
      api_key_open_ai: localSettings.apiKeyOpenAi,
      openai_api_base: localSettings.openAiApiBase,
      api_key_claude: localSettings.apiKeyClaude,
      api_key_gemini: localSettings.apiKeyGemini,
      local_model_url: localSettings.localModelUrl,
      vectorization_enabled: localSettings.vectorizationEnabled,
      rag_top_k: localSettings.ragTopK,
      meeting_detection_enabled: localSettings.meetingDetectionEnabled,
      model_claude: localSettings.modelClaude,
      model_openai: localSettings.modelOpenai,
      model_gemini: localSettings.modelGemini,
      use_local_transcription: localSettings.useLocalTranscription,
      whisper_model: localSettings.whisperModel,
      transcription_model: localSettings.transcriptionModel,
      use_diarization: localSettings.useDiarization,
      max_speakers: Math.max(1, Math.min(12, localSettings.maxSpeakers || 6)),
      polish_language_mode: localSettings.polishLanguageMode,
      polish_target_language: localSettings.polishTargetLanguage.trim() || "Italian",
      api_key_elevenlabs: localSettings.apiKeyElevenlabs,
      prompt_cleanup_system: localSettings.promptCleanupSystem,
      prompt_note_title_system: localSettings.promptNoteTitleSystem,
      prompt_transcript_cleanup: localSettings.promptTranscriptCleanup,
      prompt_meeting_summary_system: localSettings.promptMeetingSummarySystem,
      prompt_slides_system: localSettings.promptSlidesSystem,
      prompt_podcast_script_system: localSettings.promptPodcastScriptSystem,
    });
    savedSuccessfullyToast();
  };

  const onChangeRagTopK = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseInt(event.target.value, 10) || 20;
    setLocalSettings((prevState) => ({
      ...prevState,
      ragTopK: Math.max(1, Math.min(50, value)), // Clamp between 1 and 50
    }));
  };

  const handleVectorizationChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      vectorizationEnabled: event.target.checked,
    }));
  };

  const handleMeetingDetectionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      meetingDetectionEnabled: event.target.checked,
    }));
  };

  const handleLocalTranscriptionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      useLocalTranscription: event.target.checked,
    }));
  };

  const handleDiarizationChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSettings((prevState) => ({
      ...prevState,
      useDiarization: event.target.checked,
    }));
  };

  const handleMaxSpeakersChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = Number.parseInt(event.target.value, 10) || 6;
    setLocalSettings((prevState) => ({
      ...prevState,
      maxSpeakers: Math.max(1, Math.min(12, parsed)),
    }));
  };

  const getModelValue = (): string => {
    switch (localSettings.apiChoice) {
      case "claude": return localSettings.modelClaude || "";
      case "openai": return localSettings.modelOpenai || "";
      case "gemini": return localSettings.modelGemini || "";
      default: return "";
    }
  };

  const setModelValue = (value: string) => {
    switch (localSettings.apiChoice) {
      case "claude":
        setLocalSettings((prev) => ({ ...prev, modelClaude: value }));
        break;
      case "openai":
        setLocalSettings((prev) => ({ ...prev, modelOpenai: value }));
        break;
      case "gemini":
        setLocalSettings((prev) => ({ ...prev, modelGemini: value }));
        break;
    }
  };

  const resetPrompt = (key: PromptKey) => {
    setLocalSettings((prev) => ({ ...prev, [key]: "" }));
  };

  const PromptField = ({
    label,
    description,
    settingKey,
    placeholder,
    rows = 6,
    showPlaceholderHint = false,
  }: {
    label: string;
    description: string;
    settingKey: PromptKey;
    placeholder: string;
    rows?: number;
    showPlaceholderHint?: boolean;
  }) => (
    <Box mb={6}>
      <Flex alignItems="center" mb={2}>
        <Text fontSize="md" fontWeight="medium" flex={1}>
          {label}
        </Text>
        <Button
          size="xs"
          variant="link"
          color="teal.500"
          onClick={() => resetPrompt(settingKey)}
        >
          Reset to default
        </Button>
      </Flex>
      <Text fontSize="xs" color="gray.500" mb={2}>
        {description}
        {showPlaceholderHint && (
          <>
            {" "}
            Use <code style={{ background: "#f0f0f0", padding: "1px 4px", borderRadius: "2px" }}>
              {"{language_rule_placeholder}"}
            </code> where the language rule should be inserted.
          </>
        )}
      </Text>
      <textarea
        rows={rows}
        style={{
          width: "100%",
          padding: "8px",
          fontSize: "12px",
          fontFamily: "monospace",
          border: "1px solid",
          borderColor: "gray.200",
          borderRadius: "4px",
          resize: "vertical",
        }}
        value={localSettings[settingKey]}
        onChange={(e) =>
          setLocalSettings((prev) => ({
            ...prev,
            [settingKey]: e.target.value,
          }))
        }
        placeholder={placeholder}
      />
    </Box>
  );

  return (
    <Box>
      <VStack spacing={8} align="stretch">
        <Box>
          <Flex alignItems="center" mb={2}>
            <Text fontSize="md" mr={4}>
              Autostart Platypus:
            </Text>
            <Switch
              size="md"
              isChecked={localSettings.autoStart}
              onChange={handleAutoStartChange}
            />
          </Flex>
          <Text fontSize="sm" color="gray.500">
            Enable this option to automatically start the application on system
            startup.
          </Text>
        </Box>

        <Box>
          <Flex alignItems="center" mb={2}>
            <Text fontSize="md" mr={4}>
              Local Voice Transcription:
            </Text>
            <Switch
              size="md"
              isChecked={localSettings.useLocalTranscription}
              onChange={handleLocalTranscriptionChange}
            />
          </Flex>
          <Text fontSize="sm" color="gray.500">
            Use a local Whisper model for voice transcription instead of OpenAI API.
            Works offline, no API key needed. Shows live transcript during recording.
          </Text>
          {localSettings.useLocalTranscription && (
            <>
              <Flex alignItems="center" mt={3}>
                <Flex flex={1}>
                  <Text fontSize="md" mr={4}>
                    Whisper Model:
                  </Text>
                </Flex>
                <Flex flex={2}>
                  <Select
                    size="md"
                    value={localSettings.whisperModel}
                    onChange={(e) =>
                      setLocalSettings((prev) => ({ ...prev, whisperModel: e.target.value }))
                    }
                  >
                    <option value="large-v3">Large v3 (~3.1GB, best quality)</option>
                    <option value="large-v3-turbo">Large v3 Turbo (~1.6GB, balanced)</option>
                    <option value="distil-large-v3.5">Distil Large v3.5 (~1.5GB, fastest)</option>
                  </Select>
                </Flex>
              </Flex>

              <Flex alignItems="center" mt={3}>
                <Text fontSize="md" mr={4}>
                  Speaker diarization:
                </Text>
                <Switch
                  size="md"
                  isChecked={localSettings.useDiarization}
                  onChange={handleDiarizationChange}
                />
              </Flex>
              <Text fontSize="sm" color="gray.500">
                Labels speakers in local transcripts (Speaker 1, Speaker 2, ...).
              </Text>

              {localSettings.useDiarization && (
                <>
                  <Flex alignItems="center" mt={3}>
                    <Flex flex={1}>
                      <Text fontSize="md" mr={4}>
                        Max speakers:
                      </Text>
                    </Flex>
                    <Flex flex={2}>
                      <Input
                        type="number"
                        min={1}
                        max={12}
                        value={localSettings.maxSpeakers}
                        onChange={handleMaxSpeakersChange}
                      />
                    </Flex>
                  </Flex>

                  <Flex alignItems="center" mt={3}>
                    <Flex flex={1}>
                      <Text fontSize="md" mr={4}>
                        Post-diarization language:
                      </Text>
                    </Flex>
                    <Flex flex={2}>
                      <Select
                        size="md"
                        value={localSettings.polishLanguageMode}
                        onChange={(e) =>
                          setLocalSettings((prev) => ({
                            ...prev,
                            polishLanguageMode: e.target.value as "keep_original" | "translate",
                          }))
                        }
                      >
                        <option value="keep_original">Nessuna modifica lingua</option>
                        <option value="translate">Traduci nella lingua scelta</option>
                      </Select>
                    </Flex>
                  </Flex>

                  {localSettings.polishLanguageMode === "translate" && (
                    <Flex alignItems="center" mt={3}>
                      <Flex flex={1}>
                        <Text fontSize="md" mr={4}>
                          Target language:
                        </Text>
                      </Flex>
                      <Flex flex={2}>
                        <Input
                          value={localSettings.polishTargetLanguage}
                          onChange={(e) =>
                            setLocalSettings((prev) => ({
                              ...prev,
                              polishTargetLanguage: e.target.value,
                            }))
                          }
                          placeholder="Italian"
                        />
                      </Flex>
                    </Flex>
                  )}
                </>
              )}
            </>
          )}
          {!localSettings.useLocalTranscription && (
            <Flex alignItems="center" mt={3}>
              <Flex flex={1}>
                <Text fontSize="md">Cloud Transcription Model:</Text>
              </Flex>
              <Flex flex={2}>
                <Input
                  value={localSettings.transcriptionModel}
                  onChange={(e) =>
                    setLocalSettings((prev) => ({ ...prev, transcriptionModel: e.target.value }))
                  }
                  placeholder="whisper-1 (leave empty for default)"
                />
              </Flex>
            </Flex>
          )}
        </Box>

        <Box>
          <Text fontSize="md" mb={2}>
            AI Endpoint:
          </Text>
          <Flex alignItems="center" mb={2}>
            <Flex flex={1}>
              <Text fontSize="md">Type:</Text>
            </Flex>
            <Flex flex={2}>
              <Select
                size="md"
                value={localSettings.apiChoice}
                onChange={handleApiChoiceChange}
              >
                <option value="claude">Claude (Anthropic)</option>
                <option value="openai">OpenAI / Compatible</option>
                <option value="gemini">Gemini (Google)</option>
                <option value="local">Local (Ollama)</option>
              </Select>
            </Flex>
          </Flex>

          {/* Endpoint-specific config */}
          {localSettings.apiChoice === "claude" && (
            <Flex alignItems="center" mb={2}>
              <Flex flex={1}>
                <Text fontSize="md">API Key:</Text>
              </Flex>
              <Flex flex={2}>
                <Input
                  value={localSettings.apiKeyClaude}
                  onChange={onChangeClaueApiKey}
                  placeholder="sk-ant-..."
                />
              </Flex>
            </Flex>
          )}

          {localSettings.apiChoice === "openai" && (
            <>
              <Flex alignItems="center" mb={2}>
                <Flex flex={1}>
                  <Text fontSize="md">API Key:</Text>
                </Flex>
                <Flex flex={2}>
                  <Input
                    value={localSettings.apiKeyOpenAi}
                    onChange={onChangeOpenAiApiKey}
                    placeholder="sk-..."
                  />
                </Flex>
              </Flex>
              <Flex alignItems="center" mb={2}>
                <Flex flex={1}>
                  <Text fontSize="md">Base URL:</Text>
                </Flex>
                <Flex flex={2}>
                  <Input
                    value={localSettings.openAiApiBase}
                    onChange={(e) =>
                      setLocalSettings((prev) => ({ ...prev, openAiApiBase: e.target.value }))
                    }
                    placeholder="https://api.openai.com/v1 (optional)"
                  />
                </Flex>
              </Flex>
            </>
          )}

          {localSettings.apiChoice === "gemini" && (
            <Flex alignItems="center" mb={2}>
              <Flex flex={1}>
                <Text fontSize="md">API Key:</Text>
              </Flex>
              <Flex flex={2}>
                <Input
                  value={localSettings.apiKeyGemini}
                  onChange={onChangeGeminiApiKey}
                  placeholder="AIza..."
                />
              </Flex>
            </Flex>
          )}

          {localSettings.apiChoice === "local" && (
            <Flex alignItems="center" mb={2}>
              <Flex flex={1}>
                <Text fontSize="md">Ollama URL:</Text>
              </Flex>
              <Flex flex={2}>
                <Input
                  value={localSettings.localModelUrl}
                  onChange={onChangeLocalModelUrl}
                  placeholder="http://localhost:11434"
                />
              </Flex>
            </Flex>
          )}

          {/* Model selector */}
          {localSettings.apiChoice !== "local" && (
            <Flex alignItems="center" mb={2}>
              <Flex flex={1}>
                <Text fontSize="md">Model:</Text>
              </Flex>
              <Flex flex={2}>
                <Select
                  size="md"
                  value={getModelValue()}
                  onChange={(e) => setModelValue(e.target.value)}
                >
                  <option value="">Default (auto-select)</option>
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </Select>
              </Flex>
            </Flex>
          )}

          {localSettings.apiChoice === "local" && availableModels.length > 0 && (
            <Flex alignItems="center" mb={2}>
              <Flex flex={1}>
                <Text fontSize="md">Model:</Text>
              </Flex>
              <Flex flex={2}>
                <Select
                  size="md"
                  value={getModelValue()}
                  onChange={(e) => setModelValue(e.target.value)}
                >
                  <option value="">Default (auto-select)</option>
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </Select>
              </Flex>
            </Flex>
          )}

          {localSettings.apiChoice === "local" && modelsLoading && (
            <Flex alignItems="center" mt={2}>
              <Spinner size="sm" mr={2} />
              <Text fontSize="sm" color="gray.500">Loading models...</Text>
            </Flex>
          )}

          <Text fontSize="sm" color="gray.500" mt={2}>
            {localSettings.apiChoice === "local"
              ? "Use Ollama for local models. Models are detected automatically."
              : "Leave model empty to use the default for this provider."}
          </Text>
        </Box>

        <Box>
          <Flex alignItems="center" mb={2}>
            <Text fontSize="md" mr={4}>
              ElevenLabs API Key:
            </Text>
            <Flex flex={2}>
              <Input
                value={localSettings.apiKeyElevenlabs}
                onChange={(e) =>
                  setLocalSettings((prev) => ({ ...prev, apiKeyElevenlabs: e.target.value }))
                }
                placeholder="Required for podcast generation"
              />
            </Flex>
          </Flex>
        </Box>

        <Box>
          <Flex alignItems="center" mb={2}>
            <Text fontSize="md" mr={4}>
              Enable Document Indexing:
            </Text>
            <Switch
              size="md"
              isChecked={localSettings.vectorizationEnabled}
              onChange={handleVectorizationChange}
            />
          </Flex>
          <Text fontSize="sm" color="gray.500">
            When enabled, documents added to projects are automatically indexed using OpenAI embeddings.
            The AI will search within the selected project's documents to find relevant context for your questions.
            Requires OpenAI API key. When disabled, only explicitly selected documents are used as context.
          </Text>
        </Box>

        <Box>
          <Flex alignItems="center" mb={2}>
            <Flex flex={1}>
              <Text fontSize="md">
                RAG Context Chunks:
              </Text>
            </Flex>
            <Flex flex={2}>
              <Input
                type="number"
                value={localSettings.ragTopK}
                onChange={onChangeRagTopK}
                min={1}
                max={50}
                width="100px"
              />
            </Flex>
          </Flex>
          <Text fontSize="sm" color="gray.500">
            Number of document chunks to retrieve when searching for relevant context (1-50).
            Higher values provide more context but use more tokens. Default: 20.
          </Text>
        </Box>

        <Box>
          <Flex alignItems="center" mb={2}>
            <Text fontSize="md" mr={4}>
              Meeting Detection:
            </Text>
            <Switch
              size="md"
              isChecked={localSettings.meetingDetectionEnabled}
              onChange={handleMeetingDetectionChange}
            />
          </Flex>
          <Text fontSize="sm" color="gray.500">
            When enabled, Platypus will detect when you join a meeting on Zoom,
            Teams, or Slack and offer to start recording.
          </Text>
        </Box>

        <Box>
          <Text fontSize="lg" fontWeight="semibold" mb={4}>
            LLM System Prompts
          </Text>
          <Text fontSize="sm" color="gray.500" mb={4}>
            Customize the system prompts used for AI-powered document processing.
            Leave blank to use built-in defaults.
          </Text>

          <PromptField
            label="Note Cleanup"
            description="Used when cleaning up raw notes into organized markdown."
            settingKey="promptCleanupSystem"
            placeholder="You are a note cleanup assistant. Clean up the following raw text into well-organized markdown: ..."
            rows={6}
          />

          <PromptField
            label="Note Title Generation"
            description="Used to generate short titles for imported voice notes."
            settingKey="promptNoteTitleSystem"
            placeholder="You generate short titles for imported voice notes. ..."
            rows={4}
          />

          <PromptField
            label="Transcript Cleanup"
            description="Used when polishing raw transcripts into clean markdown."
            settingKey="promptTranscriptCleanup"
            placeholder="You are a transcript cleanup assistant. ..."
            rows={6}
            showPlaceholderHint
          />

          <PromptField
            label="Meeting Summary"
            description="Used when summarizing raw notes into structured meeting notes."
            settingKey="promptMeetingSummarySystem"
            placeholder="You are a meeting notes assistant. Transform the following raw text into concise meeting notes in markdown: ..."
            rows={6}
          />

          <PromptField
            label="Slide Deck Generation"
            description="Used when generating slide decks from documents (JSON output format)."
            settingKey="promptSlidesSystem"
            placeholder="You are an expert at turning documents into clear, well-structured slide decks. ..."
            rows={8}
          />

          <PromptField
            label="Podcast Script"
            description="Used when generating podcast narration scripts from documents."
            settingKey="promptPodcastScriptSystem"
            placeholder="You are a podcast scriptwriter. Turn the user's document into a single-voice narration ..."
            rows={6}
          />
        </Box>

        <Flex
          justifyContent="flex-end"
          position="sticky"
          bottom={0}
          bg="white"
          pt={4}
          pb={2}
          borderTop="1px solid"
          borderTopColor="gray.100"
          mt={2}
        >
          <Button colorScheme="teal" size="md" onClick={onSave}>
            Save
          </Button>
        </Flex>
      </VStack>
    </Box>
  );
};
