export type Autonomy = 'ask_first' | 'balanced' | 'autonomous'

export type AuthMethod = 'api_key' | 'oauth_token'

export interface AuthStatus {
  method: AuthMethod | null
  configured: boolean
  valid: boolean | null
}

export type DayName = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface ApiKeys {
  anthropic: string   // required for the agent to function
  composio: string    // optional — enables integrations
  openai: string      // optional — enables semantic file search (embeddings)
}

export interface AgentSettings {
  name: string
  email: string
  timezone: string
  role: string
  active_hours: { start: number; end: number }
  active_days: DayName[]
  autonomy: Autonomy
  powerModel: string
  apiKeys: ApiKeys
}

export type TriggerSource = 'heartbeat' | 'webhook' | 'manual' | 'memory_cleanup'

export interface AgentTrigger {
  source: TriggerSource
  payload?: Record<string, unknown>
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ApprovalItem {
  id: string
  type: 'task' | 'document' | 'message' | 'request' | 'other'
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
  createdAt: string
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface Integration {
  slug: string
  name: string
  connected: boolean
}

export interface FileEntry {
  id: string
  type: 'upload' | 'document'
  filename: string
  path: string          // absolute path on disk
  addedAt: string       // ISO timestamp
  lastAccessed: string  // ISO timestamp
  summary: string       // AI-written 2-3 sentence description
  group: string         // agent-assigned folder name e.g. "Contracts"
  sizeBytes: number
}

export type WSClientMessage =
  | { type: 'chat'; message: string }
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
  | { type: 'update_document'; id: string; content: string }
  | { type: 'close_document' }
  | { type: 'open_document'; id: string }
  | { type: 'update_auth'; method: AuthMethod; credential: string }
  | { type: 'verify_auth' }
  | { type: 'relay_activate'; token: string; relayUrl: string }
  | { type: 'get_relay_status' }
  | { type: 'set_model'; model: string }
  | { type: 'update_api_keys'; keys: Partial<ApiKeys> }
  | { type: 'get_api_keys' }

export type WSServerMessage =
  | { type: 'queue_update'; items: ApprovalItem[] }
  | { type: 'done_update'; items: DoneItem[] }
  | { type: 'todo_update'; items: TodoItem[] }
  | { type: 'chat_response'; message: AgentMessage }
  | { type: 'chat_chunk'; text: string }
  | { type: 'agent_thinking' }
  | { type: 'error'; message: string }
  | { type: 'integrations_update'; integrations: Integration[] }
  | { type: 'integration_auth_url'; slug: string; url: string }
  | { type: 'integration_needs_fields'; slug: string; fields: { name: string; displayName: string; description: string }[] }
  | { type: 'chat_history'; messages: AgentMessage[] }
  | { type: 'tool_start'; tool: string; label: string }
  | { type: 'tool_end'; tool: string }
  | { type: 'agent_stopped' }
  | { type: 'settings_update'; settings: AgentSettings }
  | { type: 'files_update'; files: FileEntry[] }
  | { type: 'folders_update'; folders: string[] }
  | { type: 'files_search_result'; files: FileEntry[] }
  | { type: 'document_opened'; id: string; filename: string; content: string }
  | { type: 'document_updated'; id: string; content: string }
  | { type: 'document_closed' }
  | { type: 'document_stream_start'; filename: string }
  | { type: 'document_stream_chunk'; text: string }
  | { type: 'auth_status'; status: AuthStatus }
  | { type: 'relay_status'; active: boolean; model: string | null; usage: RelayUsage | null }
  | { type: 'api_keys_status'; keys: { anthropic: boolean; composio: boolean; openai: boolean } }

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
