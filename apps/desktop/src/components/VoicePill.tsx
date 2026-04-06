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
@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0), 0 8px 32px rgba(0,0,0,0.5); }
  50% { box-shadow: 0 0 8px 1px rgba(255,255,255,0.08), 0 8px 32px rgba(0,0,0,0.5); }
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}
`

const baseFont: React.CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 13,
  fontWeight: 500,
  color: '#fff',
  letterSpacing: '-0.01em',
}

const iconStyle: React.CSSProperties = { flexShrink: 0, width: 16, height: 16 }

const labelStyle: React.CSSProperties = {
  color: '#a3a3a3',
  animation: 'fade-in 0.2s ease-out',
}

const responseStyle: React.CSSProperties = {
  color: '#e5e5e5',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical' as any,
  minWidth: 0,
  flex: 1,
  fontSize: 13,
  lineHeight: '18px',
  animation: 'fade-in 0.25s ease-out',
}

// Vertical audio bars — idle has gentle wave, listening reacts to volume
function AudioBars({ volume, idle, small }: { volume: number; idle?: boolean; small?: boolean }) {
  const barCount = small ? 4 : 5
  const barWidth = small ? 2 : 2.5
  const gap = small ? 2 : 2.5
  const maxH = small ? 12 : 16
  const minH = small ? 2 : 3
  const totalW = barCount * barWidth + (barCount - 1) * gap
  const svgStyle: React.CSSProperties = small
    ? { flexShrink: 0, width: 16, height: 12 }
    : { flexShrink: 0, width: 20, height: 16 }

  const now = useAnimationFrame(idle ? 10 : 0)
  const bars: number[] = []

  for (let i = 0; i < barCount; i++) {
    if (idle) {
      const phase = (now / 800) + (i * 0.7)
      const wave = Math.sin(phase) * 0.3 + 0.35
      bars.push(minH + wave * (maxH - minH) * 0.45)
    } else {
      const variation = [0.7, 1.0, 0.85, 1.0, 0.65][i]
      const h = minH + volume * (maxH - minH) * variation
      bars.push(Math.max(minH, h))
    }
  }

  const color = idle ? 'rgba(255,255,255,0.6)' : '#ffffff'

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
          style={{ transition: idle ? 'none' : 'height 0.06s ease-out, y 0.06s ease-out' }}
        />
      ))}
    </svg>
  )
}

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
    <svg style={{ ...iconStyle, animation: 'spin 0.8s linear infinite' }} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
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
        width: '50%',
        height: '100%',
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',
        animation: 'shimmer 3s ease-in-out infinite',
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
  const isListening = state === 'listening'
  const isExpanded = !isIdle

  const shadow = isIdle
    ? '0 2px 8px rgba(0,0,0,0.3)'
    : isListening
      ? undefined // handled by pulse-glow animation
      : '0 4px 24px rgba(0,0,0,0.4), 0 12px 48px rgba(0,0,0,0.2)'

  const borderColor = isLocked
    ? 'rgba(255,255,255,0.25)'
    : isListening
      ? 'rgba(255,255,255,0.15)'
      : isIdle
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(255,255,255,0.1)'

  const pillStyle: React.CSSProperties = {
    ...baseFont,
    position: 'fixed',
    bottom: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: isIdle ? 'center' : undefined,
    gap: isExpanded ? 10 : 0,
    overflow: 'hidden',
    transition: 'padding 0.35s cubic-bezier(0.4, 0, 0.2, 1), gap 0.35s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.35s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease',
    cursor: 'default',
    padding: isExpanded ? '6px 16px' : '3px 6px',
    borderRadius: 9999,
    background: isIdle ? 'rgba(23,23,23,0.85)' : 'rgba(23,23,23,0.95)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    boxShadow: shadow,
    border: `1px solid ${borderColor}`,
    maxWidth: isResponse ? 'calc(100vw - 32px)' : isExpanded ? 360 : 30,
    ...(isListening ? { animation: 'pulse-glow 2.5s ease-in-out infinite' } : {}),
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
        {isListening && (
          <>
            <Shimmer />
            <AudioBars volume={volume} />
            <span style={labelStyle}>
              {showHint ? (isLocked ? 'tap Fn to send' : 'release or tap again') : 'Listening...'}
            </span>
            {isLocked && (
              <div style={{
                width: 6, height: 6, borderRadius: 3,
                background: 'rgba(255,255,255,0.7)',
                flexShrink: 0,
                animation: 'fade-in 0.2s ease-out',
              }} />
            )}
          </>
        )}
        {state === 'thinking' && (
          <span style={labelStyle}>Thinking...</span>
        )}
        {state === 'working' && (
          <>
            <SpinnerIcon color="#fbbf24" />
            <span style={{
              ...labelStyle,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 260,
            }}>{text || 'Working...'}</span>
          </>
        )}
        {isResponse && (
          <span style={responseStyle}>{text}</span>
        )}
      </div>
    </>
  )
}
