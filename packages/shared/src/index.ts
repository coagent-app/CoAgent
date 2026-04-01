export type Autonomy = 'ask_first' | 'balanced' | 'autonomous'

export type NotificationMode = 'always' | 'away_only' | 'never'

export type AuthMethod = 'api_key' | 'oauth_token'

export interface AuthStatus {
  method: AuthMethod | null
  configured: boolean
  valid: boolean | null
}

export type DayName = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface AgentSettings {
  name: string
  email: string
  timezone: string
  role: string
  what_you_do: string      // user's own description of their work, injected into system prompt
  active_hours: { start: number; end: number }
  active_days: DayName[]
  autonomy: Autonomy
  heartbeat_interval: number // minutes between heartbeats (0 = disabled)
  powerModel: string
  voice_enabled: boolean   // global toggle for voice pill
  voice_response: boolean  // TTS read-back of summary
  voice_hotkey: string     // shortcut string e.g. "Control+Space"
  voice_voice: string      // OpenAI TTS voice: alloy, echo, fable, onyx, nova, shimmer
  onboarded: boolean       // false until onboarding completes — triggers onboarding flow in system prompt
}

export type TriggerSource = 'heartbeat' | 'webhook' | 'manual' | 'memory_cleanup' | 'todo_due' | 'routine' | 'task_due'

