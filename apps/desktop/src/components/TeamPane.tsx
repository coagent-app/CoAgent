import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Users, Send, Bot, Hash, MessageSquare, FileText, Pencil, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

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

const STATUS_WORDS = [
  'Hustling', 'Grinding', 'Locked in', 'Deep work',
  'In the zone', 'Heads down', 'Dialed in', 'Crunching',
  'On the clock', 'In the weeds', 'Plugged in', 'On it',
]

interface TeamPaneProps {
  team: TeamInfo | null
  messages: TeamMessage[]
  teamStatus: { status: 'processing' | 'idle'; from?: string } | null
  onSendMessage: (message: string, to?: string) => void
  relayUrl?: string
  relayToken?: string
}

type Channel = { type: 'main' } | { type: 'dm'; userId: string; name: string } | { type: 'notes' }

export function TeamPane({ team, messages, teamStatus, onSendMessage, relayUrl, relayToken }: TeamPaneProps) {
  const [input, setInput] = useState('')
  const [channel, setChannel] = useState<Channel>({ type: 'main' })
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Team notes state
  const [notesContent, setNotesContent] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesEditing, setNotesEditing] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesUpdatedBy, setNotesUpdatedBy] = useState('')

  // Fetch notes when switching to notes view
  useEffect(() => {
    if (channel.type !== 'notes' || !relayUrl || !relayToken) return
    setNotesLoading(true)
    fetch(`${relayUrl.replace(/\/$/, '')}/team/notes`, {
      headers: { 'Authorization': `Bearer ${relayToken}` }
    })
      .then(r => r.json())
      .then((data: any) => {
        setNotesContent(data.content || '')
        setNotesUpdatedBy(data.updatedBy || '')
        setNotesDraft(data.content || '')
      })
      .catch(() => {})
      .finally(() => setNotesLoading(false))
  }, [channel, relayUrl, relayToken])

  const saveNotes = useCallback(async () => {
    if (!relayUrl || !relayToken) return
    setNotesSaving(true)
    try {
      await fetch(`${relayUrl.replace(/\/$/, '')}/team/notes`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${relayToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: notesDraft, userId: 'default' })
      })
      setNotesContent(notesDraft)
      setNotesEditing(false)
    } catch {}
    setNotesSaving(false)
  }, [relayUrl, relayToken, notesDraft])

  const [statusWord, setStatusWord] = useState(0)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, teamStatus])

  useEffect(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
    })
  }, [])

  // Rotate status words while processing
  useEffect(() => {
    if (!teamStatus) return
    setStatusWord(Math.floor(Math.random() * STATUS_WORDS.length))
    const interval = setInterval(() => {
      setStatusWord(prev => (prev + 1) % STATUS_WORDS.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [teamStatus])

  // Build mention targets from team members: each person + their agent
  const mentionTargets = useMemo(() => {
    if (!team) return []
    const targets: { id: string; label: string; isAgent: boolean }[] = []
    for (const m of team.members) {
      if (m.userId === 'default') continue
      targets.push({ id: `${m.userId}-agent`, label: `${m.name}'s Agent`, isAgent: true })
    }
    return targets
  }, [team])

  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return mentionTargets.filter(t => t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
  }, [mentionQuery, mentionTargets])

  const insertMention = useCallback((target: { id: string; label: string }) => {
    const atIdx = input.lastIndexOf('@')
    if (atIdx === -1) return
    const before = input.slice(0, atIdx)
    const newInput = `${before}@${target.label} `
    setInput(newInput)
    setMentionQuery(null)
    setMentionIdx(0)
    inputRef.current?.focus()
  }, [input])

  const handleInputChange = useCallback((value: string) => {
    setInput(value)

    // Detect @ mention
    const atIdx = value.lastIndexOf('@')
    if (atIdx !== -1 && (atIdx === 0 || value[atIdx - 1] === ' ')) {
      const query = value.slice(atIdx + 1)
      if (!query.includes(' ')) {
        setMentionQuery(query)
        setMentionIdx(0)
        return
      }
    }
    setMentionQuery(null)
  }, [])

  const handleSend = useCallback(() => {
    if (!input.trim()) return
    // Extract @mentions to build "to" field
    const mentionPattern = /@([\w\s']+?)(?=\s@|\s*$|[.,!?])/g
    const mentions: string[] = []
    let match
    while ((match = mentionPattern.exec(input)) !== null) {
      const label = match[1].trim()
      const target = mentionTargets.find(t => t.label.toLowerCase() === label.toLowerCase())
      if (target) mentions.push(target.id)
    }

    const to = channel.type === 'dm' ? channel.userId : mentions.length > 0 ? (mentions.length === 1 ? mentions[0] : mentions) : undefined
    onSendMessage(input.trim(), to as any)
    setInput('')
    setMentionQuery(null)
  }, [input, channel, mentionTargets, onSendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mentionQuery !== null && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => (i + 1) % filteredMentions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => (i - 1 + filteredMentions.length) % filteredMentions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filteredMentions[mentionIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [mentionQuery, filteredMentions, mentionIdx, insertMention, handleSend])

  // Filter messages by channel
  const channelMessages = useMemo(() => {
    if (channel.type === 'main' || channel.type === 'notes') {
      return messages.filter(m => {
        if (!m.to) return true
        const targets = Array.isArray(m.to) ? m.to : [m.to]
        if (targets.length === 1) return false
        return true
      })
    }
    const dmId = channel.userId
    const dmBase = dmId.replace('-agent', '')
    return messages.filter(m => {
      const to = m.to
      if (!to) return false
      const targets = Array.isArray(to) ? to : [to]
      const fromMe = m.from.userId === 'default'
      const fromThem = m.from.userId === dmBase || m.from.userId === dmId
      const toMe = targets.some(t => t === 'default' || t === 'default-agent' || t === dmBase || t === dmId)
      const toThem = targets.some(t => t === dmId || t === dmBase || t.toLowerCase().includes(dmBase))
      return (fromMe && toThem) || (fromThem && toMe)
    })
  }, [messages, channel])

  if (!team) {
    return (
      <div className="flex-1 bg-white dark:bg-neutral-950 flex items-center justify-center">
        <div className="text-center">
          <Users className="w-10 h-10 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
          <p className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">No team yet</p>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mt-1">Create or join a team to get started</p>
        </div>
      </div>
    )
  }

  const channelLabel = channel.type === 'main' ? 'General' : channel.type === 'notes' ? 'Team Notes' : channel.name

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left sidebar — members & DMs */}
      <div className="w-52 bg-[#FAFAFA] dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 flex flex-col py-4 px-3 flex-shrink-0">
        <div className="px-2 mb-4">
          <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
            {team.name}
          </p>
        </div>

        <button
          onClick={() => setChannel({ type: 'main' })}
          className={cn(
            'flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left mb-1',
            channel.type === 'main'
              ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
          )}
        >
          <Hash size={15} strokeWidth={1.75} className="flex-shrink-0" />
          <span>General</span>
        </button>

        <button
          onClick={() => setChannel({ type: 'notes' })}
          className={cn(
            'flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left mb-1',
            channel.type === 'notes'
              ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
          )}
        >
          <FileText size={15} strokeWidth={1.75} className="flex-shrink-0" />
          <span>Notes</span>
        </button>

        <Separator className="my-3 dark:bg-neutral-800" />

        <p className="px-2.5 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2">
          Agents
        </p>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-0.5">
            {team.members.filter(m => m.userId !== 'default').map(m => (
              <button
                key={m.userId}
                onClick={() => setChannel({ type: 'dm', userId: `${m.userId}-agent`, name: `${m.name}'s Agent` })}
                className={cn(
                  'flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left',
                  channel.type === 'dm' && channel.userId === `${m.userId}-agent`
                    ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
                )}
              >
                <Bot size={15} strokeWidth={1.75} className="flex-shrink-0" />
                <span className="flex-1 truncate">{m.name}'s Agent</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main content area */}
      <div className="flex-1 bg-white dark:bg-neutral-950 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-7 py-5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-0.5">
              {team.name}
            </p>
            <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              {channelLabel}
            </h1>
          </div>
          {channel.type === 'notes' ? (
            <div className="flex items-center gap-2">
              {notesUpdatedBy && (
                <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  Last edited by {notesUpdatedBy}
                </span>
              )}
              {notesEditing ? (
                <Button size="sm" onClick={saveNotes} disabled={notesSaving}>
                  <Check size={14} className="mr-1.5" />
                  {notesSaving ? 'Saving...' : 'Save'}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setNotesDraft(notesContent); setNotesEditing(true) }}>
                  <Pencil size={14} className="mr-1.5" />
                  Edit
                </Button>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
            </span>
          )}
        </div>

        {/* Notes view */}
        {channel.type === 'notes' && (
          <ScrollArea className="flex-1">
            <div className="px-7 py-5">
              {notesLoading ? (
                <div className="flex items-center gap-2 py-8">
                  <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              ) : notesEditing ? (
                <textarea
                  value={notesDraft}
                  onChange={e => setNotesDraft(e.target.value)}
                  className="w-full min-h-[400px] bg-transparent text-[13.5px] leading-relaxed text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none resize-none font-mono"
                  placeholder="Write shared notes here... (supports markdown)"
                  autoFocus
                />
              ) : notesContent ? (
                <div className="text-[13.5px] leading-relaxed text-neutral-800 dark:text-neutral-200">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      table: ({ children }) => (
                        <div className="overflow-x-auto my-2">
                          <table className="text-[12.5px] border-collapse w-full">{children}</table>
                        </div>
                      ),
                      thead: ({ children }) => <thead className="bg-neutral-100 dark:bg-neutral-700">{children}</thead>,
                      th: ({ children }) => <th className="border border-neutral-200 dark:border-neutral-600 px-2.5 py-1.5 text-left font-semibold text-neutral-700 dark:text-neutral-200">{children}</th>,
                      td: ({ children }) => <td className="border border-neutral-200 dark:border-neutral-600 px-2.5 py-1.5 text-neutral-600 dark:text-neutral-300">{children}</td>,
                      tr: ({ children }) => <tr className="even:bg-neutral-50 dark:even:bg-neutral-700/50">{children}</tr>,
                      p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                      ul: ({ children }) => <ul className="mb-3 ml-4 list-disc space-y-1">{children}</ul>,
                      ol: ({ children }) => <ol className="mb-3 ml-4 list-decimal space-y-1">{children}</ol>,
                      li: ({ children }) => <li>{children}</li>,
                      strong: ({ children }) => <strong className="font-semibold text-neutral-900 dark:text-neutral-100">{children}</strong>,
                      h1: ({ children }) => <h1 className="text-[18px] font-bold text-neutral-900 dark:text-neutral-100 mb-2 mt-4">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-[16px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2 mt-3">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1 mt-2">{children}</h3>,
                      code: ({ children }) => <code className="bg-neutral-200 dark:bg-neutral-700 rounded px-1 py-0.5 text-[12px] font-mono">{children}</code>,
                      a: ({ href, children }) => <a href={href} className="text-blue-600 dark:text-blue-400 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                    }}
                  >
                    {notesContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="text-center py-16">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
                  <p className="text-[13px] text-neutral-400 dark:text-neutral-500">No team notes yet</p>
                  <p className="text-[12px] text-neutral-300 dark:text-neutral-600 mt-1">Click Edit to add shared notes for your team</p>
                </div>
              )}
            </div>
          </ScrollArea>
        )}

        {/* Messages — hidden when viewing notes */}
        {channel.type !== 'notes' && <ScrollArea className="flex-1">
          <div className="px-7 py-5 flex flex-col gap-3">
            {channelMessages.length === 0 && (
              <div className="flex justify-start">
                <div className="bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[620px] text-[13.5px] leading-relaxed">
                  <p>{channel.type === 'main' ? 'Team messages will appear here. Type @ to mention an agent.' : `Start a conversation with ${channel.type === 'dm' ? channel.name : ''}.`}</p>
                </div>
              </div>
            )}

            {channelMessages.map((msg) => {
              const isOwnMessage = msg.from.userId === 'default'
              return (
                <div key={msg.id} className={cn('flex', isOwnMessage ? 'justify-end' : 'justify-start')}>
                  <div className={isOwnMessage ? 'max-w-[560px]' : 'max-w-[620px]'}>
                    {!isOwnMessage && (
                      <div className="flex items-baseline gap-2 mb-0.5 px-1">
                        <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                          {msg.from.name}{msg.from.isAgent ? "'s Agent" : ''}
                        </span>
                        <span className="text-[10px] text-neutral-300 dark:text-neutral-600">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                    )}
                    {isOwnMessage ? (
                      <div className="bg-neutral-900 dark:bg-neutral-700 text-white text-[13.5px] leading-relaxed rounded-2xl rounded-tr-sm px-4 py-2.5">
                        {msg.visible}
                      </div>
                    ) : (
                      <div className="bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 rounded-2xl rounded-tl-sm px-4 py-3 text-[13.5px] leading-relaxed">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            table: ({ children }) => (
                              <div className="overflow-x-auto my-2">
                                <table className="text-[12.5px] border-collapse w-full">{children}</table>
                              </div>
                            ),
                            thead: ({ children }) => <thead className="bg-neutral-100 dark:bg-neutral-700">{children}</thead>,
                            th: ({ children }) => <th className="border border-neutral-200 dark:border-neutral-600 px-2.5 py-1.5 text-left font-semibold text-neutral-700 dark:text-neutral-200">{children}</th>,
                            td: ({ children }) => <td className="border border-neutral-200 dark:border-neutral-600 px-2.5 py-1.5 text-neutral-600 dark:text-neutral-300">{children}</td>,
                            tr: ({ children }) => <tr className="even:bg-neutral-50 dark:even:bg-neutral-700/50">{children}</tr>,
                            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                            ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
                            ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
                            li: ({ children }) => <li>{children}</li>,
                            strong: ({ children }) => <strong className="font-semibold text-neutral-900 dark:text-neutral-100">{children}</strong>,
                            h1: ({ children }) => <h1 className="text-[15px] font-bold text-neutral-900 dark:text-neutral-100 mb-1 mt-2">{children}</h1>,
                            h2: ({ children }) => <h2 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1 mt-2">{children}</h2>,
                            h3: ({ children }) => <h3 className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-100 mb-0.5 mt-2">{children}</h3>,
                            code: ({ children }) => <code className="bg-neutral-200 dark:bg-neutral-700 rounded px-1 py-0.5 text-[12px] font-mono">{children}</code>,
                            a: ({ href, children }) => <a href={href} className="text-blue-600 dark:text-blue-400 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                          }}
                        >
                          {msg.visible}
                        </ReactMarkdown>
                      </div>
                    )}
                    {isOwnMessage && (
                      <div className="flex items-baseline justify-end gap-2 mt-0.5 px-1">
                        <span className="text-[10px] text-neutral-300 dark:text-neutral-600">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {teamStatus && channel.type === 'dm' && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 px-2 py-3">
                  <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-neutral-400 dark:bg-neutral-500 rounded-full animate-bounce [animation-delay:300ms]" />
                  <span className="text-[12px] ml-1 shimmer-text">{STATUS_WORDS[statusWord]}...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>}

        {/* Input — hidden when viewing notes */}
        {channel.type !== 'notes' && <div className="relative px-7 py-4 border-t border-neutral-100 dark:border-neutral-800">
          {mentionQuery !== null && filteredMentions.length > 0 && (
            <div className="absolute bottom-full left-7 right-7 mb-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden z-10">
              {filteredMentions.map((target, i) => (
                <button
                  key={target.id}
                  onMouseDown={(e) => { e.preventDefault(); insertMention(target) }}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2 text-left text-[13px] transition-colors',
                    i === mentionIdx
                      ? 'bg-neutral-100 dark:bg-neutral-700'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-750'
                  )}
                >
                  <Bot size={14} className="text-neutral-400 dark:text-neutral-500 flex-shrink-0" />
                  <span className="text-neutral-700 dark:text-neutral-200">{target.label}</span>
                  <span className="text-[11px] text-neutral-400 dark:text-neutral-500 ml-auto">@{target.id}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2.5 items-center">
            <Input
              ref={inputRef}
              className="flex-1 text-[13.5px] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder-neutral-500"
              placeholder={channel.type === 'dm' ? `Message ${channel.name}...` : 'Message #General — type @ to mention...'}
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <Button size="sm" onClick={handleSend} disabled={!input.trim()}>
              <Send size={14} className="mr-1.5" />
              Send
            </Button>
          </div>
        </div>}
      </div>
    </div>
  )
}
