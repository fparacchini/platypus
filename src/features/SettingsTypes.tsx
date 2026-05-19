import { useEffect, useState } from "react";
import { useGlobalSettings } from "../Providers/SettingsProvider";

export type ApiChoice = "claude" | "openai" | "gemini" | "local";

export type LocalSettings = {
  autoStart: boolean;
  apiChoice: ApiChoice;
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
  diarizationMode: "none" | "local" | "openai";
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

export type ModelOption = {
  id: string;
  name: string;
};

export const CLOUD_MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
];

export const WHISPER_MODELS: ModelOption[] = [
  { id: "large-v3", name: "Large v3 (~3.1GB, best quality)" },
  { id: "large-v3-turbo", name: "Large v3 Turbo (~1.6GB, balanced)" },
  { id: "distil-large-v3.5", name: "Distil Large v3.5 (~1.5GB, fastest)" },
];

export function useLocalSettings() {
  const { settings, update } = useGlobalSettings();
  const [localSettings, setLocalSettings] = useState<LocalSettings>({
    autoStart: settings.auto_start,
    apiChoice: settings.api_choice as ApiChoice,
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
    diarizationMode: settings.diarization_mode as "none" | "local" | "openai",
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

  useEffect(() => {
    setLocalSettings({
      autoStart: settings.auto_start,
      apiChoice: settings.api_choice as ApiChoice,
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
      diarizationMode: settings.diarization_mode as "none" | "local" | "openai",
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

  return { localSettings, setLocalSettings, update };
}
