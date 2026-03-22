import React from 'react'
import {
  Inbox, MessageSquare, CheckCircle2, Settings, ListTodo,
  ChevronRight, FolderOpen, Sun, Moon
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { Integration } from '@coagent/shared'

export type View = 'chat' | 'queue' | 'todos' | 'done' | 'settings' | 'files'

interface SidebarProps {
  view: View
  onViewChange: (v: View) => void
  queueCount: number
  todoCount: number
  integrations: Integration[]
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
  onOpenModal: () => void
  userName?: string
  dark: boolean
  toggleTheme: () => void
}

const MAX_SIDEBAR_INTEGRATIONS = 8

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: React.ElementType
  label: string
  active?: boolean
  onClick?: () => void
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left',
        active
          ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
          : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
      )}
    >
      <Icon size={15} strokeWidth={1.75} className="flex-shrink-0" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <Badge className="ml-auto h-4 px-1.5 text-[10px] bg-neutral-900 text-white hover:bg-neutral-900 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-200">
          {badge}
        </Badge>
      )}
    </button>
  )
}

function IntegrationItem({
  integration,
  onConnect,
  onDisconnect,
}: {
  integration: Integration
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
}) {
  function handleClick() {
    if (integration.connected) {
      onDisconnect(integration.slug)
    } else {
      onConnect(integration.slug)
    }
  }

  return (
    <button
      onClick={handleClick}
      title={integration.connected ? `${integration.name} — click to disconnect` : `Connect ${integration.name}`}
      className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
    >
      <img
        src={`https://logos.composio.dev/api/${integration.slug}`}
        alt={integration.name}
        className="w-4 h-4 object-contain flex-shrink-0"
        onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
      />
      <span className="flex-1">{integration.name}</span>
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          integration.connected ? 'bg-emerald-400' : 'bg-neutral-300 dark:bg-neutral-600'
        )}
      />
    </button>
  )
}

export function Sidebar({ view, onViewChange, queueCount, todoCount, integrations, onConnect, onDisconnect, onOpenModal, userName, dark, toggleTheme }: SidebarProps) {

  return (
    <div className="w-52 bg-[#FAFAFA] dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 flex flex-col py-4 px-3 flex-shrink-0">
      <div className="px-2 mb-5">
        <span className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Co-Agent
        </span>
      </div>

      <div className="flex flex-col gap-0.5 mb-2">
        <NavItem icon={MessageSquare} label="Chat" active={view === 'chat'} onClick={() => onViewChange('chat')} />
        <NavItem icon={ListTodo} label="To-Do" active={view === 'todos'} onClick={() => onViewChange('todos')} badge={todoCount} />
        <NavItem icon={Inbox} label="Queue" active={view === 'queue'} onClick={() => onViewChange('queue')} badge={queueCount} />
        <NavItem icon={CheckCircle2} label="Done" active={view === 'done'} onClick={() => onViewChange('done')} />
        <NavItem icon={FolderOpen} label="Files" active={view === 'files'} onClick={() => onViewChange('files')} />
      </div>

      <Separator className="my-3 dark:bg-neutral-800" />

      <p className="px-2.5 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2">
        Integrations
      </p>
      <div className="flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 340px)' }}>
        {integrations
          .filter(i => i.connected)
          .slice(0, MAX_SIDEBAR_INTEGRATIONS)
          .map(integration => (
            <IntegrationItem
              key={integration.slug}
              integration={integration}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          ))}
        <button
          onClick={onOpenModal}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
        >
          <ChevronRight size={12} />
          {integrations.filter(i => i.connected).length > 0 ? 'Manage' : 'Connect apps'}
        </button>
      </div>

      <div className="flex-1" />

      <Separator className="mb-3 dark:bg-neutral-800" />

      <button
        onClick={toggleTheme}
        title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors text-left text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        {dark ? (
          <Sun size={15} strokeWidth={1.75} className="flex-shrink-0" />
        ) : (
          <Moon size={15} strokeWidth={1.75} className="flex-shrink-0" />
        )}
        <span>{dark ? 'Light Mode' : 'Dark Mode'}</span>
      </button>
      <NavItem icon={Settings} label="Settings" active={view === 'settings'} onClick={() => onViewChange('settings')} />
      <button
        onClick={() => onViewChange('settings')}
        className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors mt-0.5"
      >
        <Avatar className="h-6 w-6">
          <AvatarFallback className="text-[10px] font-semibold bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
            {userName ? userName.slice(0, 2).toUpperCase() : 'ME'}
          </AvatarFallback>
        </Avatar>
        <span className="text-[13px] font-medium text-neutral-600 dark:text-neutral-400">{userName || 'Settings'}</span>
      </button>
    </div>
  )
}
