import { FC, useState, useEffect, useCallback } from "react";
import {
  Menu,
  MenuButton,
  MenuList,
  MenuItem,
  Button,
  Flex,
  Text,
  Spinner,
  IconButton,
} from "@chakra-ui/react";
import { ChevronDownIcon, RepeatIcon } from "@chakra-ui/icons";
import { useGlobalSettings } from "../../../Providers/SettingsProvider";
import { invoke } from "@tauri-apps/api/tauri";

type ModelOption = {
  id: string;
  name: string;
  provider: "claude" | "openai" | "gemini" | "local";
  description: string;
};

type ModelSelectorProps = {
  onModelChange: (modelId: string, provider: "claude" | "openai" | "gemini" | "local") => void;
  currentModel?: string;
};

export const ModelSelector: FC<ModelSelectorProps> = ({
  onModelChange,
  currentModel: externalCurrentModel,
}) => {
  const { settings } = useGlobalSettings();
  const [currentModel, setCurrentModel] = useState<string>("");
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [loadingLocalModels, setLoadingLocalModels] = useState(false);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [loadingOpenaiModels, setLoadingOpenaiModels] = useState(false);
  const [openaiModelError, setOpenaiModelError] = useState<string | null>(null);

  // Cloud models per provider
  const cloudModels: ModelOption[] = [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "claude", description: "Best balance of speed & smarts" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "claude", description: "Most capable Anthropic model" },
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", description: "Latest OpenAI flagship" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro", provider: "gemini", description: "Google's latest multimodal" },
  ];

  const provider = settings.api_choice;

  // Initialize model
  useEffect(() => {
    if (externalCurrentModel) {
      setCurrentModel(externalCurrentModel);
    } else {
      const defaultModel = (() => {
        switch (provider) {
          case "claude": return settings.model_claude || "claude-sonnet-4-6";
          case "openai": return settings.model_openai || "gpt-5.4";
          case "gemini": return settings.model_gemini || "gemini-3-pro-preview";
          case "local": return "llama3.3:70b";
          default: return settings.model_claude || "claude-sonnet-4-6";
        }
      })();
      setCurrentModel(defaultModel);
    }
  }, [externalCurrentModel, provider, settings.model_claude, settings.model_openai, settings.model_gemini]);

  // Fetch Ollama models when provider is "local"
  useEffect(() => {
    if (provider !== "local") {
      setLocalModels([]);
      return;
    }

    let cancelled = false;
    setLoadingLocalModels(true);

    invoke<string[]>("list_local_models")
      .then((result) => {
        if (!cancelled) {
          setLocalModels(result);
          setLoadingLocalModels(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalModels([]);
          setLoadingLocalModels(false);
        }
      });

    return () => { cancelled = true; };
  }, [provider]);

  // Fetch OpenAI-compatible models when provider is "openai"
  const fetchOpenaiModels = useCallback(() => {
    if (provider !== "openai") {
      setOpenaiModels([]);
      setOpenaiModelError(null);
      return;
    }

    let cancelled = false;
    setLoadingOpenaiModels(true);
    setOpenaiModelError(null);

    invoke<string[]>("list_openai_models")
      .then((result) => {
        if (!cancelled) {
          setOpenaiModels(result);
          setOpenaiModelError(null);
          setLoadingOpenaiModels(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setOpenaiModels([]);
          setOpenaiModelError(error?.message || error || "Failed to fetch models from endpoint");
          setLoadingOpenaiModels(false);
        }
      });

    return () => { cancelled = true; };
  }, [provider]);

  useEffect(() => {
    fetchOpenaiModels();
  }, [provider, fetchOpenaiModels]);

  // Build the filtered model list
  const availableModels: ModelOption[] = (() => {
    const cloud = cloudModels.filter(m => m.provider === provider);

    if (provider === "local") {
      if (localModels.length > 0) {
        return localModels.map(name => ({
          id: name,
          name,
          provider: "local" as const,
          description: "Local model via Ollama",
        }));
      }
      return [{
        id: "llama3.3:70b",
        name: "llama3.3:70b (default)",
        provider: "local" as const,
        description: "Ollama — no models detected, running default",
      }];
    }

    if (provider === "openai") {
      if (openaiModels.length > 0) {
        return openaiModels.map(modelId => ({
          id: modelId,
          name: modelId,
          provider: "openai" as const,
          description: "Available via OpenAI-compatible endpoint",
        }));
      }
      if (openaiModelError) {
        return [{
          id: "__error__",
          name: "⚠ Could not load models",
          provider: "openai" as const,
          description: openaiModelError,
        }];
      }
      return cloud;
    }

    return cloud;
  })();

  const hasFetchedModels = provider === "openai" && openaiModels.length > 0;

  const handleModelChange = (modelId: string) => {
    if (modelId === "__error__") return;
    setCurrentModel(modelId);
    const selectedModel = availableModels.find(m => m.id === modelId);
    if (selectedModel) {
      onModelChange(modelId, selectedModel.provider);
    }
  };

  const currentModelInfo = availableModels.find(m => m.id === currentModel);

  return (
    <Flex alignItems="center">
      <Menu>
        <MenuButton
          as={Button}
          rightIcon={<ChevronDownIcon />}
          size="sm"
          variant="outline"
          fontWeight="normal"
          minW="180px"
          justifyContent="space-between"
        >
          <Text fontSize="sm" isTruncated flex={1}>
            {currentModelInfo ? currentModelInfo.name : "Select Model"}
          </Text>
        </MenuButton>
        <MenuList maxH="300px" overflowY="auto">
          {loadingOpenaiModels && provider === "openai" ? (
            <Flex justifyContent="center" py={3} gap={2}>
              <Spinner size="sm" />
              <Text fontSize="xs" color="gray.500">Loading models from endpoint...</Text>
            </Flex>
          ) : loadingLocalModels && provider === "local" ? (
            <Flex justifyContent="center" py={3} gap={2}>
              <Spinner size="sm" />
              <Text fontSize="xs" color="gray.500">Loading models...</Text>
            </Flex>
          ) : (
            <>
              {availableModels.map((model) => (
                <MenuItem
                  key={model.id}
                  onClick={() => handleModelChange(model.id)}
                  fontSize="sm"
                  color={model.id === "__error__" ? "red.500" : "inherit"}
                >
                  <Flex direction="column">
                    <Text fontWeight={currentModel === model.id ? "bold" : "normal"}>
                      {model.name}
                    </Text>
                    <Text fontSize="xs" color="gray.500">{model.description}</Text>
                  </Flex>
                </MenuItem>
              ))}
              {provider === "openai" && openaiModelError && (
                <MenuItem onClick={fetchOpenaiModels} fontSize="sm" color="blue.500">
                  <Flex alignItems="center" gap={2}>
                    <RepeatIcon boxSize="12px" />
                    <Text>Retry fetching models</Text>
                  </Flex>
                </MenuItem>
              )}
            </>
          )}
        </MenuList>
      </Menu>
      {provider === "openai" && hasFetchedModels && (
        <IconButton
          icon={<RepeatIcon boxSize="12px" />}
          size="xs"
          variant="ghost"
          ml={2}
          aria-label="Refresh models"
          onClick={fetchOpenaiModels}
          title="Refresh model list"
        />
      )}
    </Flex>
  );
};
