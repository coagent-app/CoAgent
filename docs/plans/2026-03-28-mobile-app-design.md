# CoAgent Mobile App Design

## Goal

iOS app that lets you chat with and voice-call your CoAgent from your phone, connecting through the existing Cloudflare relay.

## Architecture

Expo (React Native) thin client in `apps/mobile/`. Connects to the relay Durable Object via WebSocket at `wss://{relayUrl}/client/{userId}`. Same `WSClientMessage`/`WSServerMessage` protocol as the desktop app — no new server-side message types. All agent logic stays on the Mac.

```
Phone App (Expo)
    ↓ wss://
Cloudflare Relay DO (/client/:userId)
    ↓ ws://
Relay Client (on Mac)
    ↓ ws://
Agent Server (localhost:7830)
```

## Tech Stack

- Expo SDK (React Native, iOS only for now)
- `@coagent/shared` for WS message types
- Expo SecureStore for credential storage
- Expo Camera for QR scanning
- Expo AV for audio recording/playback
- Voice Activity Detection for hands-free voice sessions

## QR Code Pairing

1. Desktop Settings pane gets a "Pair Mobile" button
2. Generates a QR code encoding a universal link: `https://coagent.app/pair?token={token}&relay={relayUrl}&userId={userId}`
3. User scans with iPhone camera
4. App not installed → App Store. App installed → deep link opens app with credentials
5. Credentials stored in Expo SecureStore (encrypted keychain)
6. Immediately connects to relay WebSocket

## Screens

### Chat Screen (default)
- Message list with streaming chunk rendering
- Text input at bottom
- Tool activity label ("Searching emails...")
- Thinking/processing indicator
- Connection status banner (connected / offline)

### Voice Screen
- Tap once to start a voice session
- Voice Activity Detection handles turn-taking (no button holding)
- User speaks → silence detected → audio sent as `voice_audio` message
- Agent responds with TTS chunks → phone plays audio
- When TTS ends, resumes listening automatically
- Back-and-forth like a phone call
- Tap to end session

### Settings Screen
- Connection status (relay URL, connected/offline)
- Re-pair via QR scan
- Unpair (clear credentials)
- No other settings — all agent configuration stays on desktop

## Server-Side Changes

### Relay DO (relay-do.ts)
- Verify `/client/:userId` sends full state dump on connect (chat history, settings, connection status)
- May need the agent to re-broadcast initial state when a new client joins

### Desktop Settings (SettingsPane.tsx)
- Add "Pair Mobile" button with QR code generation

### Agent Server (server.ts)
- No changes needed. Phone is just another WS client.

### Shared Types
- No changes needed. Existing message types cover everything.

## Data Flow

### Text Chat
```
Phone → { type: 'chat', message: '...' }
     → relay forwards to agent
     → agent streams back { type: 'chat_chunk', text: '...' }
     → relay broadcasts to all clients
     → phone renders streaming text
```

### Voice Session
```
Phone → tap "start" → begin recording with VAD
     → silence detected → { type: 'voice_audio', data: base64 }
     → agent transcribes (Whisper) → processes → streams response
     → { type: 'voice_tts_chunk', seq, data } flows back
     → phone plays TTS audio
     → TTS ends → resume listening (VAD)
     → loop until user taps "end"
```

## What's NOT in Scope

- No calendar, queue, files, or integrations management on mobile
- No local caching or offline mode
- No Android (for now)
- No push notifications (for now)
- No local agent logic — phone is a pure thin client
