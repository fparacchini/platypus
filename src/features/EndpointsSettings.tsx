import { Flex, Text, Input, Select } from "@chakra-ui/react";
import { useLocalSettings } from "./SettingsTypes";

export const EndpointsSettings = () => {
  const { localSettings, setLocalSettings, update } = useLocalSettings();

  const handleApiChoiceChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const apiChoice = event.target.value as typeof localSettings.apiChoice;
    // Reset irrelevant fields
    const resetMap: Record<string, string> = {
      claude: "apiKeyOpenAi,openAiApiBase,apiKeyGemini,localModelUrl",
      openai: "apiKeyClaude,apiKeyGemini,localModelUrl",
      gemini: "apiKeyClaude,apiKeyOpenAi,localModelUrl",
      local: "apiKeyClaude,apiKeyOpenAi,apiKeyGemini",
    };
    const fieldsToReset = resetMap[apiChoice]?.split(",") ?? [];
    setLocalSettings((prev) => {
      const resetObj: Record<string, string> = {};
      fieldsToReset.forEach((key) => {
        resetObj[key] = "";
      });
      return { ...prev, apiChoice, ...resetObj };
    });
    update({
      ...localSettings,
      api_choice: apiChoice,
      ...Object.fromEntries(
        fieldsToReset.map((key) => [
          key.replace(/([A-Z])/g, "_$1").toLowerCase(),
          "",
        ])
      ),
    } as any);
  };

  const updateField = (key: string, value: string) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    update({
      ...localSettings,
      [key.replace(/([A-Z])/g, "_$1").toLowerCase()]: value,
    } as any);
  };

  return (
    <>
      <Flex alignItems="center" mb={4}>
        <Text fontSize="md" flex={1}>
          Endpoint Type:
        </Text>
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

      {localSettings.apiChoice === "claude" && (
        <Flex alignItems="center" mb={4}>
          <Text fontSize="md" flex={1}>
            API Key:
          </Text>
          <Flex flex={2}>
            <Input
              value={localSettings.apiKeyClaude}
              onChange={(e) => updateField("apiKeyClaude", e.target.value)}
              placeholder="sk-ant-..."
            />
          </Flex>
        </Flex>
      )}

      {localSettings.apiChoice === "openai" && (
        <>
          <Flex alignItems="center" mb={4}>
            <Text fontSize="md" flex={1}>
              API Key:
            </Text>
            <Flex flex={2}>
              <Input
                value={localSettings.apiKeyOpenAi}
                onChange={(e) => updateField("apiKeyOpenAi", e.target.value)}
                placeholder="sk-..."
              />
            </Flex>
          </Flex>
          <Flex alignItems="center" mb={4}>
            <Text fontSize="md" flex={1}>
              Base URL:
            </Text>
            <Flex flex={2}>
              <Input
                value={localSettings.openAiApiBase}
                onChange={(e) =>
                  updateField("openAiApiBase", e.target.value)
                }
                placeholder="https://api.openai.com/v1 (optional)"
              />
            </Flex>
          </Flex>
        </>
      )}

      {localSettings.apiChoice === "gemini" && (
        <Flex alignItems="center" mb={4}>
          <Text fontSize="md" flex={1}>
            API Key:
          </Text>
          <Flex flex={2}>
            <Input
              value={localSettings.apiKeyGemini}
              onChange={(e) => updateField("apiKeyGemini", e.target.value)}
              placeholder="AIza..."
            />
          </Flex>
        </Flex>
      )}

      {localSettings.apiChoice === "local" && (
        <Flex alignItems="center" mb={4}>
          <Text fontSize="md" flex={1}>
            Ollama URL:
          </Text>
          <Flex flex={2}>
            <Input
              value={localSettings.localModelUrl}
              onChange={(e) =>
                updateField("localModelUrl", e.target.value)
              }
              placeholder="http://localhost:11434"
            />
          </Flex>
        </Flex>
      )}
    </>
  );
};
