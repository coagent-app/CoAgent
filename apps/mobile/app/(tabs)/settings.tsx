import { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useAgentContext } from '../../lib/AgentContext'
import { clearCredentials, getCredentials } from '../../lib/storage'

const NOTIFICATION_OPTIONS = [
  { value: 'always', label: 'Always', description: 'Notify even when desktop is open' },
  { value: 'away_only', label: 'When away', description: 'Only when desktop is disconnected' },
  { value: 'never', label: 'Never', description: 'Mute all push notifications' },
] as const

export default function SettingsScreen() {
  const { connected, notificationMode, updateNotificationMode } = useAgentContext()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const [relayUrl, setRelayUrl] = useState<string>('')

  useEffect(() => {
    getCredentials().then(creds => {
      if (creds) setRelayUrl(creds.relayUrl)
    })
  }, [])

  function handleUnpair() {
    Alert.alert(
      'Unpair Device',
      'This will disconnect the app from your agent. You can re-pair by scanning the QR code again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: async () => {
            await clearCredentials()
            router.replace('/scan')
          },
        },
      ]
    )
  }

  const colors = lightColors

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top + 16 }]}>
      <Text style={[styles.title, { color: colors.text }]}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>

        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.muted }]}>Status</Text>
          <View style={[styles.dot, connected ? styles.dotGreen : styles.dotRed]} />
          <Text style={[styles.value, { color: colors.text }]}>
            {connected ? 'Connected' : 'Offline'}
          </Text>
        </View>

        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.muted }]}>Relay</Text>
          <Text style={[styles.value, { color: colors.text }]} numberOfLines={1} ellipsizeMode="middle">
            {relayUrl || '—'}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        {NOTIFICATION_OPTIONS.map((option, index) => (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.radioRow,
              { borderBottomColor: colors.border },
              index === NOTIFICATION_OPTIONS.length - 1 && styles.radioRowLast,
            ]}
            onPress={() => updateNotificationMode(option.value)}
            activeOpacity={0.6}
          >
            <View style={[styles.radioCircle, { borderColor: colors.muted }]}>
              {notificationMode === option.value && (
                <View style={styles.radioFill} />
              )}
            </View>
            <View style={styles.radioText}>
              <Text style={[styles.radioLabel, { color: colors.text }]}>{option.label}</Text>
              <Text style={[styles.radioDescription, { color: colors.muted }]}>{option.description}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.section}>
        <TouchableOpacity
          style={[styles.rePairButton, { backgroundColor: colors.surface }]}
          onPress={() => router.push('/scan')}
          activeOpacity={0.7}
        >
          <Text style={[styles.rePairText, { color: colors.text }]}>Re-scan QR Code</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.unpairButton}
          onPress={handleUnpair}
          activeOpacity={0.7}
        >
          <Text style={styles.unpairText}>Unpair Device</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footer}>
        All agent configuration and settings are managed from the CoAgent desktop app.
      </Text>
    </View>
  )
}

const lightColors = {
  bg: '#ffffff',
  text: '#1f2937',
  muted: '#9ca3af',
  border: '#E5E5E5',
  surface: '#F5F5F5',
}

const darkColors = {
  bg: '#0D0C10',
  text: '#F2F2F2',
  muted: '#9ca3af',
  border: '#2E2E2E',
  surface: '#262626',
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 32,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: {
    fontSize: 14,
    width: 52,
  },
  value: {
    fontSize: 14,
    flex: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotGreen: {
    backgroundColor: '#34D399',
  },
  dotRed: {
    backgroundColor: '#EF4444',
  },
  rePairButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  rePairText: {
    fontSize: 14,
    fontWeight: '500',
  },
  unpairButton: {
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#fff0f0',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  unpairText: {
    fontSize: 14,
    color: '#EF4444',
    fontWeight: '500',
  },
  footer: {
    fontSize: 11,
    color: '#9ca3af',
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 16,
    marginTop: 'auto',
    paddingBottom: 16,
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  radioRowLast: {
    borderBottomWidth: 0,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioFill: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#6366f1',
  },
  radioText: {
    flex: 1,
    gap: 2,
  },
  radioLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  radioDescription: {
    fontSize: 12,
  },
})
