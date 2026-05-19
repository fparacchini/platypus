import { type FC, useState, useMemo, useRef, useEffect } from "react";
import styled from "styled-components";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { 
  Box, 
  Menu, 
  MenuButton, 
  MenuList, 
  MenuItem, 
  IconButton, 
  Flex, 
  Badge,
  Tooltip,
  Divider,
  Input,
  InputGroup,
  InputLeftElement,
  Text as ChakraText,
  Tag,
  AlertDialog,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogOverlay,
  Button,
  useDisclosure,
  useToast,
  Spinner,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from "@chakra-ui/react";
import {
  Search,
  File,
  Trash2,
  Edit,
  X,
  MoreHorizontal,
  FilePlus,
  FileUp,
  FolderPlus,
  Mic,
  ClipboardPaste,
  Link as LinkIcon,
  RefreshCcw,
} from 'lucide-react';
import { useGlobalSettings } from "../../Providers/SettingsProvider";
import { Text } from "@hermeneia-app/design";
import { useProject } from "../../state";
import { ProjectModal } from "@/components";
import { type Project } from "../../data/project";

type DiarizedSegment = {
  speaker_id: number;
  text: string;
  start_ms?: number | null;
  end_ms?: number | null;
  language?: string | null;
};

type TranscriptionResult = {
  text: string;
  segments: DiarizedSegment[];
};

type AudioImportProcessedResult = {
  note_html: string;
  raw_text: string;
  diarization_json: string | null;
  note_title: string;
  polish_applied: boolean;
  polished_text: string | null;
  diarization_model: string | null;
  synthesis_model: string | null;
  polish_language_mode: string | null;
  polish_target_language: string | null;
};

type AudioImportProgressEvent = {
  file_path: string;
  stage: string;
  progress: number;
  detail: string;
};

type ImportUiState = {
  active: boolean;
  stage: string;
  detail: string;
  currentFile: string;
  percent: number;
  completed: number;
  total: number;
  etaSeconds: number | null;
};

const SPEAKER_COLORS = ["teal.600", "purple.600", "orange.600", "blue.600", "pink.600", "green.600"];
const speakerColor = (speakerId: number) => SPEAKER_COLORS[(speakerId - 1) % SPEAKER_COLORS.length] || "teal.600";

const escapeHtml = (input: string) =>
  input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatRawDiarizedTranscript = (segments: DiarizedSegment[], fallbackText: string) => {
  if (!segments.length) return fallbackText;
  return segments.map((s) => `Speaker ${s.speaker_id}: ${s.text}`).join("\n");
};

const buildPolishedRawDocumentHtml = (polishedText: string, rawText: string) => {
  const polished = escapeHtml(polishedText).replace(/\n/g, "<br/>");
  const raw = escapeHtml(rawText);
  return `<h2>Polished transcript</h2><p>${polished}</p><hr/><h3>Raw transcript</h3><pre style="white-space: pre-wrap;">${raw}</pre>`;
};

const buildRawOnlyDocumentHtml = (rawText: string) => {
  const raw = escapeHtml(rawText);
  return `<h3>Raw transcript</h3><pre style="white-space: pre-wrap;">${raw}</pre>`;
};

const getImportStageLabel = (stage: string) => {
  const normalized = stage.trim().toLowerCase();
  switch (normalized) {
    case "queued":
      return "Queued";
    case "starting-audio":
      return "Starting audio import";
    case "validating":
      return "Validating file";
    case "transcribing":
      return "Transcribing audio (may take a minute)";
    case "titling":
      return "Generating title";
    case "diarizing":
      return "Detecting speakers";
    case "polishing":
      return "Polishing transcript";
    case "extracting":
      return "Extracting document text";
    case "saving":
      return "Saving note and metadata";
    case "completed-file":
      return "File completed";
    case "failed-file":
      return "File failed";
    case "completed":
      return "Completed";
    default:
      return stage;
  }
};

const IMPORT_PHASES = [
  {
    label: "Preparazione",
    stages: ["queued", "starting-audio", "validating"],
  },
  {
    label: "Elaborazione",
    stages: ["transcribing", "extracting", "titling", "diarizing", "polishing"],
  },
  {
    label: "Salvataggio",
    stages: ["saving", "completed-file", "failed-file", "completed"],
  },
];

const getImportPhaseIndex = (stage: string) => {
  const normalized = stage.trim().toLowerCase();
  const index = IMPORT_PHASES.findIndex((phase) => phase.stages.includes(normalized));
  return index >= 0 ? index : 0;
};

const getSegmentFill = (overallProgress: number, segmentIndex: number, totalSegments: number) =>
  Math.min(1, Math.max(0, overallProgress * totalSegments - segmentIndex));

//
// -- Styled Components --
const Container = styled(Box)`
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: var(--space-l);
  gap: var(--space-l);
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
  overflow: hidden;
  height: 100%;
`;

const StyledMenuButton = styled(MenuButton)`
  background-color: white;
  border: 1px solid var(--chakra-colors-gray-200);
  border-radius: var(--chakra-radii-md);
  padding: 8px 12px;
  height: 40px;
  display: flex;
  align-items: center;
  width: 100%;
  transition: all 0.2s;
  
  &:hover {
    background-color: var(--chakra-colors-gray-50);
    border-color: var(--chakra-colors-gray-300);
  }
  
  &:focus {
    box-shadow: 0 0 0 2px var(--chakra-colors-blue-100);
    border-color: var(--chakra-colors-blue-500);
  }
`;

const ScrollableMenuList = styled(MenuList)`
  max-height: 300px;
  overflow-y: auto;
  
  /* Custom scrollbar styling */
  &::-webkit-scrollbar {
    width: 8px;
  }
  
  &::-webkit-scrollbar-track {
    background: var(--chakra-colors-gray-100);
    border-radius: 4px;
  }
  
  &::-webkit-scrollbar-thumb {
    background: var(--chakra-colors-gray-300);
    border-radius: 4px;
  }
  
  &::-webkit-scrollbar-thumb:hover {
    background: var(--chakra-colors-gray-400);
  }
`;

const DocumentsContainer = styled(Box)`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-radius: var(--chakra-radii-md);
  will-change: scroll-position;

  /* Custom scrollbar styling */
  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--chakra-colors-gray-200);
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: var(--chakra-colors-gray-300);
  }
`;

const ProjectHeader = styled(Box)`
  background-color: var(--chakra-colors-gray-50);
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--chakra-colors-gray-600);
  border-bottom: 1px solid var(--chakra-colors-gray-200);
`;

const DocumentName = styled(ChakraText)`
  font-size: 14px;
  line-height: 1.4;
  font-weight: 400;
  color: var(--chakra-colors-gray-800);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 40px; /* 2 lines * line height */
  max-width: calc(100% - 60px); /* Added more space for the three dots menu */
  padding-right: 4px; /* Extra padding to ensure separation */
`;

const ProjectTag = styled(Tag)`
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  background-color: var(--chakra-colors-gray-100);
  color: var(--chakra-colors-gray-600);
  z-index: 1;
`;

const UnassignedTag = styled(Tag)`
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  background-color: var(--chakra-colors-gray-100);
  color: var(--chakra-colors-gray-500);
  font-style: italic;
  z-index: 1;
`;

const SearchContainer = styled(Box)`
  margin-bottom: 10px;
`;

const truncateDocumentName = (name: string, maxLength: number = 30) => {
  if (name.length <= maxLength) return name;
  return `${name.substring(0, maxLength)}...`;
};

const UNASSIGNED_PROJECT_NAME = "Unassigned";

// DeleteProjectButton component for project deletion
const DeleteProjectButton: FC<{
  project: Project;
  onDelete: (project: Project) => void;
}> = ({ project, onDelete }) => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const cancelRef = useRef(null);
  
  return (
    <>
      <Tooltip label="Delete this project">
        <IconButton
          aria-label="Delete project"
          icon={<Trash2 size={16} />}
          size="sm"
          variant="ghost"
          onClick={onOpen}
        />
      </Tooltip>
      
      <AlertDialog
        isOpen={isOpen}
        leastDestructiveRef={cancelRef}
        onClose={onClose}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">
              Delete Project
            </AlertDialogHeader>
            
            <AlertDialogBody>
              Are you sure you want to delete "{project.name}"? 
              This action cannot be undone.
            </AlertDialogBody>
            
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={onClose}>
                Cancel
              </Button>
              <Button 
                colorScheme="red" 
                onClick={() => {
                  onDelete(project);
                  onClose();
                }} 
                ml={3}
              >
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </>
  );
};

