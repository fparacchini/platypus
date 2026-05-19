import { Box, Flex, Text, Switch, Input, Button } from "@chakra-ui/react";
import { useLocalSettings } from "./SettingsTypes";

type PromptKey =
  | "promptCleanupSystem"
  | "promptNoteTitleSystem"
  | "promptTranscriptCleanup"
  | "promptMeetingSummarySystem"
  | "promptSlidesSystem"
  | "promptPodcastScriptSystem";

export const GeneralSettings = () => {
  const { localSettings, setLocalSettings, update } = useLocalSettings();

  const updateSetting = (key: string, value: any) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    update({
      ...localSettings,
      [key.replace(/([A-Z])/g, "_$1").toLowerCase()]: value,
    } as any);
  };

  const resetPrompt = (key: PromptKey) => {
    setLocalSettings((prev) => ({ ...prev, [key]: "" }));
    update({
      ...localSettings,
      [key.replace(/([A-Z])/g, "_$1").toLowerCase()]: "",
    } as any);
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
        onChange={(e) => updateSetting(settingKey, e.target.value)}
        placeholder={placeholder}
      />
    </Box>
  );

  return (
    <Box>
      <Flex direction="column" gap={8} align="stretch">
        <Box>
          <Flex alignItems="center" mb={2}>
            <Text fontSize="md" mr={4}>
              Autostart Platypus:
            </Text>
            <Switch
              size="md"
              isChecked={localSettings.autoStart}
              onChange={(e) => updateSetting("autoStart", e.target.checked)}
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
              ElevenLabs API Key:
            </Text>
            <Flex flex={2}>
              <Input
                value={localSettings.apiKeyElevenlabs}
                onChange={(e) => updateSetting("apiKeyElevenlabs", e.target.value)}
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
              onChange={(e) => updateSetting("vectorizationEnabled", e.target.checked)}
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
                onChange={(e) => {
                  const value = Number.parseInt(e.target.value, 10) || 20;
                  updateSetting("ragTopK", Math.max(1, Math.min(50, value)));
                }}
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
              onChange={(e) => updateSetting("meetingDetectionEnabled", e.target.checked)}
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
          <Button colorScheme="teal" size="md" onClick={() => update(localSettings as any)}>
            Save
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
};
