import { useState, useEffect, useCallback, useRef } from 'react'
import { open } from '@tauri-apps/plugin-shell'
import type { ApprovalItem, DoneItem, TodoItem, AgentMessage, WSServerMessage, WSClientMessage, Integration, AgentSettings, FileEntry, AuthStatus, AuthMethod, RelayUsage } from '@coagent/shared'

const WS_URL = 'ws://localhost:7830'
const RECONNECT_BASE = 250
const RECONNECT_MAX = 10000

export function useAgent() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelay = useRef(RECONNECT_BASE)
  const pollIntervals = useRef<ReturnType<typeof setInterval>[]>([])
  const recentIngestedFiles = useRef<{ id: string; filename: string }[]>([])
  const [queue, setQueue] = useState<ApprovalItem[]>([])
  const [done, setDone] = useState<DoneItem[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [connected, setConnected] = useState(false)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toolLabel, setToolLabel] = useState<string | null>(null)
  const [lastHeartbeat, setLastHeartbeat] = useState<{ time: Date; status: string } | null>(null)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [activeDocument, setActiveDocument] = useState<{ id: string; filename: string; content: string } | null>(null)
  const [pendingFields, setPendingFields] = useState<{ slug: string; fields: { name: string; displayName: string; description: string }[] } | null>(null)
  const [relayActive, setRelayActive] = useState<boolean>(false)
  const [relayModel, setRelayModel] = useState<string | null>(null)
  const [relayUsage, setRelayUsage] = useState<RelayUsage | null>(null)
  const [apiKeyStatus, setApiKeyStatus] = useState<{ anthropic: boolean; composio: boolean; openai: boolean } | null>(null)
  const [voiceSummary, setVoiceSummary] = useState<string | null>(null)

  // Document streaming — buffer chunks in ref, flush to React state each frame
  const docStreamBuf = useRef('')
  const docRafId = useRef<number | null>(null)

  function docStreamFlush() {
    const content = docStreamBuf.current
    setActiveDocument(prev => prev?.id === '_streaming' ? { ...prev, content } : prev)
    docRafId.current = null
  }

  function docStreamSchedule() {
    if (docRafId.current === null) {
      docRafId.current = requestAnimationFrame(docStreamFlush)
    }
  }

  useEffect(() => {
    let unmounted = false

    function connect() {
      if (unmounted) return
      const socket = new WebSocket(WS_URL)

      socket.onopen = () => {
        setConnected(true)
        reconnectDelay.current = RECONNECT_BASE
      }

      socket.onclose = () => {
        setConnected(false)
        if (wsRef.current === socket) wsRef.current = null
        if (!unmounted) {
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, RECONNECT_MAX)
            connect()
          }, reconnectDelay.current)
        }
      }

      socket.onmessage = (event) => {
        const msg: WSServerMessage = JSON.parse(event.data)
        if (msg.type === 'queue_update') setQueue(msg.items)
        if (msg.type === 'done_update') setDone(msg.items)
        if (msg.type === 'todo_update') setTodos(msg.items)
        if (msg.type === 'agent_thinking') {
          setThinking(true)
          setStreamingText(null)
          setToolLabel(null)
        }
        if (msg.type === 'tool_start') {
          // Snapshot current streaming text as a completed bubble
          setStreamingText(current => {
            if (current?.trim()) {
              setMessages(prev => [...prev, { role: 'assistant' as const, content: current, timestamp: new Date().toISOString() }].slice(-100))
            }
            return null
          })
          setToolLabel(msg.label)
          setThinking(true)
          // Forward tool label to voice pill if voice is active
          if ((window as any).__voiceActive) {
            import('@/lib/voice').then(v => v.showVoiceToolLabel(msg.label))
          }
        }
        if (msg.type === 'chat_chunk') {
          setThinking(false)
          setToolLabel(null)
          setStreamingText(prev => (prev ?? '') + msg.text)
          // Forward just the first sentence to voice pill
          if ((window as any).__voiceActive) {
            import('@/lib/voice').then(v => v.showVoiceResponse(msg.text))
          }
        }
        if (msg.type === 'chat_response') {
          // Snapshot any remaining streaming text as a final bubble
          setStreamingText(current => {
            if (current?.trim()) {
              setMessages(prev => [...prev, { role: 'assistant' as const, content: current, timestamp: new Date().toISOString() }].slice(-100))
            }
            return null
          })
          setThinking(false)
          setToolLabel(null)
          setProcessing(false)
          // Dismiss voice pill if it was active (covers both normal completion and stop)
          if ((window as any).__voiceActive) {
            ;(window as any).__voiceActive = false
            import('@/lib/voice').then(v => v.showVoiceSummary(''))
          }
        }
        if (msg.type === 'chat_history') setMessages(msg.messages)
        if (msg.type === 'integrations_update') setIntegrations(msg.integrations)
        if (msg.type === 'settings_update') setSettings(msg.settings)
        if (msg.type === 'auth_status') setAuthStatus(msg.status)
        if (msg.type === 'files_update') setFiles(msg.files)
        if (msg.type === 'folders_update') setFolders(msg.folders)
        if (msg.type === 'files_search_result') setSearchResults(msg.files)
        if (msg.type === 'document_stream_start') {
          docStreamBuf.current = ''
          if (docRafId.current !== null) { cancelAnimationFrame(docRafId.current); docRafId.current = null }
          setActiveDocument({ id: '_streaming', filename: msg.filename, content: '' })
        }
        if (msg.type === 'document_stream_chunk') {
          docStreamBuf.current += msg.text
          docStreamSchedule()
        }
        if (msg.type === 'document_opened') {
          if (docRafId.current !== null) { cancelAnimationFrame(docRafId.current); docRafId.current = null }
          docStreamBuf.current = ''
          setActiveDocument({ id: msg.id, filename: msg.filename, content: msg.content })
        }
        if (msg.type === 'document_updated') setActiveDocument(prev => prev?.id === msg.id ? { ...prev, content: msg.content } : prev)
        if (msg.type === 'document_closed') setActiveDocument(null)
        if (msg.type === 'relay_status') {
          setRelayActive(msg.active)
          setRelayModel(msg.model)
          setRelayUsage(msg.usage)
        }
        if (msg.type === 'api_keys_status') setApiKeyStatus(msg.keys)
        if (msg.type === 'file_ingested') recentIngestedFiles.current.push({ id: msg.id, filename: msg.filename })
        if (msg.type === 'heartbeat') setLastHeartbeat({ time: new Date(), status: msg.status })
        if (msg.type === 'skills_update') setSkills(msg.skills)
        if (msg.type === 'voice_transcribed') {
          // Show the user's voice input in chat (dedupe in case of multiple connections)
          setMessages(prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'user' && last.content === msg.text) return prev
            return [...prev, { role: 'user' as const, content: msg.text, timestamp: new Date().toISOString() }].slice(-100)
          })
          import('@/lib/voice').then(v => v.resetVoiceResponse())
        }
        if (msg.type === 'voice_summary') {
          setVoiceSummary(msg.summary)
          // Show summary in pill, then auto-hide after delay
          import('@/lib/voice').then(v => v.showVoiceSummary(msg.summary))
        }
        if (msg.type === 'error') { setError(msg.message); setTimeout(() => setError(null), 5000) }
        if (msg.type === 'integration_needs_fields') {
          setPendingFields({ slug: msg.slug, fields: msg.fields })
        }
        if (msg.type === 'integration_auth_url') {
          setPendingFields(null)
          open(msg.url).catch(console.error)
          let attempts = 0
          const poll = setInterval(() => {
            attempts++
            wsRef.current?.send(JSON.stringify({ type: 'get_integrations' } as WSClientMessage))
            if (attempts >= 18) clearInterval(poll)
          }, 5000)
          pollIntervals.current.push(poll)
        }
      }

      wsRef.current = socket
    }

    connect()

    return () => {
      unmounted = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      pollIntervals.current.forEach(clearInterval)
      wsRef.current?.close()
    }
  }, [])

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
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (!files?.length) return
      for (const file of files) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          const result = ev.target?.result as string
          const base64 = result.split(',')[1] ?? ''
          if (!base64) return
          const msg: WSClientMessage = { type: 'ingest_file', filename: file.name, mimeType: file.type || 'application/octet-stream', data: base64 }
          wsRef.current?.send(JSON.stringify(msg))
        }
        reader.readAsDataURL(file)
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
    wsRef.current?.send(JSON.stringify(msg))
  }, [])

  const chat = useCallback((message: string) => {
    setProcessing(true)
    setMessages(prev => [...prev, { role: 'user' as const, content: message, timestamp: new Date().toISOString() }].slice(-100))
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
          { role: 'assistant' as const, content: current, timestamp: new Date().toISOString() },
          { role: 'user' as const, content: message, timestamp: new Date().toISOString() }
        ].slice(-100))
      } else {
        setMessages(prev => [
          ...prev,
          { role: 'user' as const, content: message, timestamp: new Date().toISOString() }
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
    setProcessing(false)
  }, [send])

  const approve = useCallback((id: string) => send({ type: 'approve', id }), [send])
  const reject = useCallback((id: string) => send({ type: 'reject', id }), [send])
  const editQueueItem = useCallback((id: string, detail: string) => send({ type: 'edit_queue_item', id, detail }), [send])
  const completeTodo = useCallback((id: string) => send({ type: 'complete_todo', id }), [send])
  const deleteTodo = useCallback((id: string) => send({ type: 'delete_todo', id }), [send])
  const connectIntegration = useCallback((slug: string, params?: Record<string, string>) => send({ type: 'integration_connect', slug, params }), [send])
  const disconnectIntegration = useCallback((slug: string) => send({ type: 'integration_disconnect', slug }), [send])

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

  const updateApiKeys = useCallback((keys: { anthropic?: string; composio?: string; openai?: string }) => {
    send({ type: 'update_api_keys', keys })
  }, [send])

  const updateAuth = useCallback((method: AuthMethod, credential: string) => send({ type: 'update_auth', method, credential }), [send])
  const verifyAuth = useCallback(() => send({ type: 'verify_auth' }), [send])

  const ingestFile = useCallback((filename: string, mimeType: string, data: string) => {
    send({ type: 'ingest_file', filename, mimeType, data })
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

  const updateDocument = useCallback((id: string, content: string) => {
    send({ type: 'update_document', id, content })
  }, [send])

  const openDocument = useCallback((id: string) => send({ type: 'open_document', id }), [send])

  const closeDocument = useCallback(() => {
    send({ type: 'close_document' })
    setActiveDocument(null)
  }, [send])

  return { queue, done, todos, messages, streamingText, thinking, processing, toolLabel, connected, lastHeartbeat, skills, steer, stopAgent, integrations, settings, authStatus, files, folders, searchResults, error, activeDocument, relayActive, relayModel, setRelayModel: handleSetRelayModel, relayUsage, apiKeyStatus, pendingFields, setPendingFields, updateApiKeys, setModel, chat, approve, reject, editQueueItem, completeTodo, deleteTodo, connectIntegration, disconnectIntegration, updateSettings, updateAuth, verifyAuth, activateRelay, refreshRelayStatus, ingestFile, deleteFile, ingestFilePaths, createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder, searchFilesUI, openDocument, updateDocument, closeDocument, voiceSummary }
}
