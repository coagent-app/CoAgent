import * as SecureStore from 'expo-secure-store'

export interface RelayCredentials {
  relayUrl: string
  token: string
  userId: string
}

const KEY = 'coagent_relay_credentials'

export async function getCredentials(): Promise<RelayCredentials | null> {
  const raw = await SecureStore.getItemAsync(KEY)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export async function saveCredentials(creds: RelayCredentials): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(creds))
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
}

const PUSH_TOKEN_KEY = 'coagent_push_token'
const NOTIFICATION_PREFS_KEY = 'coagent_notification_mode'

export async function savePushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token)
}

export async function getPushToken(): Promise<string | null> {
  return SecureStore.getItemAsync(PUSH_TOKEN_KEY)
}

export async function saveNotificationMode(mode: string): Promise<void> {
  await SecureStore.setItemAsync(NOTIFICATION_PREFS_KEY, mode)
}

export async function getNotificationMode(): Promise<string> {
  return (await SecureStore.getItemAsync(NOTIFICATION_PREFS_KEY)) || 'away_only'
}
