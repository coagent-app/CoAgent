import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { open } from '@tauri-apps/plugin-shell'
import { invoke } from '@tauri-apps/api/core'
import type { ApprovalItem, DoneItem, AgentMessage, WSServerMessage, WSClientMessage, Integration, AgentSettings, FileEntry, AuthStatus, AuthMethod, RelayUsage, UsageSummary, CalendarEntry, AdminUser, GoogleCalendarInfo, WSServerMessage as WSSMsg, Canvas } from '@coagent/shared'
import { executePython, cancelConversation } from '@/python/python-kernel'
import { readFileAsBase64 } from '@/lib/utils'

// ── Global file-drop target ──────────────────────────────────────────────────
// When FilesPane is mounted and the user is viewing a folder, drops anywhere in
// the app ingest into that folder instead of the root. FilesPane sets this via
// setFileDropTarget on mount/path-change and clears it on unmount.
let currentFileDropTarget = ''
export function setFileDropTarget(group: string): void {
  currentFileDropTarget = group
}

// ── Voice active flag (replaces window.__voiceActive) ───────────────────────
let voiceActive = false
export function setVoiceActive(v: boolean) { voiceActive = v }
export function isVoiceActive() { return voiceActive }

// ── Stable message IDs ─────────────────────────────────────────────────────
let _msgSeq = 0
function makeMsg(role: 'user' | 'assistant', content: string): AgentMessage {
  return { id: `local-${Date.now()}-${++_msgSeq}`, role, content, timestamp: new Date().toISOString() }
}

export interface CodeCell {
  id: string
  code: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  stdout: string
  stderr: string
  images?: string[]
  resultRepr?: string
  errorType?: string
  errorMessage?: string
  traceback?: string
  durationMs?: number
  /** Cell appears in the chat after the message at this index. */
  anchorIndex: number
  /** Stable ID of the message this cell is anchored to. */
  anchorMessageId?: string | null
  /**
   * Content of the message the cell is anchored to, used to re-compute
   * `anchorIndex` when chat history is reloaded. We cannot use timestamps:
   * the server regenerates them on every getChatHistory() call (agent.ts),
   * so a cached timestamp never matches the fresh history. Message content,
   * by contrast, is stable across reloads because conversationHistory is
   * persisted on disk. `null` means the cell was created before any message
   * existed (very rare; renders at the top).
   */
  anchorMessageContent?: string | null
  /** Conversation ID used for cancellation via cancelConversation. */
  conversationId: string}

type RelayCredentials = Extract<WSSMsg, { type: 'relay_credentials' }>

const WS_URL = 'ws://localhost:7830'
const RECONNECT_BASE = 250
const RECONNECT_MAX = 10000

// ── LocalStorage cache for instant UI on restart ─────────────────────────────
const CACHE_KEY = 'coagent_state_cache'
function loadCache(): Record<string, any> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
// Accumulate patches and flush after 500ms of inactivity so rapid streaming
// chunks don't hammer localStorage on every chunk.
let _saveCacheTimer: ReturnType<typeof setTimeout> | null = null
let _pendingCachePatch: Record<string, any> = {}
function saveCache(patch: Record<string, any>) {
  Object.assign(_pendingCachePatch, patch)
  if (_saveCacheTimer) clearTimeout(_saveCacheTimer)
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null
    const toFlush = _pendingCachePatch
    _pendingCachePatch = {}
    try {
      const current = loadCache()
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...current, ...toFlush }))
    } catch {}
  }, 500)
}
const _cached = loadCache()