export interface AgentTrigger {
  source: TriggerSource
  payload?: Record<string, unknown>
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ApprovalItem {
  id: string
  type: 'task' | 'message' | 'request' | 'other'
  title: string
  description: string
  detail: string
  notes: string
  action: string
  metadata: Record<string, string>
  status: ApprovalStatus
  createdAt: string
}

export interface TodoItem {
  id: string
  task: string
  due?: string        // ISO date string
  priority: 'high' | 'normal' | 'low'
  context?: string    // agent notes — background info needed to execute the task when it fires
  createdAt: string
}

export type CalendarEntryType = 'routine' | 'task' | 'followup' | 'event'

export interface CalendarEntry {
  id: string
  type: CalendarEntryType
  label: string
  cron?: string         // routine: "0 9 * * 1-5"
  due?: string          // task/followup: ISO datetime "2026-03-28T14:30:00"
  start?: string        // event: ISO datetime start
  end?: string          // event: ISO datetime end
  location?: string     // event: location string
  instruction?: string  // what the agent executes when entry fires
  notes?: string        // contextual info for any entry type
  enabled: boolean
  completed?: boolean   // for tasks and followups
  createdAt: string
  source?: 'local' | 'google'     // undefined = local (backward compat)
  googleEventId?: string           // Google's event ID for sync
  googleCalendarId?: string        // which Google calendar it came from
}

export interface GoogleCalendarInfo {
  id: string
  name: string
  enabled: boolean
  color: string
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface TriggerInfo {
  slug: string       // e.g. 'GMAIL_NEW_GMAIL_MESSAGE'
  label: string      // e.g. 'New email received'
  appSlug: string    // e.g. 'gmail'
  enabled: boolean   // whether currently subscribed
}

export interface Integration {
  slug: string
  name: string
  connected: boolean
  category?: string
  description?: string
  capabilities?: string
  custom?: boolean
  builtin?: boolean
  icon?: string
  domain?: string      // website domain for favicon (e.g. "rentcast.io")
  triggers?: TriggerInfo[]
  suggested?: boolean  // true if this integration is recommended for the user's vertical
}

export interface FileEntry {
  id: string
  type: 'upload'
  filename: string
  path: string          // absolute path on disk
  addedAt: string       // ISO timestamp
  lastAccessed: string  // ISO timestamp
  summary: string       // AI-written 2-3 sentence description
  group: string         // agent-assigned folder name e.g. "Contracts"
  sizeBytes: number
}

export type WSClientMessage =
  | { type: 'chat'; message: string; fileIds?: string[] }
  | { type: 'steer'; message: string }
  | { type: 'get_queue' }
  | { type: 'approve'; id: string }
  | { type: 'reject'; id: string }
  | { type: 'get_done' }
  | { type: 'get_todos' }
  | { type: 'complete_todo'; id: string }
  | { type: 'delete_todo'; id: string }
  | { type: 'get_integrations' }
  | { type: 'integration_connect'; slug: string; params?: Record<string, string> }
  | { type: 'integration_disconnect'; slug: string }
  | { type: 'stop_agent' }
  | { type: 'edit_queue_item'; id: string; detail: string }
  | { type: 'get_settings' }
  | { type: 'update_settings'; patch: Partial<AgentSettings> }
  | { type: 'get_files' }
  | { type: 'ingest_file'; filename: string; mimeType: string; data: string }  // base64-encoded file content
  | { type: 'ingest_file_paths'; paths: string[]; group?: string }  // local file paths, server reads directly
  | { type: 'delete_file'; id: string }
  | { type: 'create_folder'; name: string }
  | { type: 'move_file'; id: string; targetGroup: string }  // targetGroup '' = move to root
  | { type: 'rename_file'; id: string; newName: string }
  | { type: 'rename_folder'; oldName: string; newName: string }
  | { type: 'delete_folder'; name: string }
  | { type: 'reorder_folders'; order: string[] }
  | { type: 'move_folder'; folderPath: string; newParentPath: string }
  | { type: 'search_files_ui'; query: string }
  | { type: 'trigger_heartbeat' }
  | { type: 'add_test_queue_item'; item: Omit<ApprovalItem, 'id' | 'status' | 'createdAt'> }
  | { type: 'update_auth'; method: AuthMethod; credential: string }
  | { type: 'verify_auth' }
  | { type: 'relay_activate'; token: string; relayUrl: string }
  | { type: 'get_relay_status' }
  | { type: 'set_model'; model: string }
  | { type: 'voice_chat'; message: string }
  | { type: 'voice_audio'; data: string; format?: 'm4a' | 'webm' }
  | { type: 'voice_dictation'; data: string; format?: 'm4a' | 'webm' }
  | { type: 'get_usage' }
  | { type: 'auto_organize' }
  | { type: 'get_calendar' }
  | { type: 'complete_calendar_entry'; id: string }
  | { type: 'delete_calendar_entry'; id: string }
  | { type: 'capability_confirm'; capabilities: string[]; authValues?: Record<string, string> }
  | { type: 'custom_integration_delete'; slug: string }
  | { type: 'get_skills' }
  | { type: 'update_skill'; name: string; description: string; instructions: string }
  | { type: 'delete_skill'; name: string }
  | { type: 'toggle_trigger'; triggerSlug: string; appSlug: string; enabled: boolean }
  | { type: 'client_connected' }
  | { type: 'get_relay_credentials' }
  | { type: 'get_chat_history' }
  | { type: 'google_calendar_connect' }
  | { type: 'google_calendar_disconnect' }
  | { type: 'google_calendar_toggle'; calendarId: string; enabled: boolean }
  | { type: 'google_calendar_color'; calendarId: string; color: string }
  | { type: 'get_google_calendar_status' }
  | { type: 'google_calendar_sync' }
  | { type: 'get_file_content'; id: string }
  | { type: 'register_push_token'; token: string }
  | { type: 'update_notification_prefs'; mode: NotificationMode }
  | { type: 'admin_create_token'; label: string }
  | { type: 'admin_list_tokens' }
  | { type: 'admin_revoke_token'; token: string }
  | { type: 'team_send'; message: string; agentContext?: string; to?: string | string[] | null }
  | { type: 'team_history'; limit?: number }
  | { type: 'get_team_info' }
  | { type: 'team_create'; name: string; memberName: string; memberRole: string; memberHandles: string }
  | { type: 'team_join'; inviteCode: string; memberName: string; memberRole: string; memberHandles: string }
  | { type: 'team_leave' }
  | { type: 'team_invite' }

export type WSServerMessage =
  | { type: 'queue_update'; items: ApprovalItem[] }
  | { type: 'done_update'; items: DoneItem[] }
  | { type: 'todo_update'; items: TodoItem[] }
  | { type: 'chat_response'; message: AgentMessage }
  | { type: 'chat_chunk'; text: string }
  | { type: 'chat_segment_end' }
  | { type: 'agent_thinking' }
  | { type: 'error'; message: string }
  | { type: 'integrations_update'; integrations: Integration[] }
  | { type: 'integration_auth_url'; slug: string; url: string }
  | { type: 'integration_needs_fields'; slug: string; fields: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[] }
  | { type: 'integration_fda_required'; slug: string; message: string }
  | { type: 'chat_history'; messages: AgentMessage[] }
  | { type: 'tool_start'; tool: string; label: string }
  | { type: 'tool_end'; tool: string }
  | { type: 'agent_stopped' }
  | { type: 'settings_update'; settings: AgentSettings }
  | { type: 'files_update'; files: FileEntry[] }
  | { type: 'folders_update'; folders: string[] }
  | { type: 'files_search_result'; files: FileEntry[] }
  | { type: 'auth_status'; status: AuthStatus }
  | { type: 'relay_status'; active: boolean; model: string | null; usage: RelayUsage | null; admin?: boolean }
  | { type: 'admin_token_created'; token: string; userId: string }
  | { type: 'admin_tokens_list'; users: AdminUser[] }
  | { type: 'admin_token_toggled'; token: string; active: boolean }
  | { type: 'heartbeat'; status: 'started' | 'done' | 'skipped' | 'escalated'; summary?: string }
  | { type: 'skills_update'; skills: { name: string; description: string; instructions: string; builtin?: boolean }[] }
  | { type: 'file_ingested'; id: string; filename: string }
  | { type: 'voice_summary'; summary: string }
  | { type: 'voice_tts_audio'; data: string }
  | { type: 'voice_tts_chunk'; seq: number; data: string }
  | { type: 'voice_tts_done' }
  | { type: 'voice_transcribed'; text: string }
  | { type: 'voice_dictation_result'; text: string }
  | { type: 'usage_update'; usage: UsageSummary }
  | { type: 'auto_organize_done'; folders: string[]; moved: number }
  | { type: 'calendar_update'; entries: CalendarEntry[] }
  | { type: 'google_calendar_status'; connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }
  | { type: 'file_content'; id: string; filename: string; mimeType: string; data: string }
  | { type: 'file_content_error'; id: string; error: string }
  | { type: 'capability_card'; name: string; capabilities: { name: string; description: string; checked: boolean }[]; authFields?: { name: string; displayName: string; description: string; helpUrl?: string; helpText?: string }[] }
  | { type: 'whatsapp_qr'; dataUrl: string }
  | { type: 'relay_credentials'; relayUrl: string; token: string; userId: string }
  | { type: 'push_notification'; title: string; body: string }
  | { type: 'notification_prefs'; mode: NotificationMode }
  | { type: 'team_message'; message: TeamMessage }
  | { type: 'team_history'; messages: TeamMessage[] }
  | { type: 'team_info'; team: TeamInfo | null }
  | { type: 'team_created'; teamId: string; inviteCode: string }
  | { type: 'team_joined'; team: TeamInfo }
  | { type: 'team_invite_code'; code: string }
  | { type: 'team_error'; error: string }

export interface AdminUser {
  userId: string
  label: string
  token: string
  active: boolean
  costUsd: number
  createdAt: string
}

export interface RelayUsage {
  inputTokens: number
  outputTokens: number
  llmCostUsd: number
  embeddingTokens: number
  embeddingCostUsd: number
  composioActions: number
  composioCostUsd: number
  totalCostUsd: number
  periodStart: string
}

export interface DoneItem {
  id: string
  description: string
  completedAt: string
}

export type UsageCategory = 'chat' | 'file_ingestion' | 'nightly_job'

export interface UsageEntry {
  category: UsageCategory
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  timestamp: string
}

export interface UsageSummary {
  periodStart: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  estimatedCostUsd: number
  byCategory: Record<UsageCategory, {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number
  }>
}

// ---------------------------------------------------------------------------
// Team types
// ---------------------------------------------------------------------------

export interface TeamMember {
  userId: string
  name: string
  role: string
  handles: string
}

export interface TeamInfo {
  teamId: string
  name: string
  ownerId: string
  created: string
  members: TeamMember[]
}

export interface TeamMessage {
  id: string
  teamId: string
  timestamp: string
  from: {
    userId: string
    name: string
    role: string
    isAgent: boolean
  }
  visible: string
  agentContext: string
  to: string | string[] | null
  attachments: string[]
}
