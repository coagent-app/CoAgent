import { useState, useEffect, useRef, useCallback } from 'react'
import { AppState } from 'react-native'
import * as Notifications from 'expo-notifications'
import type {
  AgentMessage,
  AgentSettings,
  WSClientMessage,
  WSServerMessage,
} from '@coagent/shared'
import { getCredentials } from './storage'
import { registerForPushNotifications } from './notifications'

const RECONNECT_BASE = 500
const RECONNECT_MAX = 8000
const HEALTH_CHECK_INTERVAL = 5000

interface FileContentResult {
  filename: string
  mimeType: string
  data: string  // base64
}

type FileContentResolver = {
  resolve: (result: FileContentResult) => void
  reject: (err: Error) => void
}

export function useAgent() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(RECONNECT_BASE)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const healthTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const unmountedRef = useRef(false)
  const connectingRef = useRef(false)
  const fileContentPending = useRef<Map<string, FileContentResolver>>(new Map())

  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [toolLabel, setToolLabel] = useState<string | null>(null)
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [notificationMode, setNotificationMode] = useState<string>('away_only')

  function send(msg: WSClientMessage) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }

  const connect = useCallback(async () => {
    if (unmountedRef.current || connectingRef.current) return
    // Don't open a new socket if one is already open or connecting
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    connectingRef.current = true
    const creds = await getCredentials()
    if (!creds) { connectingRef.current = false; return }

    const base = creds.relayUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://')
    const wsUrl = `${base}/ws/${creds.userId}?token=${creds.token}&client=mobile`
    console.log('[useAgent] Connecting to:', wsUrl)

    try {
      const socket = new WebSocket(wsUrl)

      socket.onopen = () => {
        console.log('[useAgent] Connected')
        setConnected(true)
        reconnectDelay.current = RECONNECT_BASE
        connectingRef.current = false

        // Register push token with relay
        registerForPushNotifications().then(pushToken => {
          if (pushToken && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'register_push_token', token: pushToken }))
            console.log('[useAgent] Push token registered')
          }
        }).catch(err => console.warn('[useAgent] Push registration failed:', err))
      }

      socket.onerror = (e) => {
        console.warn('[useAgent] WebSocket error', e)
        connectingRef.current = false
      }

      socket.onclose = () => {
        console.log('[useAgent] Disconnected')
        setConnected(false)
        connectingRef.current = false
        if (wsRef.current === socket) wsRef.current = null
        scheduleReconnect()
      }

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data) as WSServerMessage
        switch (msg.type) {
          case 'chat_history':
            setMessages(msg.messages)
            break
          case 'chat_chunk':
            setStreamingText(prev => (prev ?? '') + msg.text)
            setThinking(false)
            break
          case 'chat_segment_end':
            setStreamingText(prev => {
              if (prev) {
                setMessages(msgs => [
                  ...msgs,
                  { role: 'assistant', content: prev, timestamp: new Date().toISOString() },
                ])
              }
              return null
            })
            break
          case 'chat_response':
            // Server-injected user messages (e.g. scheduled task fired) — add directly
            if (msg.message.role === 'user') {
              setMessages(msgs => [...msgs, msg.message])
            }
            // Flush any remaining streaming text as a final bubble
            setStreamingText(prev => {
              if (prev?.trim()) {
                setMessages(msgs => [...msgs, { role: 'assistant', content: prev, timestamp: new Date().toISOString() }])
              }
              return null
            })
            setProcessing(false)
            setToolLabel(null)
            break
          case 'agent_thinking':
            setThinking(true)
            break
          case 'tool_start':
            setToolLabel(msg.label)
            setThinking(false)
            break
          case 'tool_end':
            setToolLabel(null)
            break
          case 'settings_update':
            setSettings(msg.settings)
            break
          case 'error':
            setError(msg.message)
            setTimeout(() => setError(null), 5000)
            break
          case 'voice_tts_chunk':
            setTtsPlaying(true)
            ;(globalThis as any).__ttsChunkHandler?.(msg.data, msg.seq)
            break
          case 'voice_tts_done':
            setTtsPlaying(false)
            ;(globalThis as any).__ttsDoneHandler?.()
            break
          case 'voice_transcribed':
            setMessages(msgs => [
              ...msgs,
              { role: 'user', content: msg.text, timestamp: new Date().toISOString() },
            ])
            break
          case 'file_content': {
            const pending = fileContentPending.current.get(msg.id)
            if (pending) {
              fileContentPending.current.delete(msg.id)
              pending.resolve({ filename: msg.filename, mimeType: msg.mimeType, data: msg.data })
            }
            break
          }
          case 'file_content_error': {
            const pending = fileContentPending.current.get(msg.id)
            if (pending) {
              fileContentPending.current.delete(msg.id)
              pending.reject(new Error(msg.error))
            }
            break
          }
          case 'agent_stopped':
            setProcessing(false)
            setStreamingText(null)
            setToolLabel(null)
            setThinking(false)
            break
          case 'notification_prefs':
            setNotificationMode(msg.mode)
            break
          case 'push_notification':
            // Show local notification when app is in foreground
            Notifications.scheduleNotificationAsync({
              content: { title: msg.title, body: msg.body },
              trigger: null, // immediate
            }).catch(() => {})
            break
        }
      }

      wsRef.current = socket
    } catch (err) {
      console.error('[useAgent] Connection failed:', err)
      connectingRef.current = false
      scheduleReconnect()
    }
  }, [])

  function scheduleReconnect() {
    if (unmountedRef.current) return
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    const delay = reconnectDelay.current
    reconnectDelay.current = Math.min(delay * 1.5, RECONNECT_MAX)
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null
      connect()
    }, delay)
  }

  useEffect(() => {
    connect()

    // Periodic health check — catches silently dead connections
    healthTimer.current = setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        setConnected(false)
        wsRef.current = null
        connect()
      }
    }, HEALTH_CHECK_INTERVAL)

    // Reconnect immediately when app comes back to foreground
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        reconnectDelay.current = RECONNECT_BASE // reset backoff
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
          connect()
        }
      }
    })

    return () => {
      unmountedRef.current = true
      sub.remove()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      if (healthTimer.current) clearInterval(healthTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const chat = useCallback((message: string) => {
    setMessages(msgs => [
      ...msgs,
      { role: 'user', content: message, timestamp: new Date().toISOString() },
    ])
    setProcessing(true)
    setThinking(true)
    send({ type: 'chat', message })
  }, [])

  const sendVoiceAudio = useCallback((base64: string) => {
    setProcessing(true)
    send({ type: 'voice_audio', data: base64, format: 'm4a' })
  }, [])

  const stopAgent = useCallback(() => {
    send({ type: 'stop_agent' })
  }, [])

  const updateNotificationMode = useCallback((mode: string) => {
    setNotificationMode(mode)
    send({ type: 'update_notification_prefs', mode } as any)
  }, [])

  const requestFileContent = useCallback((fileId: string): Promise<FileContentResult | null> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        resolve(null)
        return
      }
      // Timeout after 15s
      const timeout = setTimeout(() => {
        fileContentPending.current.delete(fileId)
        resolve(null)
      }, 15000)
      fileContentPending.current.set(fileId, {
        resolve: (result) => { clearTimeout(timeout); resolve(result) },
        reject: (err) => { clearTimeout(timeout); reject(err) },
      })
      send({ type: 'get_file_content', id: fileId })
    })
  }, [])

  return {
    connected,
    messages,
    streamingText,
    thinking,
    processing,
    toolLabel,
    settings,
    error,
    ttsPlaying,
    notificationMode,
    chat,
    sendVoiceAudio,
    stopAgent,
    requestFileContent,
    updateNotificationMode,
  }
}
