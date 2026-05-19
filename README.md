# Hermeneia

Hermeneia is an AI-powered note-taking, transcription, and knowledge management app. It captures audio from meetings and voice notes, transcribes them with speaker diarization, and uses LLMs to generate clean notes, summaries, slide decks, and podcast scripts.

A fork of [Platypus](https://github.com/pixelsmasher13/platypus).

Copyright (c) 2026 Altea S.p.A. — Tutti i diritti riservati.
Licensed under the MIT License (original Platypus code).

## Features

- **Audio Recording** — Record voice notes or auto-detect meetings (Zoom, Teams, Slack) and start recording automatically
- **Local & Cloud Transcription** — Run Whisper models locally (offline, no API key) or use OpenAI Whisper API
- **Speaker Diarization** — Label speakers (Speaker 1, Speaker 2, ...) using local WeSpeaker model or OpenAI server-side diarization
- **AI-Powered Cleanup** — Clean raw transcripts into organized markdown with configurable system prompts
- **Meeting Summaries** — Generate structured meeting notes from transcripts
- **Slide Decks** — Convert documents into presentation slides (JSON output)
- **Podcast Scripts** — Generate narration scripts from documents, with text-to-speech via ElevenLabs
- **Document Indexing (RAG)** — Index documents with OpenAI embeddings for contextual AI answers
- **Multi-Provider AI** — Claude, OpenAI, Gemini, or local Ollama models
- **Customizable Prompts** — Edit system prompts for every AI operation

## Acquisition Pipeline

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Recording   │────▶│ Transcription│────▶│   Diarization   │
│  (cpal/WAV)  │     │  (Whisper /  │     │  (WeSpeaker /   │
│              │     │   OpenAI API) │     │   OpenAI API)   │
└─────────────┘     └──────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌───────────────┐     ┌──────────────┐     ┌─────────────────────┐
│   Podcast     │     │   Cleanup &  │     │   Content Storage   │
│   Generation  │◀────│  Generation  │◀────│  (SQLite + HNSW     │
│  (ElevenLabs) │     │   (LLM)      │     │   vector index)     │
└───────────────┘     └──────────────┘     └─────────────────────┘
```

### 1. Audio Capture

Hermeneia records audio from the default microphone using **cpal** (Cross-Platform Audio Library). Audio is captured in real-time as 16-bit mono WAV files.

- **Manual recording** — Start/stop via the UI
- **Meeting detection** — Monitors running processes:
  - Zoom: detects `CptHost` process (active meeting indicator)
  - Teams: detects `MSTeams` or `Teams` processes
  - Slack: detects Slack window focus changes
- When a meeting is detected, a popup offers to start recording automatically
- Recording state is tracked via an atomic flag to avoid false positives from Hermeneia's own recording

### 2. Transcription

Two transcription backends are available:

**Local Whisper** (default)
- Uses **whisper-rs** (Rust bindings for whisper.cpp)
- Models: `large-v3` (~3.1GB), `large-v3-turbo` (~1.6GB), `distil-large-v3.5` (~1.5GB)
- Runs offline, no API key required
- Shows live transcript during recording via streaming inference

**Cloud OpenAI API**
- Uses OpenAI Whisper API (`whisper-1` model)
- Requires OpenAI API key
- Supports custom model selection via API
- Files must be under 24MB

Audio preprocessing uses **ffmpeg** to convert any input format to 16kHz mono WAV.

### 3. Diarization

Separates speakers in the transcript:

**Local (WeSpeaker)**
- Uses an ONNX ResNet34 model downloaded from HuggingFace
- Streaming recluster algorithm assigns speaker IDs in real-time
- Configurable max speakers (1-12)
- No API key needed, works offline

**OpenAI API**
- Server-side diarization via OpenAI Whisper API
- Returns speaker labels directly in the transcript segments

### 4. Content Generation

Transcribed text flows through configurable LLM pipelines:

**Note Cleanup** — Fixes grammar, spelling, formatting; preserves meaning and tone

**Note Title Generation** — Creates concise titles (max 8 words) from transcripts

**Transcript Cleanup** — Polishes raw transcripts into structured markdown with speaker labels, language translation support

**Meeting Summary** — Transforms raw notes into concise, structured meeting notes

**Slide Deck Generation** — Produces JSON-formatted slide decks from documents

**Podcast Script** — Generates single-voice narration scripts, optionally converted to audio via ElevenLabs TTS (multilingual_v2 model)

All prompts are customizable in Settings → LLM System Prompts.

### 5. Storage & Retrieval

- **SQLite database** — Stores projects, documents, chat history, settings
- **HNSW vector index** — Embeds document chunks using OpenAI embeddings for semantic search
- **RAG (Retrieval-Augmented Generation)** — When enabled, relevant document chunks are automatically injected into LLM prompts based on the user's question

## Architecture

```
src-tauri/src/
  main.rs                  — App entry, Tauri builder, command registration
  engine/
    audio_engine.rs        — Microphone recording (cpal)
    transcription_engine.rs — Whisper / OpenAI API transcription
    whisper_engine.rs      — Local whisper.cpp integration
    diarization_engine.rs  — WeSpeaker speaker separation
    meeting_detector.rs    — Process monitoring for Zoom/Teams/Slack
    meeting_popup.rs       — Meeting detection notification UI
    chat_engine*.rs        — LLM integration (Claude, OpenAI, Gemini, Ollama)
    document_cleanup_engine.rs — AI cleanup/summary/slide/podcast generation
    podcast_generator.rs   — ElevenLabs text-to-speech
    similarity_search_engine.rs — HNSW vector search
    project_vector_engine.rs — Per-project document indexing
  configuration/
    database.rs            — SQLite initialization
    settings.rs            — Settings CRUD
    state.rs               — Shared app state
  repository/              — Data access layer
```

## Settings

Configured via Settings modal (4 tabs):

- **General** — Autostart, RAG indexing, meeting detection, ElevenLabs key, system prompts
- **Endpoints** — API keys and base URLs per provider (Claude, OpenAI, Gemini, Ollama)
- **Models** — LLM model, speech recognition model, diarization mode selection
- **About** — Version, copyright, third-party acknowledgments

## Tech Stack

- **Frontend** — React, TypeScript, Chakra UI, Vite
- **Backend** — Tauri (Rust), SQLite (rusqlite), HNSW
- **Audio** — cpal, hound, ffmpeg, whisper.cpp (via whisper-rs)
- **Diarization** — WeSpeaker ONNX (via nnnoiseless, rubato)
- **Vector Search** — hnswlib-rs
- **AI Providers** — Anthropic Claude, OpenAI, Google Gemini, Ollama (local)
- **TTS** — ElevenLabs API

## Third-Party Components

This software includes components subject to their respective licenses:
- whisper.cpp
- whisper-rs
- Distil-Whisper
- nnnoiseless
- rubato
- hnswlib-rs

## Requirements

- macOS (primary platform)
- ffmpeg (for audio preprocessing)
- OpenAI API key (optional, for cloud transcription/diarization/RAG)
- ElevenLabs API key (optional, for podcast generation)
