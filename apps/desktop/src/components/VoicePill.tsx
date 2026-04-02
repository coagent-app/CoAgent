import React, { useState, useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'

type PillState = 'idle' | 'listening' | 'thinking' | 'working' | 'responding' | 'result' | 'hidden'

const KEYFRAMES = `
@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
`

const baseFont: React.CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 13,
  fontWeight: 500,
  color: '#fff',
}

const iconStyle: React.CSSProperties = { flexShrink: 0, width: 16, height: 16 }
const labelStyle: React.CSSProperties = { color: '#a3a3a3' }
const responseStyle: React.CSSProperties = { color: '#e5e5e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as any, minWidth: 0, flex: 1, fontSize: 13, lineHeight: '16px' }

// Vertical audio bars — idle has gentle wave, listening reacts to volume
function AudioBars({ volume, idle, small }: { volume: number; idle?: boolean; small?: boolean }) {
  const barCount = small ? 4 : 5
  const barWidth = 2
  const gap = 2
  const maxH = small ? 10 : 14
  const minH = small ? 2 : 3
  const totalW = barCount * barWidth + (barCount - 1) * gap
  const svgStyle = small ? { flexShrink: 0, width: 14, height: 10 } : iconStyle

  // Idle: gentle sine wave offset per bar
  // Active: bars scale with volume, slight variation per bar
  const now = useAnimationFrame(idle ? 60 : 0) // only animate idle
  const bars: number[] = []

  for (let i = 0; i < barCount; i++) {
    if (idle) {
      // Gentle wave: each bar offset in phase
      const phase = (now / 800) + (i * 0.7)
      const wave = Math.sin(phase) * 0.3 + 0.35 // 0.05 to 0.65
      bars.push(minH + wave * (maxH - minH) * 0.4)
    } else {
      // Volume-reactive with slight per-bar variation
      const variation = [0.7, 1.0, 0.85, 1.0, 0.65][i]
      const h = minH + volume * (maxH - minH) * variation
      bars.push(Math.max(minH, h))
    }
  }

  const color = idle ? 'rgba(255,255,255,0.5)' : '#ffffff'

  return (
    <svg style={svgStyle} viewBox={`0 0 ${totalW} ${maxH}`}>
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * (barWidth + gap)}
          y={maxH - h}
          width={barWidth}
          height={h}
          rx={1}
          fill={color}
          style={{ transition: idle ? 'none' : 'height 0.08s ease, y 0.08s ease' }}
        />
      ))}
    </svg>
  )
}

// Simple animation frame hook — returns timestamp for smooth idle animation
function useAnimationFrame(fps: number): number {
  const [time, setTime] = useState(0)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (fps <= 0) return
    let last = 0
    const interval = 1000 / fps
    function tick(ts: number) {
      if (ts - last >= interval) {
        setTime(ts)
        last = ts
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [fps])

  return time
}


function SpinnerIcon({ color }: { color: string }) {
  return (
    <svg style={{ ...iconStyle, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function Shimmer() {
  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      pointerEvents: 'none',
      overflow: 'hidden',
      borderRadius: 9999,
    }}>
      <div style={{
        width: '60%',
        height: '100%',
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.03), transparent)',
        animation: 'shimmer 4s ease-in-out infinite',
      }} />
    </div>
  )
}

export function VoicePill() {
  const [state, setState] = useState<PillState>('idle')
  const [text, setText] = useState('')
  const [volume, setVolume] = useState(0)
  const [isLocked, setIsLocked] = useState(false)
  const [showHint, setShowHint] = useState(false)

  // Cycle: start with "Listening…", show hint for 3s every 8s
  useEffect(() => {
    if (state !== 'listening') { setShowHint(false); return }
    let mounted = true
    const cycle = () => {
      if (!mounted) return
      setShowHint(true)
      setTimeout(() => { if (mounted) setShowHint(false) }, 3000)
    }
    const id = setInterval(cycle, 8000)
    return () => { mounted = false; clearInterval(id) }
  }, [state])

  useEffect(() => {
    const unlistens: Promise<() => void>[] = []

    unlistens.push(listen<{ state: string; summary?: string }>('voice-state', (event) => {
      const { state: s, summary } = event.payload
      setState(s === 'hidden' ? 'idle' : s as PillState)
      if (summary !== undefined) setText(summary)
      if (s === 'hidden') {
        setIsLocked(false)
        setVolume(0)
      }
    }))

    unlistens.push(listen<{ level: number }>('voice-volume', (event) => {
      setVolume(event.payload.level)
    }))

    unlistens.push(listen<{ locked: boolean }>('voice-locked', (event) => {
      setIsLocked(event.payload.locked)
    }))

    unlistens.push(listen('voice-fn-press', () => {
      setState('listening')
      setText('')
    }))

    return () => { unlistens.forEach(p => p.then(fn => fn())) }
  }, [])

  const isIdle = state === 'idle'
  const isResponse = state === 'responding' || state === 'result'
  const isExpanded = !isIdle

  const pillStyle: React.CSSProperties = {
    ...baseFont,
    position: 'fixed',
    bottom: 16,
    display: 'flex',
    alignItems: 'center',
    gap: isExpanded ? 10 : 0,
    overflow: 'hidden',
    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    cursor: 'default',
    ...(isResponse ? {
      // Same pill shape, widens to fit text
      left: '50%',
      right: 'auto',
      transform: 'translateX(-50%)',
      padding: '12px 20px',
      borderRadius: 9999,
      background: '#171717',
      boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
      border: '1px solid rgba(64,64,64,0.5)',
      maxWidth: 'calc(100vw - 32px)',
      whiteSpace: 'nowrap' as any,
    } : {
      // Centered pill for idle / listening / thinking / working
      left: '50%',
      right: 'auto',
      transform: 'translateX(-50%)',
      justifyContent: 'center',
      padding: isExpanded ? '12px 20px' : '4px 8px',
      borderRadius: 9999,
      background: '#171717',
      boxShadow: isExpanded ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 4px 16px rgba(0,0,0,0.4)',
      border: `1px solid rgba(64,64,64,${isIdle ? 0.4 : 0.5})`,
      maxWidth: isExpanded ? 400 : 32,
    }),
  }

  if (isIdle) {
    return (
      <>
        <style>{KEYFRAMES}</style>
        <div style={pillStyle}>
          <AudioBars volume={0} idle small />
        </div>
      </>
    )
  }

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div style={pillStyle}>
        {state === 'listening' && (
          <>
            <Shimmer />
            <AudioBars volume={volume} />
            <span style={labelStyle}>{showHint ? 'release or tap again to send' : 'Listening…'}</span>
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
        {isResponse && (
          <span style={responseStyle}>{text}</span>
        )}
      </div>
    </>
  )
}
