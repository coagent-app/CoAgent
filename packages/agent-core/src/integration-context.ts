import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

const MAX_CONTEXT_LENGTH = 1000
const DIR_NAME = 'integration-context'

function contextDir(dataDir: string): string {
  const dir = join(dataDir, DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

function slugFile(dataDir: string, slug: string): string {
  return join(contextDir(dataDir), `${slug.toLowerCase()}.json`)
}

export function readIntegrationContext(dataDir: string, slug: string): string {
  const file = slugFile(dataDir, slug)
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf-8'))
      return data.context ?? ''
    }
  } catch { /* corrupt file */ }
  return ''
}

export function writeIntegrationContext(dataDir: string, slug: string, context: string): void {
  const trimmed = context.slice(0, MAX_CONTEXT_LENGTH)
  writeFileSync(slugFile(dataDir, slug), JSON.stringify({ context: trimmed }, null, 2))
}

export function readAllIntegrationContexts(dataDir: string): Record<string, string> {
  const dir = join(dataDir, DIR_NAME)
  if (!existsSync(dir)) return {}
  const result: Record<string, string> = {}
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const slug = file.replace('.json', '')
    const context = readIntegrationContext(dataDir, slug)
    if (context) result[slug] = context
  }
  return result
}
