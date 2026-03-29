import WebSocket from 'ws'
import type { TeamMessage, TeamMember } from '@coagent/shared'
import { TeamLog } from './team-log'

export interface TeamClientOptions {
  relayUrl: string
  relayToken: string
  userId: string
  dataDir: string
  onTaggedMessage?: (message: TeamMessage) => void
  onHumanNotify?: (message: TeamMessage) => void
}

export class TeamClient {
  private ws: WebSocket | null = null
  private options: TeamClientOptions
  private teamLog: TeamLog
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private backoffMs = 2000
  private stopped = false
  private roster: TeamMember[] = []
  public teamId: string | null = null
  public teamName: string | null = null

  constructor(options: TeamClientOptions) {
    this.options = options
    this.teamLog = new TeamLog(options.dataDir)
  }

  async init(): Promise<void> {
    await this.teamLog.init()
  }

  async connect(): Promise<void> {
    this.stopped = false
    await this.fetchRoster()
    if (!this.teamId) {
      console.log('[Team] Not in a team, skipping connection')
      return
    }
    this.openConnection()
  }

  stop(): void {
    this.stopped = true
    if (this.pingInterval) clearInterval(this.pingInterval)
    if (this.ws) this.ws.close()
  }

  getRoster(): TeamMember[] {
    return this.roster
  }

  getTeamLog(): TeamLog {
    return this.teamLog
  }

  private async fetchRoster(): Promise<void> {
    try {
      const res = await fetch(`${this.options.relayUrl}/team/roster`, {
        headers: { 'Authorization': `Bearer ${this.options.relayToken}` }
      })
      const data = await res.json() as any
      if (data.teamId) {
        this.teamId = data.teamId
        this.teamName = data.name || null
        this.roster = data.members || []
        console.log(`[Team] Connected to team "${this.teamName}" with ${this.roster.length} members`)
      }
    } catch (err) {
      console.warn('[Team] Failed to fetch roster:', err)
    }
  }

  private openConnection(): void {
    if (this.stopped || !this.teamId) return

    const wsUrl = `${this.options.relayUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/team/ws?token=${this.options.relayToken}&userId=${this.options.userId}`
    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      console.log('[Team] WebSocket connected')
      this.backoffMs = 2000
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping')
      }, 30000)
    })

    this.ws.on('message', (raw) => {
      const str = typeof raw === 'string' ? raw : raw.toString()
      if (str === 'pong') return
      try {
        const envelope = JSON.parse(str)
        if (envelope.type === 'team_message') {
          this.handleMessage(envelope.message as TeamMessage)
        }
      } catch (err) {
        console.warn('[Team] Failed to parse message:', err)
      }
    })

    this.ws.on('close', () => {
      if (this.pingInterval) clearInterval(this.pingInterval)
      if (!this.stopped) {
        console.log(`[Team] Reconnecting in ${this.backoffMs}ms`)
        setTimeout(() => this.openConnection(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 1.5, 30000)
      }
    })

    this.ws.on('error', (err) => {
      console.warn('[Team] WebSocket error:', err)
    })
  }

  private handleMessage(message: TeamMessage): void {
    const { to } = message
    const myUserId = this.options.userId
    const myAgentTag = `${myUserId}-agent`

    const isTaggedAgent = to === myAgentTag ||
      (Array.isArray(to) && to.includes(myAgentTag))

    const isTaggedHuman = to === myUserId ||
      (Array.isArray(to) && to.includes(myUserId))

    if (isTaggedAgent && this.options.onTaggedMessage) {
      this.options.onTaggedMessage(message)
    } else if (isTaggedHuman && this.options.onHumanNotify) {
      this.options.onHumanNotify(message)
    } else {
      this.teamLog.append(message).catch(console.warn)
    }
  }

  async sendMessage(visible: string, agentContext: string = '', to: string | string[] | null = null): Promise<void> {
    if (!this.teamId) return

    const me = this.roster.find(m => m.userId === this.options.userId)
    const message: TeamMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      teamId: this.teamId,
      timestamp: new Date().toISOString(),
      from: {
        userId: this.options.userId,
        name: me?.name || this.options.userId,
        role: me?.role || '',
        isAgent: true
      },
      visible,
      agentContext,
      to,
      attachments: []
    }

    try {
      await fetch(`${this.options.relayUrl}/team/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.relayToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      })
    } catch (err) {
      console.warn('[Team] Failed to send message:', err)
    }
  }

  async sendHumanMessage(visible: string, to: string | null = null): Promise<void> {
    if (!this.teamId) return

    const me = this.roster.find(m => m.userId === this.options.userId)
    const message: TeamMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      teamId: this.teamId,
      timestamp: new Date().toISOString(),
      from: {
        userId: this.options.userId,
        name: me?.name || this.options.userId,
        role: me?.role || '',
        isAgent: false
      },
      visible,
      agentContext: '',
      to,
      attachments: []
    }

    try {
      await fetch(`${this.options.relayUrl}/team/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.options.relayToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      })
    } catch (err) {
      console.warn('[Team] Failed to send message:', err)
    }
  }
}
