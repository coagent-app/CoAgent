import React, { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

type PillState = 'listening' | 'thinking' | 'working' | 'responding' | 'result' | 'hidden'

const pillStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 20px',
  borderRadius: 9999,
  background: '#171717',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
  border: '1px solid rgba(64,64,64,0.5)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  maxWidth: 400,
}

const iconStyle: React.CSSProperties = { flexShrink: 0, width: 16, height: 16 }
const labelStyle: React.CSSProperties = { color: '#a3a3a3' }
const responseStyle: React.CSSProperties = { color: '#e5e5e5', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden' }

function MicIcon() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  )
}

function SpinnerIcon({ color }: { color: string }) {
  return (
    <svg style={{ ...iconStyle, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </svg>
  )
}

export function VoicePill() {
  const [state, setState] = useState<PillState>('hidden')
  const [text, setText] = useState('')

  useEffect(() => {
    const unlistens: Promise<() => void>[] = []

    unlistens.push(listen<{ state: string; summary?: string }>('voice-state', (event) => {
      const { state: s, summary } = event.payload
      setState(s as PillState)
      if (summary !== undefined) setText(summary)
      if (s === 'hidden') {
        getCurrentWebviewWindow().hide().catch(() => {})
      }
    }))

    unlistens.push(listen('voice-fn-press', () => {
      setState('listening')
      setText('')
    }))

    return () => { unlistens.forEach(p => p.then(fn => fn())) }
  }, [])

  if (state === 'hidden') return null

  return (
    <div style={pillStyle}>
      {state === 'listening' && (
        <>
          <MicIcon />
          <span style={labelStyle}>Listening...</span>
        </>
      )}
      {state === 'thinking' && (
        <>
          <SpinnerIcon color="#60a5fa" />
          <span style={labelStyle}>Thinking...</span>
        </>
      )}
      {state === 'working' && (
        <>
          <SpinnerIcon color="#fbbf24" />
          <span style={{ ...labelStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text || 'Working...'}</span>
        </>
      )}
      {(state === 'responding' || state === 'result') && (
        <span style={responseStyle}>{text}</span>
      )}
    </div>
  )
}
