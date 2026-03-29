import { useState, useRef, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from '@react-navigation/native'
import { Ionicons } from '@expo/vector-icons'
import { MessageBubble } from '../../components/MessageBubble'
import { useAgentContext } from '../../lib/AgentContext'
import { PulsingDot } from '../../components/PulsingDot'
import type { AgentMessage } from '@coagent/shared'

export default function ChatScreen() {
  const {
    connected,
    messages,
    streamingText,
    thinking,
    processing,
    toolLabel,
    error,
    chat,
    stopAgent,
  } = useAgentContext()
  const [input, setInput] = useState('')
  const flatListRef = useRef<FlatList>(null)
  const insets = useSafeAreaInsets()
  const isNearBottom = useRef(true)
  const contentHeight = useRef(0)
  const scrollViewHeight = useRef(0)

  const scrollToBottom = useCallback((animated = true) => {
    if (isNearBottom.current) {
      flatListRef.current?.scrollToEnd({ animated })
    }
  }, [])

  // Track whether user is near the bottom
  const onScroll = useCallback((e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y
    isNearBottom.current = distanceFromBottom < 80
  }, [])

  // Scroll on new content (only if already at bottom)
  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingText, thinking, toolLabel])

  // Scroll to bottom when entering this tab
  useFocusEffect(
    useCallback(() => {
      isNearBottom.current = true
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100)
    }, [])
  )

  // Snap to bottom after keyboard finishes opening
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => scrollToBottom(false))
    return () => sub.remove()
  }, [scrollToBottom])

  function handleSend() {
    const text = input.trim()
    if (!text || processing) return
    chat(text)
    setInput('')
    // Always scroll to bottom when user sends a message
    isNearBottom.current = true
    scrollToBottom()
  }

  const displayMessages: AgentMessage[] = [...messages]
  if (streamingText) {
    displayMessages.push({
      role: 'assistant',
      content: streamingText,
      timestamp: new Date().toISOString(),
    })
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={5}
    >
      {/* Header — matches desktop ChatPane header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Co-Agent</Text>
        <PulsingDot online={connected} />
      </View>

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={displayMessages}
        keyExtractor={(item, i) => `${item.role}-${item.timestamp}-${i}`}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.messageList}
        onScroll={onScroll}
        scrollEventThrottle={100}
        ListEmptyComponent={
          connected ? (
            <View style={styles.welcomeRow}>
              <View style={styles.welcomeBubble}>
                <Text style={styles.welcomeText}>
                  Hello. I'm Co-Agent. I'm watching your queue and ready to help. What do you need?
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.empty}>
              <ActivityIndicator size="small" color="#a3a3a3" />
              <Text style={styles.emptySubtitle}>Connecting to your agent...</Text>
            </View>
          )
        }
      />

      {/* Thinking / tool indicator */}
      {(thinking || toolLabel) && (
        <View style={styles.indicator}>
          <View style={styles.indicatorDots}>
            <View style={[styles.indicatorDot, styles.dot1]} />
            <View style={[styles.indicatorDot, styles.dot2]} />
            <View style={[styles.indicatorDot, styles.dot3]} />
          </View>
          <Text style={styles.indicatorText}>
            {toolLabel || 'Thinking...'}
          </Text>
        </View>
      )}

      {/* Input bar */}
      <View style={styles.inputBar}>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Ask Co-Agent anything..."
            placeholderTextColor="#a1a1aa"
            multiline
            maxLength={4000}
            returnKeyType="default"
            blurOnSubmit={false}
            editable={connected}
          />
          {processing ? (
            <TouchableOpacity
              style={styles.stopButton}
              onPress={stopAgent}
              activeOpacity={0.7}
            >
              <View style={styles.stopSquare} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.sendButton,
                (!input.trim() || !connected) && styles.sendDisabled,
              ]}
              onPress={handleSend}
              disabled={!input.trim() || !connected}
              activeOpacity={0.7}
            >
              <Ionicons name="arrow-up" size={20} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
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
    backgroundColor: '#ffffff',
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
  errorBanner: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: {
    color: '#991b1b',
    fontSize: 13,
    lineHeight: 18,
  },
  messageList: {
    paddingTop: 20,
    paddingBottom: 12,
    flexGrow: 1,
  },
  welcomeRow: {
    paddingHorizontal: 28,
    paddingTop: 20,
    flexDirection: 'row',
  },
  welcomeBubble: {
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    borderTopLeftRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxWidth: '85%',
  },
  welcomeText: {
    color: '#262626',
    fontSize: 14.5,
    lineHeight: 22,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 40,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#a1a1aa',
    textAlign: 'center',
    lineHeight: 20,
  },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 28,
    paddingVertical: 10,
  },
  indicatorDots: {
    flexDirection: 'row',
    gap: 3,
  },
  indicatorDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#a1a1aa',
    opacity: 0.6,
  },
  dot1: {},
  dot2: { opacity: 0.8 },
  dot3: { opacity: 1.0 },
  indicatorText: {
    color: '#a1a1aa',
    fontSize: 13,
    fontWeight: '500',
  },
  inputBar: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
    backgroundColor: '#ffffff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f5f5f5',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    maxHeight: 120,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: '#f4f4f5',
    borderRadius: 22,
    color: '#18181b',
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#18181b',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendDisabled: {
    backgroundColor: '#d4d4d8',
  },
  stopButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: '#ffffff',
  },
})
