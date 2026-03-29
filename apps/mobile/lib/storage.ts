import * as SecureStore from 'expo-secure-store'

export interface RelayCredentials {
  relayUrl: string
  token: string
  userId: string
}

const KEY = 'coagent_relay_credentials'

// HARDCODED FOR TESTING — remove before production
const DEV_CREDENTIALS: RelayCredentials = {
  relayUrl: 'https://coagent-relay.brettponters.workers.dev',
  token: 'cc180ec91d0573143bd01a83cc328a204fb016ea6a41d9665fa6a9fd3d689644',
  userId: 'default',
}

export async function getCredentials(): Promise<RelayCredentials | null> {
  return DEV_CREDENTIALS
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
