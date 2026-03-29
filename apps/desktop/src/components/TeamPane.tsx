import { useState, useRef, useEffect } from 'react'
import { Users, Send, Bot, User } from 'lucide-react'

interface TeamMember {
  userId: string
  name: string
  role: string
  handles: string
}

interface TeamMessage {
  id: string
  timestamp: string
  from: { userId: string; name: string; role: string; isAgent: boolean }
  visible: string
  agentContext: string
  to: string | string[] | null
  attachments: string[]
}

interface TeamInfo {
  teamId: string
  name: string
  members: TeamMember[]
}

interface TeamPaneProps {
  team: TeamInfo | null
  messages: TeamMessage[]
  onSendMessage: (message: string, to?: string) => void
}

export function TeamPane({ team, messages, onSendMessage }: TeamPaneProps) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  if (!team) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <div className="text-center">
          <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">No team yet</p>
          <p className="text-sm mt-2">Create or join a team in Settings</p>
        </div>
      </div>
    )
  }

  const handleSend = () => {
    if (!input.trim()) return
    onSendMessage(input.trim())
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{team.name}</h2>
          <p className="text-xs text-zinc-500">{team.members.length} members</p>
        </div>
        <div className="flex gap-1">
          {team.members.map(m => (
            <div key={m.userId} className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-[10px] text-zinc-300" title={`${m.name} (${m.role})`}>
              {m.name.charAt(0)}
            </div>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3" ref={scrollRef}>
        <div className="space-y-4">
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${msg.from.isAgent ? 'bg-indigo-900/50 text-indigo-400' : 'bg-zinc-700 text-zinc-300'}`}>
                {msg.from.isAgent ? <Bot className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-zinc-300">
                    {msg.from.name}{msg.from.isAgent ? "'s Agent" : ''}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  {msg.to && (
                    <span className="text-[10px] text-indigo-400">
                      → {Array.isArray(msg.to) ? msg.to.join(', ') : msg.to}
                    </span>
                  )}
                </div>
                <p className="text-sm text-zinc-200 mt-0.5 whitespace-pre-wrap">{msg.visible}</p>
              </div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="text-center text-zinc-600 py-12">
              <p className="text-sm">No messages yet</p>
              <p className="text-xs mt-1">Team messages will appear here</p>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-zinc-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Type a message..."
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 rounded-lg text-sm text-white transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
