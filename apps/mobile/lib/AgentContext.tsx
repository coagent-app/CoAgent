import React, { createContext, useContext } from 'react'
import { useAgent } from './useAgent'

type AgentContextValue = ReturnType<typeof useAgent>

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const agent = useAgent()
  return <AgentContext.Provider value={agent}>{children}</AgentContext.Provider>
}

export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgentContext must be used within AgentProvider')
  return ctx
}