export function useAgent() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelay = useRef(RECONNECT_BASE)
  const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processingRef = useRef(false)  // mirrors processing state, readable inside callbacks
  const pollIntervals = useRef<ReturnType<typeof setInterval>[]>([])
  const pollIntervalsBySlug = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const recentIngestedFiles = useRef<{ id: string; filename: string }[]>([])
  const wasStreamingRef = useRef(false)
  // Mirrors for reading current state inside WS message handlers without stale closures
  const messagesRef = useRef<AgentMessage[]>(_cached.messages ?? [])
  const streamingTextRef = useRef<string | null>(null)
  const codeCellsRef = useRef<Record<string, CodeCell>>({})
  const [queue, setQueue] = useState<ApprovalItem[]>([])
  const [done, setDone] = useState<DoneItem[]>([])
  const [newQueueIds, setNewQueueIds] = useState<Set<string>>(new Set())
  const [messages, setMessages] = useState<AgentMessage[]>(_cached.messages ?? [])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [connected, setConnected] = useState(false)
  // hydrated = true once all critical initial data (settings + chat_history) has
  // arrived after WS connect. Prevents the app shell from rendering before data
  // is ready, avoiding empty states and red dot flashes.
  const [hydrated, setHydrated] = useState(false)
  const hydrateFlags = useRef({ settings: false, chatHistory: false })
  const [integrations, setIntegrations] = useState<Integration[]>(_cached.integrations ?? [])
  const [settings, setSettings] = useState<AgentSettings | null>(_cached.settings ?? null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null)
  const [transcribingFiles, setTranscribingFiles] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [toolLabel, setToolLabel] = useState<string | null>(null)
  const [researchAgents, setResearchAgents] = useState<{ query: string; status: string; detail?: string }[]>([])
  const [lastHeartbeat, setLastHeartbeat] = useState<{ time: Date; status: string; nextAt?: Date } | null>(null)
  const [heartbeatLog, setHeartbeatLog] = useState<{ time: Date; status: string }[]>([])
  const [statusLine, setStatusLine] = useState<string | null>(null)
  const [skills, setSkills] = useState<{ name: string; description: string; instructions: string }[]>([])
  const [pendingFields, setPendingFields] = useState<{ slug: string; fields: { name: string; displayName: string; description: string }[] } | null>(null)
  const [relayActive, setRelayActive] = useState<boolean>(false)
  const [relayModel, setRelayModel] = useState<string | null>(null)
  const [relayUsage, setRelayUsage] = useState<RelayUsage | null>(null)
  const [voiceSummary, setVoiceSummary] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [calendarEntries, setCalendarEntries] = useState<CalendarEntry[]>([])
  const [capabilityCard, setCapabilityCard] = useState<{ name: string; capabilities: { name: string; description: string; checked: boolean }[]; authFields?: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[] } | null>(null)
  const [whatsappQr, setWhatsappQr] = useState<string | null>(null)
  const [relayCredentials, setRelayCredentials] = useState<RelayCredentials | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [adminNewToken, setAdminNewToken] = useState<{ token: string; userId: string } | null>(null)
  const [teamInfo, setTeamInfo] = useState<any>(null)
  const [teamMessages, setTeamMessages] = useState<any[]>([])
  const [teamStatus, setTeamStatus] = useState<{ status: 'processing' | 'idle'; from?: string } | null>(null)
  const [triggerPrompt, setTriggerPrompt] = useState<Integration | null>(null)
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState<{ connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }>({ connected: false, calendars: [], lastSync: null })
  // Canvas state
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [canvasVisible, setCanvasVisible] = useState(false)
  const [canvasStreamingCode, setCanvasStreamingCode] = useState<string | null>(null)
  const [canvasStreaming, setCanvasStreaming] = useState(false)
  // Tracks which canvas ID has received its final content (canvas_opened/canvas_updated).
  // Any canvas_streaming message for this ID will be ignored to prevent race conditions.
  const canvasFinalized = useRef<string | null>(null)
  const [canvasesList, setCanvasesList] = useState<Array<{ id: string; title: string; kind?: string; createdAt: string; updatedAt: string }>>([])
  // Python code cells (Pyodide). Keyed by requestId from server. Hydrated from
  // localStorage so cells survive server restarts, HMR reloads, and webview
  // refreshes. Any cell still marked 'running' at load time was interrupted
  // by the reload, so we reset it to 'cancelled'.
  // Code cells are session-only — don't restore from cache to avoid stale anchoring issues
  const [codeCells, setCodeCells] = useState<Record<string, CodeCell>>({})
  const [codeCellOrder, setCodeCellOrder] = useState<string[]>([])
  const settingsRef = useRef<AgentSettings | null>(_cached.settings ?? null)
  const prevConnectedSlugs = useRef<Set<string> | null>(null)

  // Safety: force hydrated after 3s of being connected to prevent stuck loading
  useEffect(() => {
    if (hydrated || !connected) return
    const t = setTimeout(() => setHydrated(true), 3000)
    return () => clearTimeout(t)
  }, [hydrated, connected])

  // Keep refs in sync so python_streaming/python_run handlers can read current
  // messages and streamingText without stale closures.
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { streamingTextRef.current = streamingText }, [streamingText])
  useEffect(() => { processingRef.current = processing }, [processing])
  useEffect(() => { codeCellsRef.current = codeCells }, [codeCells])
  useEffect(() => {
    let unmounted = false

    // Close any lingering socket from StrictMode remount
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    function connect() {
      if (unmounted) return
      const socket = new WebSocket(WS_URL)

      let authConfirmed = false

      socket.onopen = async () => {
        try {
          const nonce = await invoke<string>('get_ws_nonce')
          socket.send(JSON.stringify({ type: 'auth', nonce }))
        } catch (err) {
          console.error('[WS] Failed to get nonce:', err)
          socket.close()
          return
        }
        // Don't send anything else yet — wait for server to confirm auth
        // by sending us the first message (sendFullState triggers on successful auth)
      }

      socket.onclose = () => {
        setConnected(false)
        // Don't reset hydrated — once the app has shown the shell with data,
        // we keep it visible during reconnection to avoid jarring transitions.
        // The hydrated flag only gates the *first* load.
        if (wsRef.current === socket) wsRef.current = null
        // Reset all transient UI state so the user doesn't see stale indicators
        // (processing spinner, streaming text, tool labels, etc.) after disconnect.
        setProcessing(false)
        setThinking(false)
        setStreamingText(null)
        setToolLabel(null)
        setResearchAgents([])
        setCanvasStreaming(false)
        if (processingTimeoutRef.current) { clearTimeout(processingTimeoutRef.current); processingTimeoutRef.current = null }
        // Clear any stale OAuth poll intervals from previous connection
        pollIntervals.current.forEach(clearInterval)
        pollIntervals.current = []
        pollIntervalsBySlug.current.forEach(clearInterval)
        pollIntervalsBySlug.current.clear()
        if (!unmounted) {
          // Cancel any pending reconnect before scheduling a new one to avoid
          // duplicate concurrent sockets on rapid disconnect/reconnect cycles.
          if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, RECONNECT_MAX)
            connect()
          }, reconnectDelay.current)
        }
      }

      socket.onmessage = (event) => {
        let msg: WSServerMessage
        try {
          msg = JSON.parse(event.data)
        } catch {
          console.error('[WS] Failed to parse message:', event.data?.slice?.(0, 100))
          return
        }
        // First server message after auth confirms authentication succeeded
        if (!authConfirmed) {
          authConfirmed = true
          setConnected(true)
          reconnectDelay.current = RECONNECT_BASE
          // If we have cached settings, mark hydrated immediately so the app
          // shell renders with cached data while fresh data loads in background.
          if (_cached.settings) {
            hydrateFlags.current = { settings: true, chatHistory: true }
            setHydrated(true)
          }
          socket.send(JSON.stringify({ type: 'get_team_info' }))
          socket.send(JSON.stringify({ type: 'team_history', limit: 50 }))
          socket.send(JSON.stringify({ type: 'get_google_calendar_status' }))
        }
        if (msg.type === 'queue_update') {
          setQueue(prev => {
            const prevIds = new Set(prev.map(i => i.id))
            const fresh = msg.items.filter(i => i.status === 'pending' && !prevIds.has(i.id))
            if (fresh.length > 0) {
              setNewQueueIds(old => {
                const next = new Set(old)
                fresh.forEach(i => next.add(i.id))
                return next
              })
            }
            return msg.items
          })
        }
        if (msg.type === 'done_update') setDone(msg.items)
        if (msg.type === 'agent_thinking') {
          wasStreamingRef.current = false
          setThinking(true)
          setStreamingText(null)
          setToolLabel(null)
        }
        if (msg.type === 'chat_segment_end') {
          setStreamingText(current => {
            if (current?.trim()) {
              setMessages(prev => [...prev, makeMsg('assistant', current)].slice(-100))
            }
            return null
          })
        }
        if (msg.type === 'tool_start') {
          if (!isVoiceActive()) {
            setStreamingText(current => {
              if (current?.trim()) {
                setMessages(prev => [...prev, makeMsg('assistant', current)].slice(-100))
              }
              return null
            })
          }
          setToolLabel(msg.label)
          setThinking(true)
          if (isVoiceActive()) {
            import('@/lib/voice').then(v => v.showVoiceToolLabel(msg.label))
          }
        }
        if (msg.type === 'subagent_complete') {
          console.log(`[UI] Sub-agent "${msg.label}" completed (${msg.resultLength} chars)`)
        }
        if (msg.type === 'research_progress') {
          setResearchAgents(msg.agents)
          // Clear when all done/error
          if (msg.agents.length > 0 && msg.agents.every((a: any) => a.status === 'done' || a.status === 'error')) {
            timeoutsRef.current.push(setTimeout(() => setResearchAgents([]), 2000))
          }
        }
        if (msg.type === 'chat_chunk') {
          wasStreamingRef.current = true
          setThinking(false)
          setToolLabel(null)
          setResearchAgents([])
          setStreamingText(prev => (prev ?? '') + msg.text)
          // Forward just the first sentence to voice pill
          if (isVoiceActive()) {
            import('@/lib/voice').then(v => v.showVoiceResponse(msg.text))
          }
        }
        if (msg.type === 'chat_response') {
          const wasStreamed = wasStreamingRef.current
          wasStreamingRef.current = false
          // Capture docs before the async setState updater so they are available in the closure
          const responseDocs = msg.message.docs && msg.message.docs.length > 0 ? msg.message.docs : undefined
          // Snapshot any remaining streaming text as a final bubble
          setStreamingText(current => {
            if (current?.trim()) {
              const streamedMsg = makeMsg('assistant', current)
              // Attach docs from the server's chat_response to the streamed message
              if (responseDocs) streamedMsg.docs = responseDocs
              setMessages(prev => [...prev, streamedMsg].slice(-100))
            } else if (wasStreamed && responseDocs) {
              // Streaming already flushed via chat_segment_end (e.g. last segment was a tool call).
              // Patch the last assistant message in the array with the docs.
              setMessages(prev => {
                if (prev.length === 0) return prev
                const last = prev[prev.length - 1]
                if (last.role !== 'assistant') return prev
                return [...prev.slice(0, -1), { ...last, docs: responseDocs }]
              })
            }
            return null
          })
          // Only add message directly if it wasn't streamed (e.g. heartbeat summary, todo trigger)
          // Streamed responses are already captured via chat_chunk → streaming text snapshot above
          if (!wasStreamed) {
            const incoming = msg.message.id ? msg.message : { ...msg.message, id: `srv-${Date.now()}-${++_msgSeq}` }
            setMessages(prev => [...prev, incoming].slice(-100))
          }
          setThinking(false)
          setToolLabel(null)
          if (processingTimeoutRef.current) { clearTimeout(processingTimeoutRef.current); processingTimeoutRef.current = null }
          setProcessing(false)
          // Dismiss voice pill if it was active (covers both normal completion and stop)
          if (isVoiceActive()) {
            setVoiceActive(false)
            import('@/lib/voice').then(v => v.showVoiceSummary(''))
          }
        }
        if (msg.type === 'agent_stopped') {
          wasStreamingRef.current = false
          setStreamingText(null)
          setThinking(false)
          setToolLabel(null)
          if (processingTimeoutRef.current) { clearTimeout(processingTimeoutRef.current); processingTimeoutRef.current = null }
          setProcessing(false)
          if (isVoiceActive()) {
            setVoiceActive(false)
            import('@/lib/voice').then(v => { v.cancelTts(); v.showVoiceSummary('') })
          }
        }
        if (msg.type === 'chat_history') {
          wasStreamingRef.current = false
          setStreamingText(null)
          const serverMessages = msg.messages.slice(-100)
          // If server has fewer messages than cache (e.g. backend restarted),
          // keep the cached messages so the user doesn't see them vanish.
          const cached = messagesRef.current
          const newMessages = serverMessages.length >= cached.length ? serverMessages : cached
          const oldMessageCount = cached.length || newMessages.length
          setMessages(newMessages)
          saveCache({ messages: newMessages.slice(-50) })
          // Re-anchor cached code cells against the fresh messages array.
          // Match by stored message content (not timestamp — the server
          // regenerates timestamps on every history fetch). Content is
          // stable across reloads because conversationHistory is persisted.
          // If two messages share the same content, the first match wins,
          // which matches the original insertion order.
          setCodeCells(prev => {
            if (Object.keys(prev).length === 0) return prev
            const next: Record<string, CodeCell> = {}
            for (const [id, cell] of Object.entries(prev)) {
              // 1. Try matching by stable message ID (most reliable)
              if (cell.anchorMessageId) {
                const idx = newMessages.findIndex(m => m.id === cell.anchorMessageId)
                if (idx >= 0) {
                  next[id] = { ...cell, anchorIndex: idx + 1 }
                  continue
                }
              }
              // 2. Fall back to content matching (exact → prefix → reverse prefix)
              if (cell.anchorMessageContent) {
                const target = cell.anchorMessageContent
                let idx = newMessages.findIndex(m => m.content === target)
                if (idx < 0) {
                  const prefix = target.slice(0, 200)
                  idx = newMessages.findIndex(m => m.content.startsWith(prefix) || target.startsWith(m.content.slice(0, 200)))
                }
                if (idx >= 0) {
                  // Backfill the ID for future re-anchors
                  next[id] = { ...cell, anchorIndex: idx + 1, anchorMessageId: newMessages[idx].id }
                  continue
                }
              }
              // 3. No match — anchor message was trimmed from history, drop the cell
              continue
            }
            return next
          })
          if (!hydrateFlags.current.chatHistory) {
            hydrateFlags.current.chatHistory = true
            if (hydrateFlags.current.settings) setHydrated(true)
          }
        }
        if (msg.type === 'integrations_update') {
          // Detect newly connected integration with triggers → show prompt
          // Skip first update (initial load) — only detect transitions during this session
          const prev = prevConnectedSlugs.current
          const connectedNow = new Set(msg.integrations.filter(i => i.connected).map(i => i.slug))
          if (prev !== null) {
            for (const i of msg.integrations) {
              if (i.connected && !prev.has(i.slug) && i.triggers && i.triggers.length > 0) {
                setTriggerPrompt(i)
                break
              }
            }
          }
          prevConnectedSlugs.current = connectedNow
          // Clear OAuth poll for any integration that just became connected
          for (const i of msg.integrations) {
            if (i.connected && pollIntervalsBySlug.current.has(i.slug)) {
              clearInterval(pollIntervalsBySlug.current.get(i.slug)!)
              pollIntervalsBySlug.current.delete(i.slug)
            }
          }
          setIntegrations(msg.integrations); saveCache({ integrations: msg.integrations })
          const wa = msg.integrations.find((i: any) => i.slug === 'coagent:whatsapp')
          if (wa?.connected) setWhatsappQr(null)
        }
        if (msg.type === 'settings_update') {
          setSettings(msg.settings); settingsRef.current = msg.settings; saveCache({ settings: msg.settings })
          if (!hydrateFlags.current.settings) {
            hydrateFlags.current.settings = true
            if (hydrateFlags.current.chatHistory) setHydrated(true)
          }
        }
        if (msg.type === 'auth_status') setAuthStatus(msg.status)
        if (msg.type === 'files_update') setFiles(msg.files)
        if (msg.type === 'transcription_status') {
          setTranscribingFiles(prev => {
            const next = new Set(prev)
            if (msg.status === 'started') next.add(msg.fileId)
            else next.delete(msg.fileId)
            return next
          })
        }
        if (msg.type === 'folders_update') setFolders(msg.folders)
        if (msg.type === 'files_search_result') setSearchResults(msg.files)
        if (msg.type === 'relay_status') {
          setRelayActive(msg.active)
          setRelayModel(msg.model)
          setRelayUsage(msg.usage)
          setIsAdmin(msg.admin ?? false)
        }
        if (msg.type === 'file_ingested') recentIngestedFiles.current.push({ id: msg.id, filename: msg.filename })
        if (msg.type === 'heartbeat') {
          const nextAt = msg.nextAt ? new Date(msg.nextAt) : undefined
          if (msg.status === 'scheduled') {
            setLastHeartbeat(prev => ({ time: prev?.time ?? new Date(), status: prev?.status ?? 'done', nextAt }))
          } else {
            setLastHeartbeat({ time: new Date(), status: msg.status, nextAt })
            setHeartbeatLog(prev => [...prev.slice(-19), { time: new Date(), status: msg.status }])
          }
        }
        if (msg.type === 'status_line') setStatusLine(msg.message)
        if (msg.type === 'skills_update') setSkills(msg.skills)
        if (msg.type === 'voice_transcribed') {
          // Show the user's voice input in chat (dedupe in case of multiple connections)
          setMessages(prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'user' && last.content === msg.text) return prev
            return [...prev, makeMsg('user', msg.text)].slice(-100)
          })
          import('@/lib/voice').then(v => v.resetVoiceResponse())
        }
        if (msg.type === 'voice_summary') {
          setVoiceSummary(msg.summary)
          // Show summary in pill, then auto-hide after delay
          import('@/lib/voice').then(v => v.showVoiceSummary(msg.summary))
        }
        if (msg.type === 'voice_tts_audio') {
          import('@/lib/voice').then(v => v.playTtsAudio(msg.data))
        }
        if (msg.type === 'voice_tts_chunk') {
          import('@/lib/voice').then(v => v.handleTtsChunk(msg.data, msg.seq, (msg as any).format))
        }
        if (msg.type === 'voice_tts_done') {
          import('@/lib/voice').then(v => v.handleTtsDone((msg as any).format))
        }
        if (msg.type === 'voice_tts_cancel') {
          import('@/lib/voice').then(v => v.cancelTts())
        }
        if (msg.type === 'voice_dictation_result') {
          window.dispatchEvent(new CustomEvent('coagent-dictation', { detail: msg.text }))
        }
        if (msg.type === 'usage_update') setUsage(msg.usage)
        if (msg.type === 'auto_organize_done') setOrganizing(false)
        if (msg.type === 'calendar_update') setCalendarEntries(msg.entries)
        if (msg.type === 'google_calendar_status') setGoogleCalendarStatus({ connected: msg.connected, calendars: msg.calendars, lastSync: msg.lastSync })
        if (msg.type === 'capability_card') {
          setCapabilityCard({ name: msg.name, capabilities: msg.capabilities, authFields: (msg as any).authFields })
        }
        if (msg.type === 'whatsapp_qr') {
          setWhatsappQr(msg.dataUrl)
        }
        if (msg.type === 'relay_credentials_ready') {
          // Fetch credentials via Tauri IPC instead of receiving over WS
          invoke<string>('get_relay_credentials').then(json => {
            const creds = JSON.parse(json)
            setRelayCredentials({ type: 'relay_credentials', ...creds })
          }).catch(err => console.error('[Relay] Failed to get credentials:', err))
        }
        if (msg.type === 'admin_token_created') {
          setAdminNewToken({ token: msg.token, userId: msg.userId })
        }
        if (msg.type === 'admin_tokens_list') {
          setAdminUsers(msg.users)
        }
        if (msg.type === 'admin_token_toggled') {
          setAdminUsers(prev => prev.map(u => u.token === msg.token ? { ...u, active: msg.active } : u))
        }
        if (msg.type === 'team_info') setTeamInfo(msg.team)
        if (msg.type === 'team_message') {
          const incoming = msg.message
          setTeamMessages(prev => prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming])
        }
        if (msg.type === 'team_history') setTeamMessages(msg.messages)
        if (msg.type === 'team_status') {
          setTeamStatus(msg.status === 'idle' ? null : { status: msg.status, from: msg.from })
        }
        if (msg.type === 'canvas_save_to_files') {
          const m = msg
          import('@/lib/canvas-pdf').then(({ renderCanvasPdf }) => {
            import('@/lib/canvas-brand').then(({ brandFromSettings }) => {
              const brand = brandFromSettings(settingsRef.current)
              renderCanvasPdf(m.code, brand, m.title).then((blob: Blob) => {
                const reader = new FileReader()
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1] ?? ''
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({
                      type: 'ingest_file',
                      filename: `${m.title || 'document'}.pdf`,
                      mimeType: 'application/pdf',
                      data: base64,
                      canvasId: m.canvasId,
                    }))
                  }
                }
                reader.readAsDataURL(blob)
              }).catch((err: unknown) => console.error('[useAgent] canvas_save_to_files error:', err))
            }).catch((err: unknown) => console.error('[useAgent] canvas_save_to_files error:', err))
          }).catch((err: unknown) => console.error('[useAgent] canvas_save_to_files error:', err))
        }
        if (msg.type === 'canvas_opened' || msg.type === 'canvas_updated') {
          setCanvas(msg.canvas)
          setCanvasVisible(true)
          setCanvasStreaming(false)
          setCanvasStreamingCode(null)
          // Mark this canvas as finalized — ignore any late streaming messages
          // for the same canvas ID that arrive after the final content.
          canvasFinalized.current = msg.canvas.id
        }
        if (msg.type === 'canvas_streaming') {
          // Ignore streaming messages for a canvas that already has its final
          // content (race condition: late streaming messages arriving after
          // canvas_updated due to React batching or WS ordering).
          if (canvasFinalized.current === msg.canvasId) return
          // Show the pane immediately with a synthetic placeholder canvas so
          // the user sees the draft materialize in real time. When the tool
          // call finishes, canvas_opened will replace this with the persisted
          // canvas from disk.
          setCanvas(prev => prev && prev.id === msg.canvasId ? prev : {
            id: msg.canvasId,
            title: msg.title || 'Drafting…',
            code: '',
            createdAt: '',
            updatedAt: '',
          })
          setCanvasStreamingCode(msg.partialCode || '')
          setCanvasStreaming(true)
          setCanvasVisible(true)
        }
        if (msg.type === 'canvas_error') {
          setError(msg.message || 'Canvas error')
          timeoutsRef.current.push(setTimeout(() => setError(null), 5000))
        }
        if (msg.type === 'canvases_list') {
          setCanvasesList(msg.items)
        }
        if (msg.type === 'python_streaming') {
          const m = msg
          const cellId: string = m.requestId
          const partialCode: string = m.partialCode
          // Fast path: cell already exists, just update the code
          if (codeCellsRef.current[cellId]) {
            setCodeCells(prev => ({ ...prev, [cellId]: { ...prev[cellId], code: partialCode } }))
            return
          }
          // New cell: snapshot streaming text, compute anchor, then call setters flat
          const currentStreaming = streamingTextRef.current
          let nextMsgs = messagesRef.current
          if (currentStreaming?.trim()) {
            nextMsgs = [...messagesRef.current, makeMsg('assistant', currentStreaming)].slice(-100)
            setMessages(nextMsgs)
            setStreamingText(null)
          }
          const anchorIndex = nextMsgs.length
          const anchorMsg = nextMsgs[nextMsgs.length - 1]
          const anchorMessageContent = anchorMsg?.content ?? null
          const anchorMessageId = anchorMsg?.id ?? null
          setCodeCells(prev => ({
            ...prev,
            [cellId]: { id: cellId, code: partialCode, status: 'running', stdout: '', stderr: '', anchorIndex, anchorMessageId, anchorMessageContent, conversationId: m.conversationId || 'main' },
          }))
          setCodeCellOrder(prev => prev.includes(cellId) ? prev : [...prev, cellId])
        }
        if (msg.type === 'python_run') {
          const m = msg
          const cellId: string = m.requestId
          const cellCode: string = m.code
          // Cell already exists from python_streaming — just update the final code
          if (codeCellsRef.current[cellId]) {
            setCodeCells(prev => ({ ...prev, [cellId]: { ...prev[cellId], code: cellCode } }))
          } else {
            // No streaming cell — snapshot streaming text, compute anchor, then call setters flat
            const currentStreaming = streamingTextRef.current
            let nextMsgs = messagesRef.current
            if (currentStreaming?.trim()) {
              nextMsgs = [...messagesRef.current, makeMsg('assistant', currentStreaming)].slice(-100)
              setMessages(nextMsgs)
              setStreamingText(null)
            }
            const anchorIndex = nextMsgs.length
            const anchorMsg2 = nextMsgs[nextMsgs.length - 1]
            const anchorMessageContent = anchorMsg2?.content ?? null
            const anchorMessageId = anchorMsg2?.id ?? null
            setCodeCells(prev => ({
              ...prev,
              [cellId]: { id: cellId, code: cellCode, status: 'running', stdout: '', stderr: '', anchorIndex, anchorMessageId, anchorMessageContent, conversationId: m.conversationId || 'main' },
            }))
            setCodeCellOrder(prev => prev.includes(cellId) ? prev : [...prev, cellId])
          }
          // Run in the worker pool, stream events both into local state (for the
          // chat UI) and back over the WS to the agent (so it can see results).
          executePython({
            conversationId: m.conversationId || 'main',
            code: m.code,
            timeoutMs: m.timeoutMs,
            onEvent: (event) => {
              const ws = wsRef.current
              if (event.type === 'stdout') {
                setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], stdout: prev[cellId].stdout + event.line + '\n' } } : prev)
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'python_event', requestId: cellId, event: { type: 'stdout', line: event.line } }))
                }
              } else if (event.type === 'stderr') {
                setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], stderr: prev[cellId].stderr + event.line + '\n' } } : prev)
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'python_event', requestId: cellId, event: { type: 'stderr', line: event.line } }))
                }
              } else if (event.type === 'image') {
                setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], images: [...(prev[cellId].images || []), event.dataUrl] } } : prev)
              } else if (event.type === 'done') {
                setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], status: 'done', resultRepr: event.resultRepr, durationMs: event.durationMs } } : prev)
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'python_done', requestId: cellId, stdout: '', stderr: '', resultRepr: event.resultRepr, durationMs: event.durationMs }))
                }
              } else if (event.type === 'error') {
                setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], status: 'error', errorType: event.errorType, errorMessage: event.message, traceback: event.traceback } } : prev)
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'python_error', requestId: cellId, errorType: event.errorType, message: event.message, traceback: event.traceback, stdout: '', stderr: '' }))
                }
              } else if (event.type === 'cancelled') {
                setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], status: 'cancelled' } } : prev)
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'python_cancelled', requestId: cellId, reason: event.reason }))
                }
              }
            },
          }).catch((err) => {
            console.error('[python] executePython failed:', err)
            setCodeCells(prev => prev[cellId] ? { ...prev, [cellId]: { ...prev[cellId], status: 'error', errorType: 'KernelError', errorMessage: err?.message || String(err), traceback: '' } } : prev)
            const ws = wsRef.current
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'python_error', requestId: cellId, errorType: 'KernelError', message: err?.message || String(err), traceback: '', stdout: '', stderr: '' }))
            }
          })
        }
        if (msg.type === 'error') { setError(msg.message); timeoutsRef.current.push(setTimeout(() => setError(null), 5000)) }
        if (msg.type === 'integration_needs_fields') {
          setPendingFields({ slug: msg.slug, fields: msg.fields })
        }
        if (msg.type === 'integration_fda_required') {
          setError(msg.message)
        }
        if (msg.type === 'integration_auth_url') {
          setPendingFields(null)
          open(msg.url).catch(console.error)
          let attempts = 0
          const poll = setInterval(() => {
            attempts++
            wsRef.current?.send(JSON.stringify({ type: 'get_integrations' } as WSClientMessage))
            if (attempts >= 18) { clearInterval(poll); pollIntervalsBySlug.current.delete(msg.slug) }
          }, 5000)
          pollIntervals.current.push(poll)
          pollIntervalsBySlug.current.set(msg.slug, poll)
        }
      }

      wsRef.current = socket
    }

    connect()

    return () => {
      unmounted = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (processingTimeoutRef.current) { clearTimeout(processingTimeoutRef.current); processingTimeoutRef.current = null }
      pollIntervals.current.forEach(clearInterval)
      pollIntervals.current = []
      pollIntervalsBySlug.current.forEach(clearInterval)
      pollIntervalsBySlug.current.clear()
      timeoutsRef.current.forEach(clearTimeout)
      timeoutsRef.current = []
      wsRef.current?.close()
    }
  }, [])

  // ── Persist messages to localStorage for instant load on restart ─────────────
  useEffect(() => { saveCache({ messages: messages.slice(-50) }) }, [messages])
  // Persist code cells + their order so Python outputs survive server restarts,
  // HMR reloads, and webview refreshes. Cells re-anchor themselves against
  // restored chat history in the chat_history handler above.
  useEffect(() => { saveCache({ codeCells, codeCellOrder }) }, [codeCells, codeCellOrder])

  // ── Voice: allow App.tsx to send WS messages via custom event ───────────────
  useEffect(() => {
    function handleWsSend(e: Event) {
      const detail = (e as CustomEvent).detail
      if (detail && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(detail))
      }
    }
    window.addEventListener('coagent-ws-send', handleWsSend)
    return () => window.removeEventListener('coagent-ws-send', handleWsSend)
  }, [])

  // ── Global HTML5 drag-drop (always active, works from any view) ─────────────
  useEffect(() => {
    function handleDragOver(e: DragEvent) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    function handleDrop(e: DragEvent) {
      // Component-level drop handlers (e.g. FilesPane folder card) stop native
      // propagation via stopImmediatePropagation, so this listener won't fire
      // for drops that already landed somewhere more specific.
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (!files?.length) return
      const group = currentFileDropTarget
      for (const file of files) {
        readFileAsBase64(file).then((base64) => {
          const msg: WSClientMessage = {
            type: 'ingest_file',
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            data: base64,
            ...(group ? { group } : {}),
          }
          wsRef.current?.send(JSON.stringify(msg))
        }).catch((err) => {
          setError(err?.message || `Could not read "${file.name}"`)
          timeoutsRef.current.push(setTimeout(() => setError(null), 5000))
        })
      }
    }
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('drop', handleDrop)
    return () => {
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('drop', handleDrop)
    }
  }, [])

  const send = useCallback((msg: WSClientMessage) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('Connection lost — reconnecting…')
      setProcessing(false)
      timeoutsRef.current.push(setTimeout(() => setError(null), 3000))
      return
    }
    wsRef.current.send(JSON.stringify(msg))
  }, [])

  const chat = useCallback((message: string) => {
    // Guard: ignore empty/whitespace-only messages
    if (!message.trim()) return
    // Guard: prevent double-send while already processing
    if (processingRef.current) return
    processingRef.current = true
    setProcessing(true)
    // Safety net: if the WebSocket dies mid-flight the server never responds,
    // so processing would stay true forever. Auto-reset after 120 s.
    if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current)
    processingTimeoutRef.current = setTimeout(() => {
      console.warn('[useAgent] processing timeout — auto-resetting (WS may have dropped)')
      processingTimeoutRef.current = null
      setProcessing(false)
    }, 120_000)
    setMessages(prev => [...prev, makeMsg('user', message)].slice(-100))
    const fileIds = recentIngestedFiles.current.map(f => f.id)
    recentIngestedFiles.current = []
    send({ type: 'chat', message, ...(fileIds.length ? { fileIds } : {}) })
  }, [send])

  const steer = useCallback((message: string) => {
    // Snapshot current streaming text as a completed message, then show the steer
    setStreamingText(current => {
      if (current) {
        setMessages(prev => [
          ...prev,
          makeMsg('assistant', current),
          makeMsg('user', message),
        ].slice(-100))
      } else {
        setMessages(prev => [
          ...prev,
          makeMsg('user', message),
        ].slice(-100))
      }
      return null
    })
    send({ type: 'steer', message })
  }, [send])

  const stopAgent = useCallback(() => {
    send({ type: 'stop_agent' })
    setThinking(false)
    setStreamingText(null)
    setToolLabel(null)
    if (processingTimeoutRef.current) { clearTimeout(processingTimeoutRef.current); processingTimeoutRef.current = null }
    setProcessing(false)
    // Always reset voice pill state
    if (isVoiceActive()) {
      setVoiceActive(false)
      import('@/lib/voice').then(v => { v.cancelTts(); v.showVoiceSummary('') })
    }
  }, [send])

  const approve = useCallback((id: string) => send({ type: 'approve', id }), [send])
  const reject = useCallback((id: string) => send({ type: 'reject', id }), [send])
  const editQueueItem = useCallback((id: string, detail: string) => send({ type: 'edit_queue_item', id, detail }), [send])
  const dismissQueueToast = useCallback(() => setNewQueueIds(new Set()), [])
  const connectIntegration = useCallback((slug: string, params?: Record<string, string>) => {
    send({ type: 'integration_connect', slug, params })
  }, [send])
  const disconnectIntegration = useCallback((slug: string) => send({ type: 'integration_disconnect', slug }), [send])

  const updateSkill = useCallback((name: string, description: string, instructions: string) => {
    send({ type: 'update_skill', name, description, instructions })
  }, [send])
  const deleteSkill = useCallback((name: string) => {
    send({ type: 'delete_skill', name })
  }, [send])

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    send({ type: 'update_settings', patch })
  }, [send])

  const activateRelay = useCallback((token: string, relayUrl: string) => {
    send({ type: 'relay_activate', token, relayUrl })
  }, [send])

  const refreshRelayStatus = useCallback(() => {
    send({ type: 'get_relay_status' })
  }, [send])

  const handleSetRelayModel = useCallback((model: string) => {
    setRelayModel(model)
    send({ type: 'set_model', model })
  }, [send])

  const setModel = useCallback((model: string) => {
    send({ type: 'set_model', model })
  }, [send])

  const updateAuth = useCallback((method: AuthMethod, credential: string) => send({ type: 'update_auth', method, credential }), [send])
  const verifyAuth = useCallback(() => send({ type: 'verify_auth' }), [send])

  const ingestFile = useCallback((filename: string, mimeType: string, data: string, group?: string) => {
    send({ type: 'ingest_file', filename, mimeType, data, ...(group ? { group } : {}) })
  }, [send])

  const deleteFile = useCallback((id: string) => {
    send({ type: 'delete_file', id })
  }, [send])

  const ingestFilePaths = useCallback((paths: string[], group?: string) => {
    send({ type: 'ingest_file_paths', paths, ...(group ? { group } : {}) })
  }, [send])

  const createFolder = useCallback((name: string) => {
    send({ type: 'create_folder', name })
  }, [send])

  const moveFile = useCallback((id: string, targetGroup: string) => {
    send({ type: 'move_file', id, targetGroup })
  }, [send])

  const renameFile = useCallback((id: string, newName: string) => {
    send({ type: 'rename_file', id, newName })
  }, [send])

  const renameFolder = useCallback((oldName: string, newName: string) => {
    send({ type: 'rename_folder', oldName, newName })
  }, [send])

  const deleteFolder = useCallback((name: string) => {
    send({ type: 'delete_folder', name })
  }, [send])

  const reorderFolders = useCallback((order: string[]) => {
    send({ type: 'reorder_folders', order })
  }, [send])

  const moveFolder = useCallback((folderPath: string, newParentPath: string) => {
    send({ type: 'move_folder', folderPath, newParentPath })
  }, [send])

  const searchFilesUI = useCallback((query: string) => {
    if (!query.trim()) {
      setSearchResults(null)
      return
    }
    send({ type: 'search_files_ui', query })
  }, [send])

  const refreshUsage = useCallback(() => { send({ type: 'get_usage' }) }, [send])

  const autoOrganize = useCallback(() => {
    setOrganizing(true)
    send({ type: 'auto_organize' })
  }, [send])

  const completeCalendarEntry = useCallback((id: string) => {
    send({ type: 'complete_calendar_entry', id })
  }, [send])

  const deleteCalendarEntry = useCallback((id: string) => {
    send({ type: 'delete_calendar_entry', id })
  }, [send])

  const googleCalendarConnect = useCallback(() => {
    send({ type: 'google_calendar_connect' })
  }, [send])

  const googleCalendarDisconnect = useCallback(() => {
    send({ type: 'google_calendar_disconnect' })
  }, [send])

  const googleCalendarToggle = useCallback((calendarId: string, enabled: boolean) => {
    send({ type: 'google_calendar_toggle', calendarId, enabled })
  }, [send])

  const googleCalendarColor = useCallback((calendarId: string, color: string) => {
    send({ type: 'google_calendar_color', calendarId, color })
  }, [send])

  const googleCalendarSync = useCallback(() => {
    send({ type: 'google_calendar_sync' })
  }, [send])

  const confirmCapabilities = useCallback((selected: string[], authValues?: Record<string, string>) => {
    send({ type: 'capability_confirm', capabilities: selected, authValues } as any)
    timeoutsRef.current.push(setTimeout(() => setCapabilityCard(null), 1500))
  }, [send])

  const deleteCustomIntegration = useCallback((slug: string) => send({ type: 'custom_integration_delete', slug }), [send])

  const toggleTrigger = useCallback((triggerSlug: string, appSlug: string, enabled: boolean) => {
    send({ type: 'toggle_trigger', triggerSlug, appSlug, enabled })
  }, [send])

  const getRelayCredentials = useCallback(async () => {
    setRelayCredentials(null)
    try {
      const json = await invoke<string>('get_relay_credentials')
      const creds = JSON.parse(json)
      setRelayCredentials({ type: 'relay_credentials', ...creds })
    } catch (err) {
      console.error('[Relay] Failed to get credentials via IPC:', err)
    }
  }, [])

  const adminCreateToken = useCallback((label: string) => {
    send({ type: 'admin_create_token', label })
  }, [send])

  const adminListTokens = useCallback(() => {
    send({ type: 'admin_list_tokens' })
  }, [send])

  const adminRevokeToken = useCallback((token: string) => {
    send({ type: 'admin_revoke_token', token })
  }, [send])

  const clearAdminNewToken = useCallback(() => {
    setAdminNewToken(null)
  }, [])

  const lastSentRef = useRef<{ text: string; time: number }>({ text: '', time: 0 })
  const sendTeamMessage = useCallback((message: string, to?: string) => {
    // Guard against double-sends (StrictMode / rapid clicks)
    const now = Date.now()
    if (message === lastSentRef.current.text && now - lastSentRef.current.time < 1000) return
    lastSentRef.current = { text: message, time: now }

    send({ type: 'team_send', message, to } as any)
    // Optimistic echo — relay doesn't send back to sender
    setTeamMessages(prev => [...prev, {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      teamId: '',
      timestamp: new Date().toISOString(),
      from: { userId: 'default', name: settings?.name || 'Me', role: '', isAgent: false },
      visible: message, agentContext: '', to: to || null, attachments: []
    }])
  }, [send, settings?.name])

  const getTeamInfo = useCallback(() => {
    send({ type: 'get_team_info' } as any)
  }, [send])

  const getTeamHistory = useCallback((limit = 50) => {
    send({ type: 'team_history', limit } as any)
  }, [send])

  const openCanvas = useCallback((canvasId: string) => {
    send({ type: 'canvas_open', canvasId } as any)
  }, [send])

  const getCanvases = useCallback(() => {
    send({ type: 'get_canvases' } as any)
  }, [send])

  const closeCanvas = useCallback(() => {
    setCanvasVisible(false)
    setCanvasStreaming(false)
    setCanvasStreamingCode(null)
    send({ type: 'canvas_close' })
  }, [send])

  const exportPdf = useCallback(async (path: string, base64: string) => {
    await invoke('write_pdf_file', { path, base64 })
  }, [])

  const triggerHeartbeat = useCallback(() => {
    send({ type: 'trigger_heartbeat' })
  }, [send])

  const cancelCodeCell = useCallback((cellId: string) => {
    const cell = codeCellsRef.current[cellId]
    const conversationId = cell?.conversationId || 'main'
    cancelConversation(conversationId)
    setCodeCells(prev => prev[cellId] && prev[cellId].status === 'running' ? { ...prev, [cellId]: { ...prev[cellId], status: 'cancelled' } } : prev)
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'python_cancelled', requestId: cellId, reason: 'user' }))
    }
  }, [])

  // Stable actions object — all callbacks are already memoized with useCallback,
  // so this only changes when a callback identity changes (rare). Keeping it
  // separate prevents consumers that only use actions from re-rendering on every
  // streaming chunk.
  const actions = useMemo(() => ({
    triggerHeartbeat, updateSkill, deleteSkill, steer, stopAgent,
    setRelayModel: handleSetRelayModel, setPendingFields, setModel, chat, approve, reject,
    editQueueItem, connectIntegration, disconnectIntegration, updateSettings, updateAuth,
    verifyAuth, activateRelay, refreshRelayStatus, ingestFile, deleteFile, ingestFilePaths,
    createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder,
    searchFilesUI, refreshUsage, autoOrganize, completeCalendarEntry, deleteCalendarEntry,
    googleCalendarConnect, googleCalendarDisconnect, googleCalendarToggle, googleCalendarColor,
    googleCalendarSync, confirmCapabilities, deleteCustomIntegration, toggleTrigger,
    getRelayCredentials, clearAdminNewToken, adminCreateToken, adminListTokens, adminRevokeToken,
    sendTeamMessage, getTeamInfo, getTeamHistory, setTriggerPrompt, openCanvas, closeCanvas,
    getCanvases, cancelCodeCell, exportPdf, dismissQueueToast,
  }), [
    triggerHeartbeat, updateSkill, deleteSkill, steer, stopAgent,
    handleSetRelayModel, setPendingFields, setModel, chat, approve, reject,
    editQueueItem, connectIntegration, disconnectIntegration, updateSettings, updateAuth,
    verifyAuth, activateRelay, refreshRelayStatus, ingestFile, deleteFile, ingestFilePaths,
    createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder,
    searchFilesUI, refreshUsage, autoOrganize, completeCalendarEntry, deleteCalendarEntry,
    googleCalendarConnect, googleCalendarDisconnect, googleCalendarToggle, googleCalendarColor,
    googleCalendarSync, confirmCapabilities, deleteCustomIntegration, toggleTrigger,
    getRelayCredentials, clearAdminNewToken, adminCreateToken, adminListTokens, adminRevokeToken,
    sendTeamMessage, getTeamInfo, getTeamHistory, setTriggerPrompt, openCanvas, closeCanvas,
    getCanvases, cancelCodeCell, exportPdf, dismissQueueToast,
  ])

  return {
    // Volatile state (changes on every streaming chunk)
    streamingText, thinking, processing, toolLabel, researchAgents,
    // Less-frequent state
    queue, done, newQueueIds, messages, connected, hydrated, lastHeartbeat, heartbeatLog, statusLine, skills,
    integrations, settings, authStatus, files, folders, searchResults, transcribingFiles,
    error, relayActive, relayModel, relayUsage, pendingFields, voiceSummary, usage,
    organizing, calendarEntries, googleCalendarStatus, capabilityCard, whatsappQr,
    relayCredentials, isAdmin, adminUsers, adminNewToken, teamInfo, teamMessages, teamStatus,
    triggerPrompt, canvas, canvasVisible, canvasStreaming, canvasStreamingCode,
    canvasesList, codeCells, codeCellOrder,
    // Stable actions (memoized above)
    ...actions,
  }
}
