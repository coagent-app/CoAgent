// packages/agent-core/src/constants.ts
// Shared constants — single source of truth for values used across multiple modules

/** Kimi K2.5 model identifier used with the Moonshot OpenAI-compatible API */
export const KIMI_MODEL = 'kimi-k2.5'

/** Official Moonshot API base URL (OpenAI-compatible) */
export const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'

/** Embedding vector dimension for text-embedding-3-small at 512 dimensions */
export const EMBED_DIM = 512

/** OpenAI embedding model used throughout for semantic search */
export const EMBEDDING_MODEL = 'text-embedding-3-small'