//
// -- Main Export --
export const Projects: FC<{
  selectedActivityId: number | null;
  onSelectActivity: (activityId: number | null) => void;
}> = ({ selectedActivityId, onSelectActivity }) => {
  const { 
    state, 
    selectProject, 
    addProject, 
    deleteProject, 
    updateProject,
    updateActivityName,
    addBlankActivity,
    addUnassignedActivity,
    deleteActivity,
    moveActivity,
    refreshProjects,
  } = useProject();
  
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<null | number>(null);

  const currentProject = useMemo(() => 
    state.projects.find(p => p.id === state.selectedProject),
    [state.projects, state.selectedProject]
  );

  // Filter out the unassigned project for the dropdown
  const visibleProjects = useMemo(() => 
    state.projects.filter(p => p.name !== UNASSIGNED_PROJECT_NAME),
    [state.projects]
  );

  const handleProjectSelect = (project: Project) => {
    selectProject(project.id);
  };

  const handleUnselectProject = () => {
    selectProject(undefined);
  };

  const handleNewProject = () => {
    setSelectedProjectId(null);
    setModalOpen(true);
  };

  const handleEditProject = (project: Project) => {
    setSelectedProjectId(project.id);
    setModalOpen(true);
  };

  const handleDeleteProject = (project: Project) => {
    deleteProject(project.id);
    if (state.selectedProject === project.id) {
      selectProject(undefined);
    }
  };

  const handleClose = () => {
    setModalOpen(false);
    setSelectedProjectId(null);
  };

  const handleActivitySelect = (activityId: number) => {
    onSelectActivity(activityId);
  };

  return (
    <Container>
      <ProjectSelector
        projects={visibleProjects}
        allProjects={state.projects}
        selectedProject={currentProject}
        onSelectProject={handleProjectSelect}
        onUnselectProject={handleUnselectProject}
        onNewProject={handleNewProject}
        onEditProject={handleEditProject}
        onDeleteProject={handleDeleteProject}
        selectedActivityId={selectedActivityId}
        onSelectActivity={handleActivitySelect}
        onUpdateActivityName={updateActivityName}
        onAddBlankActivity={addBlankActivity}
        onAddUnassignedActivity={addUnassignedActivity}
        onDeleteActivity={deleteActivity}
        onRefreshProjects={refreshProjects}
      />
      
      <ProjectModal
        isOpen={modalOpen}
        projectId={selectedProjectId}
        onClose={handleClose}
        onUpdate={updateProject}
        onSave={addProject}
      />
    </Container>
  );
};

//
// -- ProjectSelector Component --
type ActivityDocument = {
  id: number;
  activity_id: number | null;
  name: string;
  projectId: number;
  projectName: string;
};

