import { useEffect, useState } from "react";
import {
  Box,
  Flex,
  Text,
  Select,
  Input,
  Switch,
  Spinner,
} from "@chakra-ui/react";
import { invoke } from "@tauri-apps/api/tauri";
import {
  useLocalSettings,
  CLOUD_MODELS,
  WHISPER_MODELS,
  type ApiChoice,
  type ModelOption,
} from "./SettingsTypes";

export const ModelsSettings = () => {
  const { localSettings, setLocalSettings, update } = useLocalSettings();
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Fetch available LLM models based on selected endpoint
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
      invoke("list_openai_models")
        .then((result) => {
          setAvailableModels(
            (result as any).map((id: string) => ({ id, name: id }))
          );
          setModelsLoading(false);
        })
        .catch(() => {
          const cloud = CLOUD_MODELS.filter((m) => m.id.includes("gpt"));
          setAvailableModels(cloud);
          setModelsLoading(false);
        });
      return;
    }

    if (apiChoice === "local") {
      setModelsLoading(true);
      invoke("list_local_models")
        .then((result) => {
          setAvailableModels(
            (result as any).map((name: string) => ({ id: name, name }))
          );
          setModelsLoading(false);
        })
        .catch(() => {
          setAvailableModels([]);
          setModelsLoading(false);
        });
      return;
    }
  }, [localSettings.apiChoice]);

  const getModelValue = (): string => {
    switch (localSettings.apiChoice) {
      case "claude":
        return localSettings.modelClaude || "";
      case "openai":
        return localSettings.modelOpenai || "";
      case "gemini":
        return localSettings.modelGemini || "";
      default:
        return "";
    }
  };

  const setModelValue = (value: string) => {
    switch (localSettings.apiChoice) {
      case "claude":
        setLocalSettings((prev) => ({ ...prev, modelClaude: value }));
        update({ ...localSettings, model_claude: value } as any);
        break;
      case "openai":
        setLocalSettings((prev) => ({ ...prev, modelOpenai: value }));
        update({ ...localSettings, model_openai: value } as any);
        break;
      case "gemini":
        setLocalSettings((prev) => ({ ...prev, modelGemini: value }));
        update({ ...localSettings, model_gemini: value } as any);
        break;
    }
  };

  const updateSetting = (key: string, value: any) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    update({
      ...localSettings,
      [key.replace(/([A-Z])/g, "_$1").toLowerCase()]: value,
    } as any);
  };

  return (
    <>
      {/* LLM Model */}
      <Box>
        <Text fontSize="lg" fontWeight="semibold" mb={2}>
          LLM Model
        </Text>
        <Text fontSize="sm" color="gray.500" mb={3}>
          Model used for chat, document processing, and AI responses.
        </Text>
        <Flex alignItems="center">
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
        {modelsLoading && (
          <Flex alignItems="center" mt={2}>
            <Spinner size="sm" mr={2} />
            <Text fontSize="sm" color="gray.500">
              Loading models...
            </Text>
          </Flex>
        )}
        <Text fontSize="sm" color="gray.500" mt={2}>
          {localSettings.apiChoice === "local"
            ? "Use Ollama for local models. Models are detected automatically."
            : "Leave model empty to use the default for this provider."}
        </Text>
      </Box>

      <hr style={{ border: "none", borderTop: "1px solid #eaeaea", margin: "24px 0" }} />

      {/* Speech Recognition */}
      <Box>
        <Text fontSize="lg" fontWeight="semibold" mb={2}>
          Speech Recognition
        </Text>
        <Text fontSize="sm" color="gray.500" mb={3}>
          Choose how audio is transcribed to text.
        </Text>

        <Flex alignItems="center" mb={3}>
          <Text fontSize="md" mr={4}>
            Use Local Transcription:
          </Text>
          <Switch
            size="md"
            isChecked={localSettings.useLocalTranscription}
            onChange={(e) => updateSetting("useLocalTranscription", e.target.checked)}
          />
        </Flex>
        <Text fontSize="sm" color="gray.500" mb={4}>
          Local transcription runs offline using a Whisper model. Cloud transcription uses the OpenAI API.
        </Text>

        {localSettings.useLocalTranscription && (
          <>
            <Flex alignItems="center" mb={3}>
              <Flex flex={1}>
                <Text fontSize="md">Whisper Model:</Text>
              </Flex>
              <Flex flex={2}>
                <Select
                  size="md"
                  value={localSettings.whisperModel}
                  onChange={(e) =>
                    updateSetting("whisperModel", e.target.value)
                  }
                >
                  {WHISPER_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Flex>
            </Flex>
          </>
        )}

        {!localSettings.useLocalTranscription && (
          <Flex alignItems="center" mb={3}>
            <Flex flex={1}>
              <Text fontSize="md">Cloud Transcription Model:</Text>
            </Flex>
            <Flex flex={2}>
              <Input
                value={localSettings.transcriptionModel}
                onChange={(e) =>
                  updateSetting("transcriptionModel", e.target.value)
                }
                placeholder="whisper-1 (leave empty for default)"
              />
            </Flex>
          </Flex>
        )}
      </Box>

      <hr style={{ border: "none", borderTop: "1px solid #eaeaea", margin: "24px 0" }} />

      {/* Diarization */}
      <Box>
        <Text fontSize="lg" fontWeight="semibold" mb={2}>
          Speaker Diarization
        </Text>
        <Text fontSize="sm" color="gray.500" mb={3}>
          Labels different speakers in the transcript (Speaker 1, Speaker 2, ...).
        </Text>

        <Flex alignItems="center" mb={3}>
          <Text fontSize="md" mr={4}>
            Enable Diarization:
          </Text>
          <Switch
            size="md"
            isChecked={localSettings.useDiarization}
            onChange={(e) => updateSetting("useDiarization", e.target.checked)}
          />
        </Flex>

        {localSettings.useDiarization && (
          <>
            <Flex alignItems="center" mb={2}>
              <Flex flex={1}>
                <Text fontSize="md">Diarization Mode:</Text>
              </Flex>
              <Flex flex={2}>
                <Select
                  size="md"
                  value={localSettings.diarizationMode}
                  onChange={(e) =>
                    updateSetting("diarizationMode", e.target.value)
                  }
                >
                  <option value="local">Local (WeSpeaker)</option>
                  <option value="openai">OpenAI API</option>
                </Select>
              </Flex>
            </Flex>
            <Text fontSize="xs" color="gray.500" mb={3}>
              {localSettings.diarizationMode === "openai"
                ? "Uses OpenAI Whisper API server-side diarization. Requires OpenAI API key."
                : "Uses local WeSpeaker model. No API key needed, works offline."}
            </Text>

            {localSettings.diarizationMode === "local" && (
              <>
                <Flex alignItems="center" mb={2}>
                  <Flex flex={1}>
                    <Text fontSize="md">Max Speakers:</Text>
                  </Flex>
                  <Flex flex={2}>
                    <Input
                      type="number"
                      min={1}
                      max={12}
                      value={localSettings.maxSpeakers}
                      onChange={(e) => {
                        const parsed = Number.parseInt(e.target.value, 10) || 6;
                        updateSetting("maxSpeakers", Math.max(1, Math.min(12, parsed)));
                      }}
                    />
                  </Flex>
                </Flex>

                <Flex alignItems="center" mb={2}>
                  <Flex flex={1}>
                    <Text fontSize="md">Post-diarization Language:</Text>
                  </Flex>
                  <Flex flex={2}>
                    <Select
                      size="md"
                      value={localSettings.polishLanguageMode}
                      onChange={(e) =>
                        updateSetting(
                          "polishLanguageMode",
                          e.target.value as "keep_original" | "translate"
                        )
                      }
                    >
                      <option value="keep_original">Nessuna modifica lingua</option>
                      <option value="translate">Traduci nella lingua scelta</option>
                    </Select>
                  </Flex>
                </Flex>

                {localSettings.polishLanguageMode === "translate" && (
                  <Flex alignItems="center" mb={3}>
                    <Flex flex={1}>
                      <Text fontSize="md">Target Language:</Text>
                    </Flex>
                    <Flex flex={2}>
                      <Input
                        value={localSettings.polishTargetLanguage}
                        onChange={(e) =>
                          updateSetting("polishTargetLanguage", e.target.value)
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
      </Box>
    </>
  );
};
