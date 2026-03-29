import { useState, useCallback } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Modal, Image, ActivityIndicator, Linking, Alert } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { Ionicons } from '@expo/vector-icons'
import type { AgentMessage } from '@coagent/shared'
import { useAgentContext } from '../lib/AgentContext'

const FILE_LINK_RE = /\[([^\]]*)\]\(coagent-file:([^)]+)\)/g
// Also strip partial/in-progress file links during streaming
const PARTIAL_FILE_LINK_RE = /\[[^\]]*\]\(coagent-file:[^)]*$|\[coagent-file:[^\]]*$/

interface FileRef {
  name: string
  id: string
}

function extractFileRefs(content: string): { cleaned: string; files: FileRef[] } {
  const files: FileRef[] = []
  let cleaned = content.replace(FILE_LINK_RE, (_, name, id) => {
    files.push({ name, id })
    return '' // remove from markdown
  })
  // Remove any partial file link being streamed
  cleaned = cleaned.replace(PARTIAL_FILE_LINK_RE, '')
  return { cleaned: cleaned.trim(), files }
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image-outline'
  if (ext === 'pdf') return 'document-text-outline'
  if (['mp3', 'wav', 'm4a'].includes(ext)) return 'musical-notes-outline'
  if (['mp4', 'mov'].includes(ext)) return 'videocam-outline'
  if (['csv', 'xlsx', 'xls'].includes(ext)) return 'grid-outline'
  return 'document-outline'
}

function FileCard({ file, requestFileContent }: { file: FileRef; requestFileContent: (id: string) => Promise<any> }) {
  const [loading, setLoading] = useState(false)
  const [imageUri, setImageUri] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)

  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)

  async function handleTap() {
    if (loading) return
    setLoading(true)
    try {
      const result = await requestFileContent(file.id)
      if (!result) {
        Alert.alert('Error', 'Could not retrieve file from server')
        setLoading(false)
        return
      }

      if (result.mimeType.startsWith('image/')) {
        setImageUri(`data:${result.mimeType};base64,${result.data}`)
        setShowModal(true)
      } else {
        // Save to cache and share/open with system viewer
        const LegacyFS = require('expo-file-system/legacy')
        const Sharing = require('expo-sharing')
        const path = LegacyFS.cacheDirectory + result.filename
        await LegacyFS.writeAsStringAsync(path, result.data, {
          encoding: LegacyFS.EncodingType.Base64,
        })
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path)
        }
      }
    } catch (err: any) {
      console.error('[FileCard] Error:', err)
      Alert.alert('File Error', err?.message || 'Unknown error')
    }
    setLoading(false)
  }

  return (
    <>
      <TouchableOpacity style={cardStyles.card} onPress={handleTap} activeOpacity={0.7}>
        {loading ? (
          <ActivityIndicator size="small" color="#a1a1aa" />
        ) : (
          <Ionicons name={getFileIcon(file.name) as any} size={20} color="#71717a" />
        )}
        <Text style={cardStyles.name} numberOfLines={1}>{file.name}</Text>
        <Ionicons name={isImage ? 'eye-outline' : 'download-outline'} size={16} color="#a1a1aa" />
      </TouchableOpacity>

      {showModal && imageUri && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setShowModal(false)}>
          <TouchableOpacity
            style={cardStyles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowModal(false)}
          >
            <View style={cardStyles.modalContent}>
              <Image source={{ uri: imageUri }} style={cardStyles.modalImage} resizeMode="contain" />
              <Text style={cardStyles.modalName}>{file.name}</Text>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </>
  )
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'
  const { requestFileContent } = useAgentContext()
  const { cleaned, files } = isUser
    ? { cleaned: message.content, files: [] }
    : extractFileRefs(message.content)

  // Intercept any coagent-file: links that slip through (e.g. during streaming)
  const onLinkPress = useCallback((url: string) => {
    if (url.startsWith('coagent-file:')) return false
    Linking.openURL(url).catch(() => {})
    return false
  }, [])

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        {cleaned ? (
          <Markdown
            style={isUser ? mdStylesUser : mdStylesAgent}
            onLinkPress={onLinkPress}
          >
            {cleaned}
          </Markdown>
        ) : null}
        {files.map(f => <FileCard key={f.id} file={f} requestFileContent={requestFileContent} />)}
      </View>
    </View>
  )
}

const cardStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#e5e5e5',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 8,
  },
  name: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#171717',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    maxHeight: '80%',
    alignItems: 'center',
    gap: 16,
  },
  modalImage: {
    width: '100%',
    height: 400,
    borderRadius: 8,
  },
  modalName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
})

// Match desktop: text-[13.5px] leading-relaxed, neutral-800/200 text
const mdStylesAgent = StyleSheet.create({
  body: { color: '#262626', fontSize: 14.5, lineHeight: 22 },
  heading1: { color: '#171717', fontSize: 16, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  heading2: { color: '#171717', fontSize: 15, fontWeight: '600', marginTop: 8, marginBottom: 4 },
  heading3: { color: '#171717', fontSize: 14.5, fontWeight: '600', marginTop: 6, marginBottom: 2 },
  strong: { fontWeight: '600', color: '#171717' },
  link: { color: '#2563EB' },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  code_inline: { backgroundColor: '#e5e5e5', color: '#262626', fontSize: 12.5, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, fontFamily: 'Menlo' },
  fence: { backgroundColor: '#e5e5e5', color: '#262626', fontSize: 12.5, padding: 12, borderRadius: 8, fontFamily: 'Menlo', marginVertical: 8 },
  code_block: { backgroundColor: '#e5e5e5', color: '#262626', fontSize: 12.5, padding: 12, borderRadius: 8, fontFamily: 'Menlo', marginVertical: 8 },
  blockquote: { backgroundColor: '#e5e5e5', borderLeftColor: '#a3a3a3', borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 6, marginVertical: 6 },
  paragraph: { marginTop: 0, marginBottom: 0 },
  hr: { backgroundColor: '#e5e5e5', height: 1, marginVertical: 10 },
})

const mdStylesUser = StyleSheet.create({
  body: { color: '#ffffff', fontSize: 14.5, lineHeight: 22 },
  heading1: { color: '#ffffff', fontSize: 16, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  heading2: { color: '#ffffff', fontSize: 15, fontWeight: '600', marginTop: 8, marginBottom: 4 },
  heading3: { color: '#ffffff', fontSize: 14.5, fontWeight: '600', marginTop: 6, marginBottom: 2 },
  strong: { fontWeight: '600' },
  link: { color: '#93c5fd' },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  code_inline: { backgroundColor: '#404040', color: '#ffffff', fontSize: 12.5, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, fontFamily: 'Menlo' },
  fence: { backgroundColor: '#404040', color: '#ffffff', fontSize: 12.5, padding: 12, borderRadius: 8, fontFamily: 'Menlo', marginVertical: 8 },
  code_block: { backgroundColor: '#404040', color: '#ffffff', fontSize: 12.5, padding: 12, borderRadius: 8, fontFamily: 'Menlo', marginVertical: 8 },
  blockquote: { backgroundColor: '#404040', borderLeftColor: '#a3a3a3', borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 6, marginVertical: 6 },
  paragraph: { marginTop: 0, marginBottom: 0 },
  hr: { backgroundColor: '#525252', height: 1, marginVertical: 10 },
})

// Match desktop: px-7 horizontal padding, gap-3 vertical spacing
const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 28,
    marginBottom: 6,
    flexDirection: 'row',
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '85%',
  },
  bubbleAgent: {
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    borderTopLeftRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  bubbleUser: {
    backgroundColor: '#171717',
    borderRadius: 20,
    borderTopRightRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
})