const ProjectSelector: FC<{
  projects: Project[];
  allProjects: Project[];
  selectedProject: Project | undefined;
  onSelectProject: (project: Project) => void;
  onUnselectProject: () => void;
  onNewProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  selectedActivityId: number | null;
  onSelectActivity: (activityId: number) => void;
  onUpdateActivityName: (activityId: number, name: string) => void;
  onAddBlankActivity: () => Promise<number | undefined>;
  onAddUnassignedActivity: () => Promise<number | undefined>;
  onDeleteActivity: (activityId: number) => void;
  onRefreshProjects: () => void;
}> = ({
  projects,
  allProjects,
  selectedProject,
  onSelectProject,
  onUnselectProject,
  onNewProject,
  onEditProject,
  onDeleteProject,
  selectedActivityId,
  onSelectActivity,
  onUpdateActivityName,
  onAddBlankActivity,
  onAddUnassignedActivity,
  onDeleteActivity,
  onRefreshProjects,
}) => {
  const [editingActivityId, setEditingActivityId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [documentSearchTerm, setDocumentSearchTerm] = useState("");
  
  // Voice note recording states
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isPreparingRecording, setIsPreparingRecording] = useState(false);
  const [isProcessingRecording, setIsProcessingRecording] = useState(false);
  const [recordingFilePath, setRecordingFilePath] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [liveSegments, setLiveSegments] = useState<DiarizedSegment[]>([]);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [isIngestingUrl, setIsIngestingUrl] = useState(false);
  const [isRediarizingId, setIsRediarizingId] = useState<number | null>(null);
  const [importUi, setImportUi] = useState<ImportUiState>({
    active: false,
    stage: "",
    detail: "",
    currentFile: "",
    percent: 0,
    completed: 0,
    total: 0,
    etaSeconds: null,
  });
  const [, setElapsedTicker] = useState(0);
  const lastEtaRef = useRef<number | null>(null);
  const recordingStartTime = useRef<number | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptUnlistenRef = useRef<(() => void) | null>(null);
  const finalSegmentsRef = useRef<DiarizedSegment[]>([]);
  const importStartRef = useRef<number | null>(null);
  const currentImportFileRef = useRef<string>("");
  const completedImportsRef = useRef<number>(0);
  const totalImportsRef = useRef<number>(0);
  
  const toast = useToast();
  const { settings } = useGlobalSettings();

  // Filter projects by name
  const filteredProjects = useMemo(() => {
    if (!searchTerm.trim()) return projects;
    return projects.filter((p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [projects, searchTerm]);

  // Build filtered + sorted document list (no pagination — render all at once)
  const sortedDocuments = useMemo(() => {
    const allDocs: ActivityDocument[] = selectedProject
      ? selectedProject.activities.map((_, index) => ({
          id: selectedProject.activities[index],
          activity_id: selectedProject.activity_ids[index],
          name: selectedProject.activity_names[index]
            || "Untitled Note",
          projectId: selectedProject.id,
          projectName: selectedProject.name,
        }))
      : allProjects.flatMap(project =>
          project.activities.map((_, index) => ({
            id: project.activities[index],
            activity_id: project.activity_ids[index],
            name: project.activity_names[index]
              || "Untitled Note",
            projectId: project.id,
            projectName: project.name,
          }))
        );

    const filtered = documentSearchTerm.trim()
      ? allDocs.filter(doc =>
          doc.name.toLowerCase().includes(documentSearchTerm.toLowerCase()) ||
          doc.projectName.toLowerCase().includes(documentSearchTerm.toLowerCase())
        )
      : allDocs;

    return filtered.sort((a, b) => b.id - a.id);
  }, [selectedProject, allProjects, documentSearchTerm]);

  // Start renaming a document
  const handleStartEdit = (activity: { id: number; name: string }) => {
    setEditingActivityId(activity.id);
    setEditingName(activity.name);
  };

  // Save document name change
  const handleSaveEdit = () => {
    if (editingActivityId && editingName.trim()) {
      onUpdateActivityName(editingActivityId, editingName.trim());
      setEditingActivityId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      setEditingActivityId(null);
    }
  };

  // Create a new document in selected or unassigned project
  const handleAddNewDocument = async () => {
    let newActivityId;

    if (selectedProject) {
      newActivityId = await onAddBlankActivity();
    } else {
      newActivityId = await onAddUnassignedActivity();
    }

    if (newActivityId) {
      onSelectActivity(newActivityId);
    }
  };

  // Handle file import (documents + audio) - supports multiple files
  const handleFileImport = async () => {
    let unlistenProgress: (() => void) | null = null;
    try {
      // Open file dialog to select files (multiple allowed)
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Supported files',
          extensions: ['pdf', 'docx', 'txt', 'md', 'rtf', 'ogg', 'wav', 'mp3']
        }],
      });

      if (!selected) return;

      // Normalize to array
      const filePaths = Array.isArray(selected) ? selected : [selected];
      if (filePaths.length === 0) return;

      importStartRef.current = Date.now();
      totalImportsRef.current = filePaths.length;
      completedImportsRef.current = 0;
      setImportUi({
        active: true,
        stage: "queued",
        detail: "Preparing import pipeline",
        currentFile: "",
        percent: 0,
        completed: 0,
        total: filePaths.length,
        etaSeconds: null,
      });

      unlistenProgress = await listen<AudioImportProgressEvent>("audio-import-progress", (event) => {
        const payload = event.payload;
        if (!payload || payload.file_path !== currentImportFileRef.current) return;
        updateImportUi(payload.stage, payload.detail, payload.progress);
      });

      let successCount = 0;
      let lastActivityId: number | undefined;
      const failedImports: string[] = [];

      for (const filePath of filePaths) {
        try {
          currentImportFileRef.current = filePath;
          const extension = (filePath.split('.').pop() || '').toLowerCase();
          const isAudioImport = ['ogg', 'wav', 'mp3'].includes(extension);

          let extractedText: string;
          let documentName: string;
          let diarizationJson: string | null = null;
          let polishApplied = true;
          let polishedText: string | null = null;
          let diarizationModel: string | null = null;
          let synthesisModel: string | null = null;
          let polishLanguageMode: string | null = null;
          let polishTargetLanguage: string | null = null;

          if (isAudioImport) {
            updateImportUi("starting-audio", "Starting audio processing", 0.02);
            const result = await invoke<AudioImportProcessedResult>('import_audio_file_enriched', { filePath });
            extractedText = result.note_html;
            documentName = result.note_title;
            diarizationJson = result.diarization_json;
            polishApplied = result.polish_applied;
            polishedText = result.polished_text;
            diarizationModel = result.diarization_model;
            synthesisModel = result.synthesis_model;
            polishLanguageMode = result.polish_language_mode;
            polishTargetLanguage = result.polish_target_language;
          } else {
            // Document extraction with heartbeat progress
            updateImportUi("extracting", "Extracting document text", 0.15);
            
            // Spawn heartbeat task to show progress while extracting
            let extractionDone = false;
            const heartbeatInterval = setInterval(() => {
              if (!extractionDone) {
                const total = Math.max(1, totalImportsRef.current);
                const completed = completedImportsRef.current;
                let currentProgress = (completed + 0.15) / total;
                currentProgress = Math.min(0.60, currentProgress + 0.025); // Gradually increase up to 60%
                const currentName = currentImportFileRef.current.split('/').pop()
                  || currentImportFileRef.current.split('\\').pop()
                  || currentImportFileRef.current;
                setImportUi(prev => ({
                  ...prev,
                  percent: Math.round(currentProgress * 100),
                  detail: "Extracting document text",
                  currentFile: currentName,
                }));
              }
            }, 500);
            
            try {
              extractedText = await invoke<string>('extract_document_text', { filePath });
            } finally {
              extractionDone = true;
              clearInterval(heartbeatInterval);
            }
            
            const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || '';
            documentName = fileName.includes('.')
              ? fileName.substring(0, fileName.lastIndexOf('.'))
              : fileName;
          }

          // Create new activity
          let newActivityId;
          if (selectedProject) {
            newActivityId = await onAddBlankActivity();
          } else {
            newActivityId = await onAddUnassignedActivity();
          }

          if (newActivityId && extractedText) {
            updateImportUi("saving", "Saving note and metadata", isAudioImport ? 0.95 : 0.85);
            // Update activity name and content
            await onUpdateActivityName(newActivityId, documentName);

            // Save the extracted text
            await invoke("update_project_activity_text", {
              activityId: newActivityId,
              text: extractedText
            });

            if (diarizationJson) {
              await invoke("update_project_activity_transcript_workspace_data", {
                activityId: newActivityId,
                rawSegmentsJson: diarizationJson,
                polishedText,
                diarizationModel,
                synthesisModel,
                sourceLanguage: "original",
                targetLanguage: polishTargetLanguage || settings.polish_target_language,
                polishLanguageMode: polishLanguageMode || settings.polish_language_mode,
              });
            }

            // Vectorize chunks (if enabled)
            invoke("vectorize_document_chunks", { documentId: newActivityId })
              .catch(e => console.log('Vectorization skipped:', e));

            if (isAudioImport && !polishApplied) {
              toast({
                title: "Imported with raw transcript",
                description: "Diarization saved, but polish was unavailable for this file.",
                status: "warning",
                duration: 3500,
                isClosable: true,
              });
            }

            lastActivityId = newActivityId;
            successCount++;
          }

          completedImportsRef.current += 1;
          updateImportUi("completed-file", "File completed", 1.0);
        } catch (error) {
          console.error(`Error importing ${filePath}:`, error);
          failedImports.push(`${filePath}: ${String(error)}`);
          completedImportsRef.current += 1;
          updateImportUi("failed-file", "File failed", 1.0);
        }
      }

      if (successCount > 0) {
        // Select the last imported document
        if (lastActivityId) {
          onSelectActivity(lastActivityId);
        }

        toast({
          title: "Import successful",
          description: successCount === 1
            ? "1 document has been imported successfully."
            : `${successCount} documents have been imported successfully.`,
          status: "success",
          duration: 3000,
          isClosable: true,
        });

        if (failedImports.length > 0) {
          toast({
            title: "Some files failed to import",
            description: failedImports[0],
            status: "warning",
            duration: 7000,
            isClosable: true,
          });
        }
      } else {
        toast({
          title: "Import failed",
          description: failedImports[0] || "Failed to import documents. Please try again.",
          status: "error",
          duration: 5000,
          isClosable: true,
        });
      }
    } catch (error) {
      console.error("Error selecting files:", error);
      toast({
        title: "File selection failed",
        description: "Could not open file dialog. Please try again.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    } finally {
      if (unlistenProgress) {
        unlistenProgress();
      }
      setTimeout(() => {
        setImportUi({
          active: false,
          stage: "",
          detail: "",
          currentFile: "",
          percent: 0,
          completed: 0,
          total: 0,
          etaSeconds: null,
        });
      }, 800);
      importStartRef.current = null;
      lastEtaRef.current = null;
      currentImportFileRef.current = "";
      completedImportsRef.current = 0;
      totalImportsRef.current = 0;
    }
  };

  // Voice note helper: format recording time as mm:ss
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatEta = (seconds: number | null) => {
    if (seconds === null || seconds < 0) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatElapsed = (startTime: number | null) => {
    if (!startTime) return "0:00";
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const updateImportUi = (stage: string, detail: string, fileProgress: number) => {
    const total = Math.max(1, totalImportsRef.current);
    const completed = completedImportsRef.current;
    const overall = Math.min(1, Math.max(0, (completed + fileProgress) / total));
    const elapsed = importStartRef.current ? (Date.now() - importStartRef.current) / 1000 : 0;

    // Smoothed ETA: only allows decreasing or small +5s drift per update
    let etaSeconds: number | null = null;
    if (overall > 0.05 && elapsed > 1) {
      const rawEta = Math.max(0, Math.round((elapsed / overall) - elapsed));
      const prev = lastEtaRef.current;
      if (prev === null) {
        etaSeconds = rawEta;
      } else {
        etaSeconds = Math.min(prev + 5, rawEta);
      }
      lastEtaRef.current = etaSeconds;
    }

    const currentName = currentImportFileRef.current.split('/').pop()
      || currentImportFileRef.current.split('\\').pop()
      || currentImportFileRef.current;

    setImportUi({
      active: true,
      stage,
      detail,
      currentFile: currentName,
      percent: Math.round(overall * 100),
      completed,
      total,
      etaSeconds,
    });
  };

  // Start voice recording
  const startRecording = async () => {
    const useLocal = settings.use_local_transcription;

    // For OpenAI mode, check API key before showing loading
    if (!useLocal && !settings.api_key_open_ai) {
      toast({
        title: "API key required",
        description: "An OpenAI API key is required for voice note transcription. Please add it in Settings.",
        status: "warning",
        duration: 5000,
        isClosable: true,
      });
      return;
    }

    setIsPreparingRecording(true);

    try {
      // For local mode, ensure model is ready
      if (useLocal) {
        const modelReady = await invoke<boolean>('check_whisper_model');
        if (!modelReady) {
          setIsDownloadingModel(true);
          setDownloadProgress(0);
          const progressUnlisten = await listen<{ percent: number }>("model-download-progress", (event) => {
            setDownloadProgress(event.payload.percent);
          });
          try {
            await invoke('download_whisper_model');
          } finally {
            progressUnlisten();
            setIsDownloadingModel(false);
          }
        }
        await invoke('init_whisper_model');

        if (settings.use_diarization) {
          const diarizationReady = await invoke<boolean>('check_diarization_model');
          if (!diarizationReady) {
            setIsDownloadingModel(true);
            setDownloadProgress(0);
            const progressUnlisten = await listen<{ percent: number }>("diarization-download-progress", (event) => {
              setDownloadProgress(event.payload.percent);
            });
            try {
              await invoke('download_diarization_model');
            } finally {
              progressUnlisten();
              setIsDownloadingModel(false);
            }
          }
          await invoke('init_diarization_model');
        }
      }

      // Reset audio state
      setRecordingFilePath(null);
      setRecordingTime(0);
      setLiveTranscript("");
      setLiveSegments([]);
      finalSegmentsRef.current = [];

      // Start recording via Tauri
      const result = await invoke<string>('start_audio_recording', { useLocal });
      if (!useLocal) {
        setRecordingFilePath(result);
      }
      console.log("Recording started, mode:", useLocal ? "local" : "openai");

      // Listen for live transcript updates in local mode
      if (useLocal) {
        const unlisten = await listen<{ text: string; chunk_text?: string; speaker_id?: number; start_ms?: number; end_ms?: number; segments?: DiarizedSegment[]; is_final: boolean }>("transcript-update", (event) => {
          setLiveTranscript(event.payload.text);
          if (event.payload.is_final && event.payload.segments) {
            finalSegmentsRef.current = event.payload.segments;
            setLiveSegments(event.payload.segments);
            return;
          }

          if (event.payload.speaker_id && event.payload.chunk_text) {
            setLiveSegments((prev) => [
              ...prev,
              {
                speaker_id: event.payload.speaker_id!,
                text: event.payload.chunk_text!,
                start_ms: event.payload.start_ms ?? null,
                end_ms: event.payload.end_ms ?? null,
              },
            ]);
          }
        });
        transcriptUnlistenRef.current = unlisten;
      }

      // Start timer
      recordingStartTime.current = Date.now();
      recordingTimerRef.current = setInterval(() => {
        if (recordingStartTime.current) {
          const elapsedSeconds = Math.floor((Date.now() - recordingStartTime.current) / 1000);
          setRecordingTime(elapsedSeconds);
        }
      }, 1000);

      setIsRecording(true);
      setIsPreparingRecording(false);
    } catch (error) {
      console.error("Failed to start recording:", error);
      setIsPreparingRecording(false);
      toast({
        title: "Recording failed",
        description: "Could not start voice recording. Please try again.",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  };

  // Stop voice recording and auto-transcribe
  const stopRecording = async () => {
    const useLocal = settings.use_local_transcription;

    try {
      setIsProcessingRecording(true);
      setIsRecording(false);
      setIsTranscribing(true);

      // Stop timer
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      if (recordingStartTime.current) {
        recordingStartTime.current = null;
      }

      let transcription: string;
      let textToSave: string;
      let polishedTextForWorkspace: string | null = null;

      if (useLocal) {
        // Local mode: stop returns the final transcript directly
        transcription = await invoke<string>('stop_audio_recording', { useLocal: true });
        setIsProcessingRecording(false);
      } else {
        // OpenAI mode: stop returns file path, then transcribe separately
        const filePath = await invoke<string>('stop_audio_recording', { useLocal: false });
        setRecordingFilePath(filePath);
        setIsProcessingRecording(false);
        console.log("Recording stopped, file path:", filePath);

        const isOaiDiarization = settings.diarization_mode === "openai";
        if (isOaiDiarization) {
          const result = await invoke<TranscriptionResult>('transcribe_audio_with_segments', { filePath });
          transcription = result.text;
          if (result.segments.length > 0) {
            finalSegmentsRef.current = result.segments;
          }
        } else {
          transcription = await invoke<string>('transcribe_audio', { filePath });
        }
      }

      textToSave = transcription;

      const shouldAutoPolishDiarized =
        (settings.use_local_transcription && settings.use_diarization)
        || settings.diarization_mode === "openai";

      if (shouldAutoPolishDiarized) {
        const rawText = formatRawDiarizedTranscript(finalSegmentsRef.current, transcription);
        try {
          const polished = await invoke<string>('auto_polish_diarized_transcript', {
            rawText,
          });
          polishedTextForWorkspace = polished;
          textToSave = buildPolishedRawDocumentHtml(polished, rawText);
        } catch (polishError) {
          console.warn('Auto-polish failed, saving raw transcript:', polishError);
          textToSave = buildRawOnlyDocumentHtml(rawText);
          toast({
            title: "Polish failed",
            description: "Saved raw transcript only. You can retry polish manually.",
            status: "warning",
            duration: 4000,
            isClosable: true,
          });
        }
      }

      // Create a new activity with the transcription
      let newActivityId;
      if (selectedProject) {
        newActivityId = await onAddBlankActivity();
      } else {
        newActivityId = await onAddUnassignedActivity();
      }

      if (newActivityId) {
        const date = new Date();
        const documentName = `Voice Note ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;

        // Update name and content in DB
        await invoke("update_project_activity_name", {
          activityId: newActivityId,
          name: documentName,
        });
        await invoke("update_project_activity_text", {
          activityId: newActivityId,
          text: textToSave,
        });

        if (settings.use_local_transcription && settings.use_diarization && finalSegmentsRef.current.length > 0) {
          const synthesisModel = settings.api_choice === "openai"
            ? `openai:${settings.model_openai || "gpt-5.4"}`
            : settings.api_choice === "gemini"
              ? `gemini:${settings.model_gemini || "gemini-3-pro-preview"}`
              : settings.api_choice === "local"
                ? "local:llama3.3:70b"
                : `claude:${settings.model_claude || "claude-sonnet-4-6"}`;

          await invoke("update_project_activity_transcript_workspace_data", {
            activityId: newActivityId,
            rawSegmentsJson: JSON.stringify(finalSegmentsRef.current),
            polishedText: polishedTextForWorkspace,
            diarizationModel: "local:streaming-diarizer-v1",
            synthesisModel,
            sourceLanguage: "original",
            targetLanguage: settings.polish_target_language,
            polishLanguageMode: settings.polish_language_mode,
          });
        }

        // Refresh state so sidebar shows the correct name
        onRefreshProjects();

        invoke("vectorize_document_chunks", { documentId: newActivityId })
          .catch(e => console.log('Vectorization skipped:', e));

        setRecordingFilePath(null);
        setRecordingTime(0);
        setLiveTranscript("");
        setLiveSegments([]);
        finalSegmentsRef.current = [];

        toast({
          title: "Transcription complete",
          description: "Voice note has been transcribed and saved successfully",
          status: "success",
          duration: 3000,
          isClosable: true,
        });

        onSelectActivity(newActivityId);
      }
    } catch (error) {
      console.error("Failed to record/transcribe:", error);
      toast({
        title: "Recording error",
        description: String(error).includes("API key")
          ? "OpenAI API key is required for audio transcription. Please add it in Settings."
          : "An error occurred. Please try again.",
        status: "error",
        duration: 5000,
        isClosable: true,
      });
    } finally {
      if (transcriptUnlistenRef.current) {
        transcriptUnlistenRef.current();
        transcriptUnlistenRef.current = null;
      }
      setIsProcessingRecording(false);
      setIsTranscribing(false);
      setRecordingTime(0);
    }
  };

  // Listen for toggle_recording event (from system tray or meeting detection banner)
  useEffect(() => {
    const unlisten = listen("toggle_recording", () => {
      if (!isRecording) {
        startRecording();
      } else {
        stopRecording();
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [isRecording]);

  // Tick elapsed time display every second during import
  useEffect(() => {
    if (!importUi.active) return;
    const interval = setInterval(() => {
      setElapsedTicker(t => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [importUi.active]);

  // Handle paste events to create new documents from clipboard content
  const handlePaste = async (e: React.ClipboardEvent) => {
    e.preventDefault();
    
    // Check for image files in clipboard
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    
    // Handle pasted images
    if (imageItems.length > 0) {
      console.log(`Found ${imageItems.length} images in clipboard`);
      
      const imagePromises = imageItems.map(async (item) => {
        const file = item.getAsFile();
        if (!file) return null;
        
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            resolve(`<img src="${dataUrl}" alt="Pasted image" style="max-width: 100%;" />`);
          };
          reader.readAsDataURL(file);
        });
      });
      
      const imageHtmlArray = await Promise.all(imagePromises);
      const imagesHtml = imageHtmlArray.filter(Boolean).join('<br/>');
      
      if (imagesHtml) {
        let newActivityId;
        if (selectedProject) {
          newActivityId = await onAddBlankActivity();
        } else {
          newActivityId = await onAddUnassignedActivity();
        }
        
        if (newActivityId) {
          await onUpdateActivityName(newActivityId, 'Pasted Images');
          await invoke("update_project_activity_text", {
            activityId: newActivityId,
            text: imagesHtml
          });
          
          // Vectorize chunks (if enabled)
          invoke("vectorize_document_chunks", { documentId: newActivityId })
            .catch(e => console.log('Vectorization skipped:', e));
          
          onSelectActivity(newActivityId);
          
          toast({
            title: "Images pasted",
            description: "Images have been saved to a new document",
            status: "success",
            duration: 2000,
            isClosable: true,
          });
        }
        return;
      }
    }
    
    // Try to get HTML content first, fall back to plain text
    let content = e.clipboardData.getData('text/html');
    const isHtml = !!content.trim();
    
    if (!isHtml) {
      content = e.clipboardData.getData('text');
    }
    
    const plainText = e.clipboardData.getData('text');
    
    if (content.trim()) {
      console.log('Paste event detected, isHtml:', isHtml);
      
      try {
        let newActivityId;
        if (selectedProject) {
          newActivityId = await onAddBlankActivity();
        } else {
          newActivityId = await onAddUnassignedActivity();
        }
        
        if (newActivityId) {
          // Generate document name from first line of plain text
          const firstLine = plainText.split('\n')[0].trim();
          const documentName = firstLine.length > 50 
            ? firstLine.substring(0, 47) + '...' 
            : firstLine || 'Pasted Document';
          
          await onUpdateActivityName(newActivityId, documentName);
          await invoke("update_project_activity_text", {
            activityId: newActivityId,
            text: content
          });
          
          // Vectorize chunks (if enabled)
          invoke("vectorize_document_chunks", { documentId: newActivityId })
            .catch(e => console.log('Vectorization skipped:', e));
          
          onSelectActivity(newActivityId);
          
          toast({
            title: "Content pasted",
            description: "Content has been saved to a new document",
            status: "success",
            duration: 2000,
            isClosable: true,
          });
        }
      } catch (error) {
        console.error('Error during paste processing:', error);
        toast({
          title: "Error processing paste",
          description: "Failed to process pasted content",
          status: "error",
          duration: 3000,
          isClosable: true,
        });
      }
    }
  };

  // Paste from clipboard via button click (uses navigator.clipboard API)
  const handleClipboardImport = async () => {
    try {
      // Try to read HTML first (preserves formatting), fall back to plain text
      let content = '';
      let plainText = '';
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
          if (item.types.includes('text/html')) {
            const blob = await item.getType('text/html');
            content = await blob.text();
          }
          if (item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            plainText = await blob.text();
          }
        }
      } catch {
        // Fallback to readText if read() is not supported
        plainText = await navigator.clipboard.readText();
      }

      if (!content.trim()) content = plainText;
      if (!plainText.trim()) plainText = content;

      if (!content.trim()) {
        toast({
          title: "Clipboard empty",
          description: "Nothing to paste",
          status: "warning",
          duration: 2000,
          isClosable: true,
        });
        return;
      }

      let newActivityId;
      if (selectedProject) {
        newActivityId = await onAddBlankActivity();
      } else {
        newActivityId = await onAddUnassignedActivity();
      }

      if (newActivityId) {
        const firstLine = plainText.split('\n')[0].trim();
        const documentName = firstLine.length > 50
          ? firstLine.substring(0, 47) + '...'
          : firstLine || 'Pasted Document';

        await onUpdateActivityName(newActivityId, documentName);
        await invoke("update_project_activity_text", {
          activityId: newActivityId,
          text: content,
        });

        invoke("vectorize_document_chunks", { documentId: newActivityId })
          .catch(e => console.log('Vectorization skipped:', e));

        onSelectActivity(newActivityId);

        toast({
          title: "Content pasted",
          description: "Clipboard content saved as a new document",
          status: "success",
          duration: 2000,
          isClosable: true,
        });
      }
    } catch (error) {
      console.error('Clipboard import error:', error);
      toast({
        title: "Clipboard access denied",
        description: "Please allow clipboard access and try again",
        status: "error",
        duration: 3000,
        isClosable: true,
      });
    }
  };

  // Fetch a URL, run it through Readability, and save the result as a new
  // document. Title comes from the page's <title>; the editor stores the
  // cleaned HTML and a "Source: <url>" footer so users can trace where
  // ingested content came from.
  const handleUrlImport = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    setIsIngestingUrl(true);
    try {
      const page = await invoke<{
        title: string;
        html: string;
        markdown: string;
        url: string;
      }>("ingest_url_command", { url: trimmed });

      let newActivityId: number | undefined;
      if (selectedProject) {
        newActivityId = await onAddBlankActivity();
      } else {
        newActivityId = await onAddUnassignedActivity();
      }

      if (!newActivityId) {
        throw new Error("Could not create new document");
      }

      const documentName = page.title.trim() || page.url;
      await onUpdateActivityName(newActivityId, documentName);

      const sourceFooter = `<p><br/></p><hr/><p><em>Source: <a href="${page.url}" target="_blank" rel="noopener noreferrer">${page.url}</a></em></p>`;
      const fullHtml = `${page.html}${sourceFooter}`;

      await invoke("update_project_activity_text", {
        activityId: newActivityId,
        text: fullHtml,
      });

      invoke("vectorize_document_chunks", { documentId: newActivityId })
        .catch((e) => console.log("Vectorization skipped:", e));

      onSelectActivity(newActivityId);
      setIsUrlModalOpen(false);
      setUrlInput("");

      toast({
        title: "Page imported",
        description: documentName.length > 60
          ? `${documentName.substring(0, 60)}...`
          : documentName,
        status: "success",
        duration: 3000,
        isClosable: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("URL import error:", message);
      toast({
        title: "Could not import URL",
        description: message,
        status: "error",
        duration: 6000,
        isClosable: true,
      });
    } finally {
      setIsIngestingUrl(false);
    }
  };

  // Select a document without forcing a project switch
  const handleDocumentSelect = (document: ActivityDocument) => {
    onSelectActivity(document.id);
  };

  // Delete a document
  const handleDeleteDocument = (e: React.MouseEvent, document: ActivityDocument) => {
    e.stopPropagation();
    onDeleteActivity(document.id);
  };

  const handleRediarizeDocument = async (e: React.MouseEvent, document: ActivityDocument) => {
    e.stopPropagation();
    try {
      setIsRediarizingId(document.id);
      const segments = await invoke<DiarizedSegment[]>("rediarize_existing_recording", {
        activityId: document.id,
      });

      onRefreshProjects();
      onSelectActivity(document.id);

      toast({
        title: "Diarization refreshed",
        description: `Created ${segments.length} speaker segments`,
        status: "success",
        duration: 3000,
        isClosable: true,
      });
    } catch (error) {
      toast({
        title: "Diarization failed",
        description: String(error),
        status: "error",
        duration: 5000,
        isClosable: true,
      });
    } finally {
      setIsRediarizingId(null);
    }
  };

  return (
    <Flex direction="column" w="full" gap={4} overflow="hidden" h="full">
      <Flex gap={2} w="full" align="center">
        <Menu>
          <Flex position="relative" w="full">
            <StyledMenuButton w="full">
              <Text type="m" bold>
                {selectedProject ? selectedProject.name : 'Select a Project'}
              </Text>
            </StyledMenuButton>

            {selectedProject && (
              <IconButton
                position="absolute"
                right="2"
                top="50%"
                transform="translateY(-50%)"
                aria-label="Unselect project"
                icon={<X size={14} />}
                size="xs"
                variant="ghost"
                zIndex="1"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onUnselectProject();
                }}
                _hover={{ bg: 'gray.100' }}
              />
            )}
          </Flex>

          <ScrollableMenuList minW="240px" w="240px" py={0}>
            {/* Sticky search box */}
            <Box 
              p={2} 
              h="56px" 
              display="flex" 
              alignItems="center" 
              position="sticky" 
              top="0" 
              bg="white" 
              zIndex="1"
            >
              <InputGroup size="sm">
                <InputLeftElement pointerEvents="none">
                  <Search size={14} color="var(--chakra-colors-gray-400)" />
                </InputLeftElement>
                <Input
                  placeholder="Search Projects..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                />
              </InputGroup>
            </Box>
            <Divider my={0} />

            {/* "Create New Project" at the top */}
            <MenuItem 
              icon={<FolderPlus size={16} />}
              onClick={onNewProject}
              p={3}
              h="40px"
            >
              <Text type="m">Create New Project</Text>
            </MenuItem>
            <Divider my={2} />

            <Box>
              {filteredProjects.map((project) => (
                <MenuItem 
                  key={project.id}
                  onClick={() => onSelectProject(project)}
                  p={3}
                  h="40px"
                >
                  <Flex justify="space-between" align="center" w="full">
                    <Text type="m">{project.name}</Text>
                    <Badge colorScheme="teal" ml={2}>
                      {project.activities.length} notes
                    </Badge>
                  </Flex>
                </MenuItem>
              ))}
            </Box>
          </ScrollableMenuList>
        </Menu>
        {/* Removed the separate "Create New Project" plus icon */}
      </Flex>

      {/* Document list section */}
      <Flex direction="column" w="full" flex={1} minH={0}>
        {importUi.active && (
          <Box mb={3} p={3} bg="blue.50" border="1px solid" borderColor="blue.100" borderRadius="md">
            {(() => {
              const totalSegments = IMPORT_PHASES.length;
              const overallProgress = Math.min(1, Math.max(0, importUi.percent / 100));
              return (
                <>
                  <Flex gap="2px" mb={2}>
                    {IMPORT_PHASES.map((phase, index) => {
                      const fill = getSegmentFill(overallProgress, index, totalSegments);
                      const textColor = fill > 0.45 ? "white" : "blue.800";
                      const clipPath =
                        index === 0
                          ? "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%)"
                          : index === totalSegments - 1
                            ? "polygon(14px 0, 100% 0, 100% 100%, 14px 100%, 0 50%)"
                            : "polygon(14px 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 14px 100%, 0 50%)";

                      return (
                        <Box
                          key={phase.label}
                          flex={1}
                          h="44px"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          sx={{
                            clipPath,
                            background: `linear-gradient(90deg, #0E6A8A 0%, #0E6A8A ${fill * 100}%, #CFE8F1 ${fill * 100}%, #CFE8F1 100%)`,
                          }}
                        >
                          <ChakraText fontSize="lg" fontWeight="700" color={textColor}>
                            {index + 1}
                          </ChakraText>
                        </Box>
                      );
                    })}
                  </Flex>

                  <Flex justify="space-between" align="center">
                    <ChakraText fontSize="xs" color="blue.800" maxW="78%" isTruncated>
                      {importUi.currentFile || ""}
                    </ChakraText>
                    <ChakraText fontSize="xs" color="blue.700">
                      {importUi.etaSeconds === null ? "Stima in corso" : `Mancano ~${formatEta(importUi.etaSeconds)}`}
                    </ChakraText>
                  </Flex>
                </>
              );
            })()}
          </Box>
        )}

        <Flex justify="space-between" align="center" mb={3}>
          <Text type="m" bold>
            {selectedProject ? `${selectedProject.name} Notes` : "All Notes"}
          </Text>

          <Flex gap={2}>
            {/* Button for creating a new note */}
            <Tooltip label="Create a new note">
              <IconButton
                aria-label="Add new note"
                icon={<FilePlus size={16} />}
                size="sm"
                variant="ghost"
                onClick={handleAddNewDocument}
              />
            </Tooltip>

            {/* Combined import menu — file or URL in one place */}
            <Menu>
              <Tooltip label="Import">
                <MenuButton
                  as={IconButton}
                  aria-label="Import"
                  icon={<FileUp size={16} />}
                  size="sm"
                  variant="ghost"
                />
              </Tooltip>
              <MenuList>
                <MenuItem icon={<FileUp size={14} />} onClick={handleFileImport}>
                  Import file… <ChakraText as="span" color="gray.500" fontSize="xs" ml={2}>PDF, DOCX, TXT, MD, OGG, WAV, MP3</ChakraText>
                </MenuItem>
                <MenuItem icon={<LinkIcon size={14} />} onClick={() => setIsUrlModalOpen(true)}>
                  Import from URL…
                </MenuItem>
              <MenuItem icon={<MoreHorizontal size={14} />} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                About…
              </MenuItem>
              </MenuList>
            </Menu>

            {/* Button for pasting from clipboard */}
            <Tooltip label="Paste from clipboard">
              <IconButton
                aria-label="Paste from clipboard"
                icon={<ClipboardPaste size={16} />}
                size="sm"
                variant="ghost"
                onClick={handleClipboardImport}
              />
            </Tooltip>

            {/* Only show delete button when a project is selected */}
            {selectedProject && (
              <DeleteProjectButton
                project={selectedProject}
                onDelete={onDeleteProject}
              />
            )}
          </Flex>
        </Flex>
        
        <SearchContainer mb={3}>
          <InputGroup size="md">
            <InputLeftElement pointerEvents="none">
              <Search size={16} color="var(--chakra-colors-gray-400)" />
            </InputLeftElement>
            <Input
              placeholder="Search notes..."
              value={documentSearchTerm}
              onChange={(e) => setDocumentSearchTerm(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck="false"
              borderRadius="full"
              _focus={{
                boxShadow: "0 0 0 1px var(--chakra-colors-teal-400)",
                borderColor: "teal.400"
              }}
            />
          </InputGroup>
        </SearchContainer>

        <DocumentsContainer 
          onPaste={handlePaste}
          tabIndex={0}
          _focus={{ outline: 'none' }}
        >
          <Box>
            {sortedDocuments.length > 0 ? (
              <>
                {sortedDocuments.map((document) => (
                  <Flex
                    key={document.id}
                    p={3}
                    mb={1}
                    borderRadius="md"
                    align="center"
                    justify="space-between"
                    _hover={{ bg: 'gray.50' }}
                    transition="all 0.2s"
                    bg={selectedActivityId === document.id ? 'teal.50' : 'white'}
                    borderLeft={selectedActivityId === document.id ? '3px solid' : '3px solid transparent'}
                    borderLeftColor={selectedActivityId === document.id ? 'teal.400' : 'transparent'}
                    onClick={() => editingActivityId !== document.id && handleDocumentSelect(document)}
                    cursor="pointer"
                    position="relative"
                    minHeight="55px"
                    role="group"
                  >
                    <Flex align="center" gap={3} flex={1}>
                      <Box color="gray.500">
                        <File size={16} />
                      </Box>
                      <Box flex={1}>
                        {editingActivityId === document.id ? (
                          <Input
                            value={editingName}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditingName(e.target.value)}
                            onBlur={handleSaveEdit}
                            onKeyDown={handleKeyDown}
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            autoFocus
                            size="sm"
                            variant="unstyled"
                          />
                        ) : (
                          <Box>
                            <DocumentName>
                              {truncateDocumentName(document.name)}
                            </DocumentName>
                            
                            {/* Show project tag only if no project filter is applied */}
                            {!selectedProject && (
                              document.projectName === UNASSIGNED_PROJECT_NAME ? (
                                <></>
                              ) : (
                                <ProjectTag size="sm" variant="subtle">
                                  {document.projectName}
                                </ProjectTag>
                              )
                            )}
                          </Box>
                        )}
                      </Box>
                    </Flex>
                    
                    {/* Three dots menu in the top-right corner */}
                    {!editingActivityId && (
                      <Menu placement="bottom-end" isLazy strategy="fixed">
                        <MenuButton
                          as={IconButton}
                          aria-label="Document options"
                          icon={<MoreHorizontal size={14} />}
                          size="xs"
                          variant="ghost"
                          opacity="0"
                          _groupHover={{ opacity: 1 }}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          position="absolute"
                          top="2"
                          right="2"
                        />
                        <MenuList minW="120px">
                          <MenuItem
                            icon={<RefreshCcw size={14} />}
                            isDisabled={isRediarizingId === document.id}
                            onClick={(e: React.MouseEvent) => handleRediarizeDocument(e, document)}
                          >
                            {isRediarizingId === document.id ? "Re-diarizing..." : "Redo diarization"}
                          </MenuItem>
                          <MenuItem
                            icon={<Edit size={14} />}
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              handleStartEdit(document);
                            }}
                          >
                            Rename
                          </MenuItem>
                          <MenuItem
                            icon={<Trash2 size={14} />}
                            onClick={(e: React.MouseEvent) => handleDeleteDocument(e, document)}
                            color="red.500"
                          >
                            Delete
                          </MenuItem>
                        </MenuList>
                      </Menu>
                    )}
                  </Flex>
                ))}
                
              </>
            ) : (
              <Flex 
                justify="center" 
                align="center" 
                p={8}
                color="gray.500"
                flexDirection="column"
                gap={2}
              >
                <File size={24} />
                <Text type="m">
                  {documentSearchTerm
                    ? "No matching notes found"
                    : selectedProject
                      ? "No notes yet - create one!"
                      : "No notes yet - start writing!"}
                </Text>
              </Flex>
            )}
          </Box>
        </DocumentsContainer>
      </Flex>

      {/* Pinned voice recording button at bottom */}
      <Box flexShrink={0} pt={2} borderTop="1px solid" borderTopColor="gray.100">
        {isDownloadingModel && (
          <Flex align="center" gap={2} bg="blue.50" borderRadius="full" px={4} py={2} justify="center">
            <Spinner size="xs" color="blue.500" />
            <ChakraText fontSize="sm" fontWeight="500" color="blue.600">
              Downloading model... {downloadProgress}%
            </ChakraText>
          </Flex>
        )}

        {!isRecording && !isTranscribing && !isDownloadingModel && (
          <Button
            leftIcon={isPreparingRecording ? undefined : <Mic size={18} />}
            onClick={startRecording}
            borderRadius="full"
            size="md"
            variant="outline"
            colorScheme="gray"
            w="full"
            fontWeight="500"
            _hover={{ bg: "gray.50" }}
            isLoading={isPreparingRecording}
            loadingText="Starting..."
            isDisabled={isPreparingRecording}
          >
            Record voice note
          </Button>
        )}

        {isRecording && (
          <Box>
            <Flex align="center" gap={2} bg="red.50" borderRadius="full" px={4} py={2}>
              <Box
                w="8px" h="8px" borderRadius="full" bg="red.500"
                animation="pulse 1.5s ease-in-out infinite"
                sx={{ '@keyframes pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.3 } } }}
              />
              <ChakraText fontSize="sm" fontWeight="500" color="red.600" flex={1}>
                {formatTime(recordingTime)}
              </ChakraText>
              <Button size="xs" colorScheme="red" borderRadius="full" onClick={stopRecording}
                isLoading={isProcessingRecording} loadingText="Stopping...">
                Stop
              </Button>
            </Flex>
            {settings.use_local_transcription && liveTranscript && (
              <Box mt={2} px={3} py={2} bg="gray.50" borderRadius="md" maxH="100px" overflowY="auto">
                {settings.use_diarization && liveSegments.length > 0 ? (
                  liveSegments.slice(-10).map((segment, idx) => (
                    <ChakraText key={`${segment.speaker_id}-${idx}`} fontSize="xs" color="gray.600" mb={1}>
                      <ChakraText as="span" fontWeight="700" color={speakerColor(segment.speaker_id)}>
                        Speaker {segment.speaker_id}:
                      </ChakraText>{" "}
                      {segment.text}
                    </ChakraText>
                  ))
                ) : (
                  <ChakraText fontSize="xs" color="gray.600" fontStyle="italic">
                    {liveTranscript}
                  </ChakraText>
                )}
              </Box>
            )}
          </Box>
        )}

        {isTranscribing && (
          <Flex align="center" gap={2} bg="teal.50" borderRadius="full" px={4} py={2} justify="center">
            <Spinner size="xs" color="teal.500" />
            <ChakraText fontSize="sm" fontWeight="500" color="teal.600">
              Transcribing...
            </ChakraText>
          </Flex>
        )}
      </Box>

      {/* URL ingestion modal — fetches a page, runs Readability, saves as a new note. */}
      <Modal
        isOpen={isUrlModalOpen}
        onClose={() => {
          if (isIngestingUrl) return;
          setIsUrlModalOpen(false);
          setUrlInput("");
        }}
        isCentered
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Import from URL</ModalHeader>
          <ModalCloseButton isDisabled={isIngestingUrl} />
          <ModalBody>
            <Input
              autoFocus
              placeholder="https://example.com/article"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isIngestingUrl) {
                  handleUrlImport();
                }
              }}
              isDisabled={isIngestingUrl}
            />
            <ChakraText mt={2} fontSize="xs" color="gray.500">
              We'll extract the main article content and save it as a new note.
              JavaScript-rendered pages may not work.
            </ChakraText>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="ghost"
              mr={3}
              onClick={() => {
                setIsUrlModalOpen(false);
                setUrlInput("");
              }}
              isDisabled={isIngestingUrl}
            >
              Cancel
            </Button>
            <Button
              colorScheme="teal"
              onClick={handleUrlImport}
              isLoading={isIngestingUrl}
              loadingText="Fetching..."
              isDisabled={!urlInput.trim()}
            >
              Import
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Flex>
  );
};