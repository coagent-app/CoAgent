import { useEffect, useState } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import * as Linking from 'expo-linking'
import { getCredentials, saveCredentials } from '../lib/storage'

export default function RootLayout() {
  const [ready, setReady] = useState(false)
  const [hasCreds, setHasCreds] = useState(false)
  const router = useRouter()
  const segments = useSegments()

  useEffect(() => {
    getCredentials().then(creds => {
      setHasCreds(!!creds)
      setReady(true)
    })
  }, [])

  useEffect(() => {
    async function handleUrl(url: string) {
      try {
        const parsed = new URL(url)
        const token = parsed.searchParams.get('token')
        const relayUrl = parsed.searchParams.get('relay')
        const userId = parsed.searchParams.get('userId')
        if (token && relayUrl && userId) {
          await saveCredentials({ token, relayUrl, userId })
          setHasCreds(true)
        }
      } catch {}
    }

    // Handle cold start deep link
    Linking.getInitialURL().then(url => { if (url) handleUrl(url) })

    // Handle warm start deep link
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url))
    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (!ready) return
    const onScanPage = segments[0] === 'scan'
    if (!hasCreds && !onScanPage) router.replace('/scan')
    if (hasCreds && onScanPage) router.replace('/(tabs)')
  }, [ready, hasCreds, segments])

  if (!ready) return null

  return <Stack screenOptions={{ headerShown: false }} />
}
