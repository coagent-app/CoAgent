# Voice Pill — Push-to-Talk Overlay

## Overview

Global hotkey (fn+ctrl) triggers a floating pill at bottom-center of screen. User speaks, agent acts, pill shows a short summary, then fades out. Works even when CoAgent is minimized.

## Flow

1. **Hold fn+ctrl** — small dark rounded pill appears at bottom-center of screen, mic icon pulsing
2. **Release** — pill shows "Thinking..." with subtle spinner
3. **Agent finishes** — pill shows one-line summary (e.g. "Meeting with Alex scheduled for Friday 5:30pm") for 3-4 seconds
4. **Fades out** — pill disappears. Full response is in the chat history if they want it.

## Technical Components

### Global Hotkey
- Tauri `register_global_shortcut` API
- Trigger: fn+ctrl (configurable in settings)
- On press: start recording, show pill
- On release: stop recording, send to Whisper

### Audio Recording
- Record microphone via Tauri or browser MediaRecorder API
- Send audio blob to OpenAI Whisper API for transcription
- Pipe transcribed text into agent as a regular chat message

### Floating Pill Window
- Separate Tauri window: transparent, frameless, always-on-top, non-focusable
- Positioned: bottom-center of primary display
- Size: ~300px wide, ~44px tall, rounded-full
- States:
  - **Listening**: dark bg, mic icon, subtle pulse animation
  - **Thinking**: dark bg, spinner, "Thinking..."
  - **Result**: dark bg, one-line summary text, fades out after 3-4s
- Click pill to open main CoAgent window

### Agent Changes
- None — voice input is just text by the time it reaches the agent
- Agent returns a response as normal
- Frontend extracts first sentence or summary for the pill display

## Settings
- Enable/disable voice
- Change hotkey
- Requires OpenAI API key (for Whisper)
