import QRCode from 'qrcode'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { rmSync, existsSync } from 'fs'

export interface WhatsAppMedia {
  type: 'audio' | 'image' | 'video' | 'document'
  buffer: Buffer
  mimetype: string
  filename?: string
}

export interface WhatsAppCallbacks {
  onQr: (dataUrl: string) => void
  onConnected: () => void
  onDisconnected: () => void
  onMessage: (jid: string, pushName: string, text: string, media?: WhatsAppMedia) => void
}

export class WhatsAppClient {
  private dataDir: string
  private sock: any = null
  private callbacks: WhatsAppCallbacks
  private stopped = false
  private DisconnectReason: any = null
  private sentMessageIds = new Set<string>()
  private downloadMediaMessage: any = null

  constructor(dataDir: string, callbacks: WhatsAppCallbacks) {
    this.dataDir = dataDir
    this.callbacks = callbacks
  }

  private get authDir(): string {
    return join(this.dataDir, 'whatsapp-auth')
  }

  async connect(): Promise<void> {
    this.stopped = false
    await mkdir(this.authDir, { recursive: true })

    // Dynamic import — Baileys is ESM-only
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = baileys
    this.DisconnectReason = DisconnectReason
    this.downloadMediaMessage = downloadMediaMessage

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)

    // Fetch the latest WA Web version to avoid 405 rejections
    let version: [number, number, number] | undefined
    try {
      const { version: v } = await fetchLatestBaileysVersion()
      version = v
      console.log('[WhatsApp] Using WA Web version:', v.join('.'))
    } catch {
      console.log('[WhatsApp] Could not fetch version, using default')
    }

    const pino = (await import('pino')).default
    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }) as any,
      ...(version ? { version } : {}),
    })

    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 })
          this.callbacks.onQr(dataUrl)
        } catch (err: any) {
          console.error('[WhatsApp] QR generation failed:', err.message)
        }
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error as any
        const statusCode = err?.output?.statusCode
        console.log(`[WhatsApp] Connection closed — statusCode: ${statusCode}, error: ${err?.message || 'none'}`)
        if (statusCode === this.DisconnectReason?.loggedOut) {
          console.log('[WhatsApp] Logged out — clearing session')
          this.clearAuth()
          this.callbacks.onDisconnected()
        } else if (!this.stopped) {
          console.log('[WhatsApp] Reconnecting in 3s...')
          setTimeout(() => this.connect(), 3000)
        } else {
          this.callbacks.onDisconnected()
        }
      } else if (connection === 'open') {
        console.log('[WhatsApp] Connected')
        this.callbacks.onConnected()
      }
    })

    this.sock.ev.on('messages.upsert', async (upsert: any) => {
      const messages = upsert.messages || upsert
      if (!Array.isArray(messages)) return
      for (const msg of messages) {
        // Skip messages sent by the agent (via sendMessage) to avoid loops
        if (msg.key?.id && this.sentMessageIds.has(msg.key.id)) {
          this.sentMessageIds.delete(msg.key.id)
          continue
        }
        if (!msg.message) continue

        const jid = msg.key.remoteJid || ''
        const pushName = msg.pushName || ''

        // Extract text from any message type
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || msg.message.videoMessage?.caption
          || ''

        // Detect media type
        const mediaMsg = msg.message.audioMessage || msg.message.imageMessage
          || msg.message.videoMessage || msg.message.documentMessage
        let media: WhatsAppMedia | undefined

        if (mediaMsg && this.downloadMediaMessage) {
          const mediaType: WhatsAppMedia['type'] = msg.message.audioMessage ? 'audio'
            : msg.message.imageMessage ? 'image'
            : msg.message.videoMessage ? 'video'
            : 'document'
          try {
            const buffer = await this.downloadMediaMessage(msg, 'buffer', {})
            media = {
              type: mediaType,
              buffer: Buffer.from(buffer),
              mimetype: mediaMsg.mimetype || 'application/octet-stream',
              filename: mediaMsg.fileName,
            }
            console.log(`[WhatsApp] Downloaded ${mediaType} (${media.buffer.length} bytes, ${media.mimetype})`)
          } catch (err: any) {
            console.error(`[WhatsApp] Failed to download ${mediaType}:`, err.message)
          }
        }

        // Skip messages with no text AND no media
        if (!text && !media) continue

        this.callbacks.onMessage(jid, pushName, text, media)
      }
    })
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected')
    const sent = await this.sock.sendMessage(jid, { text })
    if (sent?.key?.id) this.sentMessageIds.add(sent.key.id)
  }

  async sendFile(jid: string, buffer: Buffer, mimetype: string, filename?: string, caption?: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected')
    const msg: any = {}
    if (mimetype.startsWith('image/')) {
      msg.image = buffer
      if (caption) msg.caption = caption
    } else if (mimetype.startsWith('video/')) {
      msg.video = buffer
      if (caption) msg.caption = caption
    } else if (mimetype.startsWith('audio/')) {
      msg.audio = buffer
      msg.mimetype = mimetype
    } else {
      msg.document = buffer
      msg.mimetype = mimetype
      msg.fileName = filename || 'file'
    }
    const sent = await this.sock.sendMessage(jid, msg)
    if (sent?.key?.id) this.sentMessageIds.add(sent.key.id)
  }

  disconnect(): void {
    this.stopped = true
    this.sock?.end(undefined)
    this.sock = null
  }

  clearAuth(): void {
    if (existsSync(this.authDir)) {
      rmSync(this.authDir, { recursive: true, force: true })
    }
  }

  get isConnected(): boolean {
    return this.sock?.user != null
  }
}
