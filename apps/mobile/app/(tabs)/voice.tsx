import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, TouchableOpacity, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from '@react-navigation/native'
import { Ionicons } from '@expo/vector-icons'
import { VoiceOrb } from '../../components/VoiceOrb'
import type { VoiceState } from '../../components/VoiceOrb'
import { useAgentContext } from '../../lib/AgentContext'
import { PulsingDot } from '../../components/PulsingDot'
import {
  startRecording,
  stopRecordingAndGetBase64,
  cancelRecording,
  stopTts,
  startThinkingSound,
  stopThinkingSound,
  registerTtsHandlers,
  unregisterTtsHandlers,
} from '../../lib/voice'

export default function VoiceScreen() {
  const { connected, sendVoiceAudio, processing, ttsPlaying, streamingText } = useAgentContext()
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [sessionActive, setSessionActive] = useState(false)
  const sessionActiveRef = useRef(sessionActive)
  const insets = useSafeAreaInsets()
  const isRecordingRef = useRef(false)

  useEffect(() => {
    sessionActiveRef.current = sessionActive
  }, [sessionActive])

  // Stop session when navigating away from voice tab
  useFocusEffect(
    useCallback(() => {
      return () => {
        // Cleanup on blur
        if (sessionActiveRef.current) {
          setSessionActive(false)
          isRecordingRef.current = false
          cancelRecording()
          stopTts()
          stopThinkingSound()
          setVoiceState('idle')
        }
      }
    }, [])
  )

  const startListening = useCallback(async () => {
    if (isRecordingRef.current) return
    isRecordingRef.current = true
    setVoiceState('listening')
    try {
      console.log('[Voice] Starting recording...')
      await startRecording()
      console.log('[Voice] Recording started')
    } catch (err) {
      console.error('[Voice] Recording failed:', err)
      isRecordingRef.current = false
      setVoiceState(sessionActiveRef.current ? 'idle' : 'idle')
    }
  }, [])

  const sendAudio = useCallback(async () => {
    console.log('[Voice] Stopping recording and sending...')
    isRecordingRef.current = false
    const base64 = await stopRecordingAndGetBase64()
    if (base64) {
      console.log('[Voice] Got audio, sending', Math.round(base64.length / 1024), 'KB')
      setVoiceState('thinking')
      sendVoiceAudio(base64)
    } else {
      console.log('[Voice] No audio data')
      if (sessionActiveRef.current) {
        await startListening()
      }
    }
  }, [sendVoiceAudio, startListening])

  // Play/stop thinking sound based on voice state
  useEffect(() => {
    if (voiceState === 'thinking') {
      startThinkingSound()
    } else {
      stopThinkingSound()
    }
  }, [voiceState])

  useEffect(() => {
    registerTtsHandlers(() => {
      if (sessionActiveRef.current) {
        startListening()
      }
    })
    return () => {
      unregisterTtsHandlers()
      cancelRecording()
      stopTts()
      stopThinkingSound()
      isRecordingRef.current = false
    }
  }, [startListening])

  useEffect(() => {
    if (!sessionActive) return
    // Don't override state while actively recording
    if (isRecordingRef.current) return

    if (ttsPlaying) {
      setVoiceState('speaking')
    } else if (processing || streamingText) {
      setVoiceState('thinking')
    } else if (voiceState === 'thinking' || voiceState === 'speaking') {
      // Agent finished responding — go back to listening
      console.log('[Voice] Response complete, restarting listening')
      startListening()
    }
  }, [sessionActive, processing, ttsPlaying, streamingText])

  const toggleSession = useCallback(async () => {
    if (sessionActive) {
      setSessionActive(false)
      isRecordingRef.current = false
      cancelRecording()
      await stopTts()
      setVoiceState('idle')
    } else {
      setSessionActive(true)
      await startListening()
    }
  }, [sessionActive, startListening])

  const handleOrbTap = useCallback(async () => {
    console.log('[Voice] Orb tapped, state:', voiceState)
    if (voiceState === 'listening') {
      await sendAudio()
    } else if (voiceState === 'idle' && sessionActiveRef.current) {
      // Tapped while idle but session active — start listening again
      await startListening()
    }
  }, [voiceState, sendAudio, startListening])

  const stateLabel: Record<VoiceState, string> = {
    idle: 'Tap to start a voice session',
    listening: 'Listening — tap to send',
    thinking: 'Thinking...',
    speaking: 'Speaking...',
  }

  const stateIcon: Record<VoiceState, string> = {
    idle: 'mic-outline',
    listening: 'radio-outline',
    thinking: 'hourglass-outline',
    speaking: 'volume-high-outline',
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Co-Agent</Text>
        <PulsingDot online={connected} />
      </View>

      {/* Center content — tap anywhere to send when listening */}
      <Pressable
        style={styles.center}
        onPress={handleOrbTap}
        disabled={voiceState === 'thinking' || voiceState === 'speaking'}
      >
        <VoiceOrb state={voiceState} />

        <View style={styles.labelRow}>
          <Ionicons
            name={stateIcon[voiceState] as any}
            size={16}
            color={sessionActive ? '#0a0a0a' : '#a3a3a3'}
          />
          <Text style={[styles.stateLabel, sessionActive && styles.stateLabelActive]}>
            {stateLabel[voiceState]}
          </Text>
        </View>
      </Pressable>

      {/* Bottom button */}
      <View style={styles.bottom}>
        <TouchableOpacity
          style={[styles.button, sessionActive && styles.buttonActive]}
          onPress={toggleSession}
          disabled={!connected}
          activeOpacity={0.7}
        >
          <Ionicons
            name={sessionActive ? 'stop' : 'mic'}
            size={18}
            color="#fff"
            style={{ marginRight: 8 }}
          />
          <Text style={styles.buttonText}>
            {sessionActive ? 'End Session' : 'Start Session'}
          </Text>
        </TouchableOpacity>

        {!connected && (
          <Text style={styles.offlineHint}>Agent is offline</Text>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f5f5f5',
  },
  headerSubtitle: {
    fontSize: 10,
    fontWeight: '600',
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 19,
    fontWeight: '700',
    color: '#0a0a0a',
    letterSpacing: -0.3,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotOnline: {
    backgroundColor: '#34d399',
  },
  dotOffline: {
    backgroundColor: '#ef4444',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stateLabel: {
    color: '#a3a3a3',
    fontSize: 14,
    fontWeight: '500',
  },
  stateLabelActive: {
    color: '#3f3f46',
  },
  bottom: {
    paddingHorizontal: 28,
    paddingBottom: 24,
    alignItems: 'center',
    gap: 12,
  },
  button: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#18181b',
  },
  buttonActive: {
    backgroundColor: '#ef4444',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  offlineHint: {
    color: '#a3a3a3',
    fontSize: 12,
  },
})
