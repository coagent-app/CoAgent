import React from 'react'
import {
  Inbox, MessageSquare, Settings,
  ChevronRight, FolderOpen, Sun, Moon, Calendar as CalendarIcon, Zap, Users
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { Integration } from '@coagent/shared'

export type View = 'chat' | 'calendar' | 'queue' | 'files' | 'skills' | 'settings' | 'team'

interface SidebarProps {
  view: View
  onViewChange: (v: View) => void
  queueCount: number
  integrations: Integration[]
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
  onOpenModal: () => void
  userName?: string
  dark: boolean
  toggleTheme: () => void
  hasTeam?: boolean
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
      {integration.slug === 'coagent:imessage' ? (
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="7" fill="#34C759"/>
          <path d="M16 7C10.477 7 6 10.582 6 15c0 2.52 1.537 4.768 3.938 6.254-.204 1.48-.89 2.87-.89 2.87s2.47-.354 4.072-1.372C14.05 23.23 15 23.35 16 23.35c5.523 0 10-3.582 10-7.35S21.523 7 16 7z" fill="white"/>
        </svg>
      ) : integration.slug === 'coagent:contacts' ? (
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="7" fill="#A2845E"/>
          <circle cx="16" cy="13" r="4.5" fill="white"/>
          <path d="M8.5 24.5c0-4.142 3.358-7.5 7.5-7.5s7.5 3.358 7.5 7.5" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
        </svg>
      ) : (integration as any).domain ? (
        <img
          src={`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${(integration as any).domain}&size=128`}
          alt={integration.name}
          className="w-4 h-4 object-contain flex-shrink-0 rounded-sm"
          onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
        />
      ) : (integration as any).icon ? (
        <div className="w-4 h-4 flex-shrink-0" dangerouslySetInnerHTML={{ __html: (integration as any).icon.replace(/viewBox/, 'class="w-4 h-4" viewBox') }} />
      ) : (integration as any).builtin ? (
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="7" fill="#34C759"/>
          <path d="M16 7C10.477 7 6 10.582 6 15c0 2.52 1.537 4.768 3.938 6.254-.204 1.48-.89 2.87-.89 2.87s2.47-.354 4.072-1.372C14.05 23.23 15 23.35 16 23.35c5.523 0 10-3.582 10-7.35S21.523 7 16 7z" fill="white"/>
        </svg>
      ) : (
        <img
          src={`https://logos.composio.dev/api/${integration.slug}`}
          alt={integration.name}
          className="w-4 h-4 object-contain flex-shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
        />
      )}
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

export function Sidebar({ view, onViewChange, queueCount, integrations, onConnect, onDisconnect, onOpenModal, userName, dark, toggleTheme, hasTeam }: SidebarProps) {

  return (
    <div className="w-52 bg-[#FAFAFA] dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 flex flex-col py-4 px-3 flex-shrink-0">
      <div className="px-2 mb-5">
        <span className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Co-Agent
        </span>
      </div>

      <div className="flex flex-col gap-0.5 mb-2">
        <NavItem icon={MessageSquare} label="Chat" active={view === 'chat'} onClick={() => onViewChange('chat')} />
        {hasTeam && <NavItem icon={Users} label="Team" active={view === 'team'} onClick={() => onViewChange('team')} />}
        <NavItem icon={Zap} label="Skills" active={view === 'skills'} onClick={() => onViewChange('skills')} />
        <NavItem icon={CalendarIcon} label="Schedule" active={view === 'calendar'} onClick={() => onViewChange('calendar')} />
        <NavItem icon={Inbox} label="Queue" active={view === 'queue'} onClick={() => onViewChange('queue')} badge={queueCount} />
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
        {integrations
          .filter(i => !i.connected && i.suggested)
          .slice(0, MAX_SIDEBAR_INTEGRATIONS - integrations.filter(i => i.connected).length)
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
            {userName ? userName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : 'ME'}
          </AvatarFallback>
        </Avatar>
        <span className="text-[13px] font-medium text-neutral-600 dark:text-neutral-400">{userName || 'Settings'}</span>
      </button>
    </div>
  )
}
