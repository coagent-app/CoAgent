import React, { useState, useMemo, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Circle, Trash2, Repeat, Clock, X, CheckCircle, CalendarDays } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  eachDayOfInterval, format, addWeeks, subWeeks,
  addMonths, subMonths, addDays, subDays,
  isSameDay, isSameMonth, isToday, parseISO,
  setHours, getHours,
} from 'date-fns'
import type { CalendarEntry, GoogleCalendarInfo } from '@coagent/shared'

type CalendarView = 'week' | 'month' | 'day' | 'agenda'

interface CalendarPaneProps {
  entries: CalendarEntry[]
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  activeHours?: { start: number; end: number }
  googleCalendarStatus?: { connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }
  onGoogleConnect?: () => void
  onGoogleDisconnect?: () => void
  onGoogleToggle?: (calendarId: string, enabled: boolean) => void
  onGoogleColor?: (calendarId: string, color: string) => void
  onGoogleSync?: () => void
  autoBriefMeetings?: boolean
  autoBriefMinutes?: number
  onUpdateSettings?: (patch: Record<string, unknown>) => void
}

const TYPE_COLORS = {
  routine:  { bg: 'bg-sky-100 dark:bg-sky-900',    text: 'text-sky-700 dark:text-sky-300',    dot: 'bg-sky-400' },
  task:     { bg: 'bg-amber-100 dark:bg-amber-900', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-400' },
  followup: { bg: 'bg-purple-100 dark:bg-purple-900', text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500' },
  event:    { bg: 'bg-blue-100 dark:bg-blue-900',   text: 'text-blue-700 dark:text-blue-300',   dot: 'bg-blue-800' },
} as const

function typeColors(type: string) {
  return TYPE_COLORS[type as keyof typeof TYPE_COLORS] ?? TYPE_COLORS.task
}

/** Title-case a label: capitalize first letter of each word */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

export function CalendarPane({
  entries,
  onComplete,
  onDelete,
  activeHours = { start: 7, end: 24 },
  googleCalendarStatus,
  onGoogleConnect,
  onGoogleDisconnect,
  onGoogleToggle,
  onGoogleColor,
  onGoogleSync,
  autoBriefMeetings,
  autoBriefMinutes,
  onUpdateSettings,
}: CalendarPaneProps) {
  const [view, setView] = useState<CalendarView>('week')
  const [anchor, setAnchor] = useState(new Date())
  const [selectedEntry, setSelectedEntry] = useState<CalendarEntry | null>(null)
  const [showGoogleModal, setShowGoogleModal] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const prevLastSync = useRef(googleCalendarStatus?.lastSync ?? null)

  // Auto-sync on mount (calendar tab opened)
  useEffect(() => {
    if (googleCalendarStatus?.connected && onGoogleSync) {
      setSyncing(true)
      onGoogleSync()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-sync on window focus
  useEffect(() => {
    const handleFocus = () => {
      if (googleCalendarStatus?.connected && onGoogleSync) {
        setSyncing(true)
        onGoogleSync()
      }
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [googleCalendarStatus?.connected, onGoogleSync])

  // Detect sync completion
  useEffect(() => {
    if (syncing && googleCalendarStatus?.lastSync && googleCalendarStatus.lastSync !== prevLastSync.current) {
      setSyncing(false)
    }
    prevLastSync.current = googleCalendarStatus?.lastSync ?? null
  }, [googleCalendarStatus?.lastSync, syncing])

  const navigate = (dir: -1 | 1) => {
    if (view === 'week') setAnchor(d => dir === 1 ? addWeeks(d, 1) : subWeeks(d, 1))
    else if (view === 'month') setAnchor(d => dir === 1 ? addMonths(d, 1) : subMonths(d, 1))
    else if (view === 'day') setAnchor(d => dir === 1 ? addDays(d, 1) : subDays(d, 1))
  }
  const goToday = () => setAnchor(new Date())

  const headerLabel = useMemo(() => {
    if (view === 'day') return format(anchor, 'EEEE, MMMM d, yyyy')
    if (view === 'week') {
      const start = startOfWeek(anchor, { weekStartsOn: 0 })
      const end = endOfWeek(anchor, { weekStartsOn: 0 })
      return `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
    }
    if (view === 'month') return format(anchor, 'MMMM yyyy')
    return 'Agenda'
  }, [view, anchor])

  const handleSelect = (entry: CalendarEntry) => {
    setSelectedEntry(prev => prev?.id === entry.id ? null : entry)
  }

  const handleComplete = (id: string) => {
    onComplete(id)
    if (selectedEntry?.id === id) setSelectedEntry(null)
  }

  const handleDelete = (id: string) => {
    onDelete(id)
    if (selectedEntry?.id === id) setSelectedEntry(null)
  }

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-neutral-950 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          {view !== 'agenda' && (
            <>
              <button onClick={() => navigate(-1)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => navigate(1)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded">
                <ChevronRight size={16} />
              </button>
              <button onClick={goToday} className="text-[12px] px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700">
                Today
              </button>
            </>
          )}
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">{headerLabel}</h2>
          {syncing && (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500 animate-pulse">syncing...</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGoogleModal(true)}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
          >
            <img src="https://logos.composio.dev/api/googlecalendar" alt="Google Calendar" className="w-4 h-4 object-contain" />
            {googleCalendarStatus?.connected ? 'Google Calendar' : 'Sync Google Calendar'}
          </button>
          <div className="flex gap-0.5 bg-neutral-100 dark:bg-neutral-800 rounded-lg p-0.5">
            {(['day', 'week', 'month', 'agenda'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-md capitalize transition-colors',
                  view === v ? 'bg-white dark:bg-neutral-700 shadow-sm font-medium' : 'hover:bg-neutral-200 dark:hover:bg-neutral-700'
                )}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* View content + detail panel */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden px-4">
          {view === 'agenda' && <AgendaView entries={entries} onComplete={handleComplete} onDelete={handleDelete} onSelect={handleSelect} selectedId={selectedEntry?.id} />}
          {view === 'week' && <WeekView entries={entries} anchor={anchor} activeHours={activeHours} onSelect={handleSelect} selectedId={selectedEntry?.id} />}
          {view === 'month' && <MonthView entries={entries} anchor={anchor} onSelect={handleSelect} selectedId={selectedEntry?.id} />}
          {view === 'day' && <DayView entries={entries} anchor={anchor} activeHours={activeHours} onSelect={handleSelect} selectedId={selectedEntry?.id} />}
        </div>

        {selectedEntry && (
          <EntryDetailPanel
            entry={selectedEntry}
            onComplete={handleComplete}
            onDelete={handleDelete}
            onClose={() => setSelectedEntry(null)}
          />
        )}
      </div>

      {showGoogleModal && (
        <GoogleCalendarModal
          status={googleCalendarStatus || { connected: false, calendars: [], lastSync: null }}
          onConnect={onGoogleConnect || (() => {})}
          onDisconnect={onGoogleDisconnect || (() => {})}
          onToggle={onGoogleToggle || (() => {})}
          onColor={onGoogleColor || (() => {})}
          onClose={() => setShowGoogleModal(false)}
          autoBriefMeetings={autoBriefMeetings ?? false}
          autoBriefMinutes={autoBriefMinutes ?? 30}
          onUpdateSettings={onUpdateSettings}
        />
      )}
    </div>
  )
}

/* ── Entry Detail Panel ─────────────────────────────── */

function EntryDetailPanel({
  entry,
  onComplete,
  onDelete,
  onClose,
}: {
  entry: CalendarEntry
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const colors = typeColors(entry.type)
  const canComplete = entry.type === 'task' || entry.type === 'followup'
  const isGoogleEvent = entry.source === 'google'

  const timingLabel = (() => {
    if (entry.cron) return entry.cron
    if (entry.due) return formatTime(entry.due)
    if (entry.start) return formatTime(entry.start)
    return 'No time set'
  })()

  const timingHeading = (() => {
    if (entry.cron) return 'Schedule'
    if (isGoogleEvent) return 'Time'
    return 'Due'
  })()

  const typeLabel = entry.type.charAt(0).toUpperCase() + entry.type.slice(1)

  return (
    <div className="w-[320px] min-w-[320px] flex-shrink-0 border-l border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-950 flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-4 pt-4 pb-3 flex items-start justify-between border-b border-neutral-100 dark:border-neutral-800">
        <span className={cn('text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full', colors.bg, colors.text)}>
          {typeLabel}
        </span>
        <button
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Panel body */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-4">
          {/* Label */}
          <p className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100 leading-snug">
            {titleCase(entry.label)}
          </p>

          {/* Time range for Google events */}
          {isGoogleEvent && entry.start && entry.end && (
            <div>
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
                Time
              </p>
              <p className={cn('text-[12px]', colors.text)}>
                {formatTime(entry.start)} – {formatTime(entry.end)}
              </p>
            </div>
          )}

          {/* Timing (for non-event entries, or events without end) */}
          {!(isGoogleEvent && entry.start && entry.end) && (
            <div>
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
                {timingHeading}
              </p>
              <p className={cn('text-[12px]', colors.text)}>{timingLabel}</p>
            </div>
          )}

          {/* Location for Google events */}
          {entry.location && (
            <div>
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
                Location
              </p>
              <p className="text-[12px] text-neutral-700 dark:text-neutral-300 leading-relaxed break-all">
                {entry.location}
              </p>
            </div>
          )}

          {/* Instruction */}
          {entry.instruction && (
            <div>
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
                Instruction
              </p>
              <p className="text-[12px] text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap break-all">
                {entry.instruction}
              </p>
            </div>
          )}

          {/* Notes */}
          {entry.notes && (
            <div>
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
                Notes
              </p>
              <p className="text-[12px] text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap">
                {entry.notes}
              </p>
            </div>
          )}

          {/* Created */}
          <div>
            <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
              Created
            </p>
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {formatTime(entry.createdAt)}
            </p>
          </div>
        </div>
      </ScrollArea>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 flex flex-col gap-2">
        {isGoogleEvent ? (
          <p className="text-[11px] text-center text-neutral-400 dark:text-neutral-500">
            Synced from Google Calendar
          </p>
        ) : (
          <>
            {canComplete && !entry.completed && (
              <button
                onClick={() => onComplete(entry.id)}
                className="flex items-center justify-center gap-1.5 w-full text-[12px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded-md px-3 py-1.5 transition-colors"
              >
                <CheckCircle size={13} />
                Mark complete
              </button>
            )}
            <button
              onClick={() => onDelete(entry.id)}
              className="flex items-center justify-center gap-1.5 w-full text-[12px] font-medium text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-md px-3 py-1.5 transition-colors"
            >
              <Trash2 size={13} />
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Google Calendar Modal ──────────────────────────── */

const GOOGLE_COLORS = [
  { name: 'Dark Blue', value: '#1e3a5f' },
  { name: 'Green',     value: '#16a34a' },
  { name: 'Red',       value: '#dc2626' },
  { name: 'Pink',      value: '#ec4899' },
  { name: 'Teal',      value: '#0d9488' },
  { name: 'Orange',    value: '#ea580c' },
  { name: 'Indigo',    value: '#4f46e5' },
]

function GoogleCalendarModal({
  status,
  onConnect,
  onDisconnect,
  onToggle,
  onColor,
  onClose,
  autoBriefMeetings,
  autoBriefMinutes,
  onUpdateSettings,
}: {
  status: { connected: boolean; calendars: GoogleCalendarInfo[]; lastSync: string | null }
  onConnect: () => void
  onDisconnect: () => void
  onToggle: (calendarId: string, enabled: boolean) => void
  onColor: (calendarId: string, color: string) => void
  onClose: () => void
  autoBriefMeetings: boolean
  autoBriefMinutes: number
  onUpdateSettings?: (patch: Record<string, unknown>) => void
}) {
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-xl w-[360px] max-w-[90vw] flex flex-col overflow-hidden">
        {/* Modal header */}
        <div className="px-5 pt-5 pb-4 flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <img src="https://logos.composio.dev/api/googlecalendar" alt="Google Calendar" className="w-4 h-4 object-contain" />
            <h3 className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">Google Calendar</h3>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Modal body */}
        <div className="px-5 py-4 flex flex-col gap-4">
          {!status.connected ? (
            /* Not connected state */
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-[13px] text-neutral-500 dark:text-neutral-400 text-center leading-relaxed">
                Connect your Google Calendar to see events alongside your schedule.
              </p>
              <button
                onClick={onConnect}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-medium transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                Connect with Google
              </button>
            </div>
          ) : (
            /* Connected state */
            <div className="flex flex-col gap-3">
              {/* Calendar list */}
              {status.calendars.length > 0 ? (
                <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
                  {status.calendars.map(cal => (
                    <div key={cal.id} className="flex items-center gap-3 py-2.5 relative">
                      {/* Color dot — click to open color picker */}
                      <button
                        onClick={() => setColorPickerFor(colorPickerFor === cal.id ? null : cal.id)}
                        className="flex-shrink-0 w-3 h-3 rounded-full ring-1 ring-black/10 hover:scale-125 transition-transform"
                        style={{ backgroundColor: cal.color || '#1e3a5f' }}
                        title="Change color"
                      />
                      {/* Color picker popover */}
                      {colorPickerFor === cal.id && (
                        <div className="absolute left-4 top-full mt-1 z-10 bg-white dark:bg-neutral-800 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-800 p-2 flex flex-wrap gap-1.5 w-[140px]">
                          {GOOGLE_COLORS.map(c => (
                            <button
                              key={c.value}
                              onClick={() => { onColor(cal.id, c.value); setColorPickerFor(null) }}
                              title={c.name}
                              className={cn(
                                'w-5 h-5 rounded-full ring-1 ring-black/10 hover:scale-110 transition-transform',
                                cal.color === c.value && 'ring-2 ring-offset-1 ring-blue-500'
                              )}
                              style={{ backgroundColor: c.value }}
                            />
                          ))}
                        </div>
                      )}
                      {/* Calendar name */}
                      <span className="flex-1 text-[13px] text-neutral-800 dark:text-neutral-200 truncate">{cal.name}</span>
                      {/* Toggle checkbox */}
                      <input
                        type="checkbox"
                        checked={cal.enabled}
                        onChange={e => onToggle(cal.id, e.target.checked)}
                        className="flex-shrink-0 w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-neutral-400 dark:text-neutral-500 text-center py-2">No calendars found.</p>
              )}

              {/* Last synced */}
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                {status.lastSync
                  ? `Last synced ${formatTime(status.lastSync)}`
                  : 'Not yet synced'}
              </p>

              {/* Auto-brief before meetings */}
              <div className="flex flex-col gap-2 pt-1 border-t border-neutral-100 dark:border-neutral-800">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoBriefMeetings}
                    onChange={e => onUpdateSettings?.({ auto_brief_meetings: e.target.checked })}
                    className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                  />
                  <span className="text-[13px] text-neutral-700 dark:text-neutral-300">Auto Brief Before Meetings</span>
                </label>
                {autoBriefMeetings && (
                  <div className="flex items-center gap-2 ml-5">
                    <span className="text-[12px] text-neutral-500 dark:text-neutral-400">Brief</span>
                    <select
                      value={autoBriefMinutes}
                      onChange={e => onUpdateSettings?.({ auto_brief_minutes: Number(e.target.value) })}
                      className="text-[12px] bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 rounded px-1.5 py-0.5 border border-neutral-200 dark:border-neutral-700"
                    >
                      <option value={5}>5 min</option>
                      <option value={10}>10 min</option>
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={45}>45 min</option>
                      <option value={60}>1 hour</option>
                    </select>
                    <span className="text-[12px] text-neutral-500 dark:text-neutral-400">before</span>
                  </div>
                )}
              </div>

              {/* Disconnect button */}
              <button
                onClick={onDisconnect}
                className="flex items-center justify-center gap-1.5 w-full text-[12px] font-medium text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-md px-3 py-1.5 transition-colors"
              >
                Disconnect Google Calendar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Agenda View ────────────────────────────────────── */

function AgendaView({
  entries,
  onComplete,
  onDelete,
  onSelect,
  selectedId,
}: {
  entries: CalendarEntry[]
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  onSelect: (entry: CalendarEntry) => void
  selectedId?: string
}) {
  const uncompleted = entries.filter(e => !e.completed)
  const tasks = uncompleted.filter(e => e.type === 'task')
  const routines = uncompleted.filter(e => e.type === 'routine')
  const followups = uncompleted.filter(e => e.type === 'followup')
  const events = uncompleted.filter(e => e.type === 'event')

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-4">
        {uncompleted.length === 0 ? (
          <p className="text-[14px] text-neutral-400 dark:text-neutral-500 mt-4">No calendar entries yet. Ask Co-Agent to add one.</p>
        ) : (
          <>
            {events.length > 0 && <AgendaSection title="Events" entries={events} onComplete={onComplete} onDelete={onDelete} onSelect={onSelect} selectedId={selectedId} />}
            {tasks.length > 0 && <AgendaSection title="Tasks" entries={tasks} onComplete={onComplete} onDelete={onDelete} onSelect={onSelect} selectedId={selectedId} />}
            {routines.length > 0 && <AgendaSection title="Routines" entries={routines} onComplete={onComplete} onDelete={onDelete} onSelect={onSelect} selectedId={selectedId} />}
            {followups.length > 0 && <AgendaSection title="Followups" entries={followups} onComplete={onComplete} onDelete={onDelete} onSelect={onSelect} selectedId={selectedId} />}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function AgendaSection({
  title,
  entries,
  onComplete,
  onDelete,
  onSelect,
  selectedId,
}: {
  title: string
  entries: CalendarEntry[]
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  onSelect: (entry: CalendarEntry) => void
  selectedId?: string
}) {
  const colors = typeColors(entries[0]?.type || 'task')
  return (
    <div className="mb-6">
      <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2">{title}</p>
      <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
        {entries.map(entry => (
          <div
            key={entry.id}
            onClick={() => onSelect(entry)}
            className={cn(
              'flex items-start gap-3 py-3 group cursor-pointer rounded-sm',
              selectedId === entry.id && 'bg-neutral-50 dark:bg-neutral-900'
            )}
          >
            {entry.type === 'task' && (
              <button
                onClick={e => { e.stopPropagation(); onComplete(entry.id) }}
                className="mt-0.5 flex-shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-emerald-500 transition-colors"
              >
                <Circle size={15} strokeWidth={1.75} />
              </button>
            )}
            {entry.type === 'followup' && (
              <button
                onClick={e => { e.stopPropagation(); onComplete(entry.id) }}
                className="mt-0.5 flex-shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-emerald-500 transition-colors"
              >
                <Clock size={14} strokeWidth={1.75} />
              </button>
            )}
            {entry.type === 'routine' && <Repeat size={14} className={cn('mt-0.5 flex-shrink-0', colors.text)} />}
            {entry.type === 'event' && entry.source === 'google' && <img src="https://logos.composio.dev/api/googlecalendar" alt="" className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            {entry.type === 'event' && entry.source !== 'google' && <CalendarDays size={14} className={cn('mt-0.5 flex-shrink-0', colors.text)} />}
            <div className="flex-1 min-w-0">
              <p className="text-[14px] text-neutral-800 dark:text-neutral-200 leading-relaxed">{titleCase(entry.label)}</p>
              <p className={cn('text-[12px] mt-0.5', colors.text)}>
                {entry.cron || (entry.start && formatTime(entry.start)) || (entry.due && formatTime(entry.due)) || ''}
              </p>
            </div>
            {entry.source !== 'google' && (
              <button
                onClick={e => { e.stopPropagation(); onDelete(entry.id) }}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300 dark:text-neutral-600 hover:text-red-500 flex-shrink-0 mt-0.5"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = parseISO(iso)
    return format(d, iso.includes('T') ? 'MMM d, h:mm a' : 'MMM d')
  } catch { return iso }
}

/* ── Week View ──────────────────────────────────────── */

function useCurrentMinute() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function WeekView({
  entries,
  anchor,
  activeHours,
  onSelect,
  selectedId,
}: {
  entries: CalendarEntry[]
  anchor: Date
  activeHours: { start: number; end: number }
  onSelect: (entry: CalendarEntry) => void
  selectedId?: string
}) {
  const weekStart = startOfWeek(anchor, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(anchor, { weekStartsOn: 0 }) })
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const isOffHour = (h: number) => h < activeHours.start || h >= activeHours.end
  const scrollRef = useRef<HTMLDivElement>(null)
  const now = useCurrentMinute()
  const nowTop = (now.getHours() + now.getMinutes() / 60) * 48
  const todayIndex = days.findIndex(d => isToday(d))

  useEffect(() => {
    const el = scrollRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (el) el.scrollTop = activeHours.start * 48
  }, [])

  return (
    <ScrollArea className="h-full">
      <div ref={scrollRef} className="grid grid-cols-[50px_repeat(7,1fr)] min-w-0 relative">
        <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950" />
        {days.map(day => (
          <div key={day.toISOString()} className={cn(
            'sticky top-0 z-10 bg-white dark:bg-neutral-950 text-center py-2 border-b border-l border-neutral-100 dark:border-neutral-800',
            isToday(day) && 'bg-blue-50 dark:bg-blue-950/20'
          )}>
            <p className="text-[10px] text-neutral-400 uppercase">{format(day, 'EEE')}</p>
            <p className={cn('text-[14px] font-medium', isToday(day) ? 'text-blue-600' : 'text-neutral-700 dark:text-neutral-300')}>{format(day, 'd')}</p>
          </div>
        ))}

        {/* Current time indicator */}
        {todayIndex >= 0 && (
          <div
            className="absolute z-30 pointer-events-none"
            style={{
              top: `calc(${nowTop}px + 45px)`, /* offset for sticky header */
              left: `calc(50px + ${todayIndex} * ((100% - 50px) / 7))`,
              width: `calc((100% - 50px) / 7)`,
            }}
          >
            <div className="flex items-center">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 -ml-[3px] flex-shrink-0" />
              <div className="flex-1 h-[1.5px] bg-blue-500" />
            </div>
          </div>
        )}

        {hours.map(hour => (
          <React.Fragment key={hour}>
            <div className={cn('text-[10px] text-neutral-400 text-right pr-2 pt-1 h-[48px]', isOffHour(hour) && 'opacity-50')}>
              {format(setHours(new Date(), hour), 'h a')}
            </div>
            {days.map(day => {
              const dayEntries = getEntriesStartingAtHour(entries, day, hour)
              return (
                <div key={`${day.toISOString()}-${hour}`}
                  className={cn(
                    'h-[48px] border-l border-b border-neutral-200 dark:border-neutral-800 relative overflow-visible',
                    isToday(day) && !isOffHour(hour) && 'bg-blue-50/30 dark:bg-blue-950/10 dark:border-l-transparent',
                    isOffHour(hour) && 'bg-neutral-50 dark:bg-neutral-900/50'
                  )}>
                  {dayEntries.map((entry, idx) => {
                    const durationHours = getEntryDurationHours(entry)
                    const heightPx = Math.max(durationHours * 48, 20)
                    const count = dayEntries.length
                    const widthPct = count > 1 ? `${Math.floor(100 / count)}%` : undefined
                    const leftPct = count > 1 ? `${Math.floor((100 / count) * idx)}%` : undefined
                    return (
                      <div
                        key={entry.id}
                        onClick={() => onSelect(entry)}
                        style={{ height: `${heightPx}px`, zIndex: 20 + idx, ...(widthPct ? { width: widthPct, left: leftPct } : {}) }}
                        className={cn(
                          'absolute top-0 rounded px-1 py-0.5 text-[10px] cursor-pointer overflow-hidden flex items-start gap-1',
                          count <= 1 && 'inset-x-0.5',
                          typeColors(entry.type).bg,
                          typeColors(entry.type).text,
                          selectedId === entry.id && 'ring-1 ring-current'
                        )}
                      >
                        {entry.source === 'google' && <img src="https://logos.composio.dev/api/googlecalendar" alt="" className="w-3 h-3 flex-shrink-0 mt-px" />}
                        <div className="min-w-0 flex-1">
                          <span className="truncate block">{titleCase(entry.label)}</span>
                          {heightPx >= 36 && entry.start && entry.end && (
                            <span className="truncate block opacity-70 text-[9px]">
                              {format(parseISO(entry.start), 'h:mm a')} – {format(parseISO(entry.end), 'h:mm a')}
                            </span>
                          )}
                          {heightPx >= 52 && entry.location && (
                            <span className="truncate block opacity-60 text-[9px]">{entry.location}</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </ScrollArea>
  )
}

/* ── Month View ─────────────────────────────────────── */

function MonthView({
  entries,
  anchor,
  onSelect,
  selectedId,
}: {
  entries: CalendarEntry[]
  anchor: Date
  onSelect: (entry: CalendarEntry) => void
  selectedId?: string
}) {
  const monthStart = startOfMonth(anchor)
  const monthEnd = endOfMonth(anchor)
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 })
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: calStart, end: calEnd })
  const weeks = Math.ceil(days.length / 7)

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="grid grid-cols-7 border-b border-neutral-100 dark:border-neutral-800">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-[10px] text-neutral-400 uppercase text-center py-1.5">{d}</div>
        ))}
      </div>
      <div className="flex-1 grid grid-cols-7" style={{ gridTemplateRows: `repeat(${weeks}, 1fr)` }}>
        {days.map(day => {
          const dayEntries = getEntriesForDay(entries, day)
          return (
            <div key={day.toISOString()} className={cn(
              'border-b border-r border-neutral-200 dark:border-neutral-800 p-1.5 overflow-hidden',
              !isSameMonth(day, anchor) && 'opacity-40',
              isToday(day) && 'bg-blue-50/50 dark:bg-blue-950/20'
            )}>
              <p className={cn('text-[11px] font-medium mb-0.5', isToday(day) ? 'text-blue-600' : 'text-neutral-500')}>{format(day, 'd')}</p>
              {dayEntries.slice(0, 3).map(entry => (
                <div
                  key={entry.id}
                  onClick={() => onSelect(entry)}
                  className={cn(
                    'text-[9px] truncate rounded px-1 mb-0.5 cursor-pointer relative',
                    typeColors(entry.type).bg,
                    typeColors(entry.type).text,
                    selectedId === entry.id && 'ring-1 ring-current'
                  )}
                >
                  {entry.source === 'google' && <img src="https://logos.composio.dev/api/googlecalendar" alt="" className="w-2.5 h-2.5 absolute bottom-0.5 right-1" />}
                  {titleCase(entry.label)}
                </div>
              ))}
              {dayEntries.length > 3 && (
                <p className="text-[9px] text-neutral-400">+{dayEntries.length - 3} more</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Day View ───────────────────────────────────────── */

function DayView({
  entries,
  anchor,
  activeHours,
  onSelect,
  selectedId,
}: {
  entries: CalendarEntry[]
  anchor: Date
  activeHours: { start: number; end: number }
  onSelect: (entry: CalendarEntry) => void
  selectedId?: string
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const isOffHour = (h: number) => h < activeHours.start || h >= activeHours.end
  const scrollRef = useRef<HTMLDivElement>(null)
  const now = useCurrentMinute()
  const showNowLine = isToday(anchor)
  const nowTop = (now.getHours() + now.getMinutes() / 60) * 48

  useEffect(() => {
    const el = scrollRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (el) el.scrollTop = activeHours.start * 48
  }, [])

  return (
    <ScrollArea className="h-full">
      <div ref={scrollRef} className="px-4 relative">
        {/* Current time indicator */}
        {showNowLine && (
          <div
            className="absolute z-30 pointer-events-none"
            style={{ top: `${nowTop}px`, left: '50px', right: '0' }}
          >
            <div className="flex items-center">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 -ml-[3px] flex-shrink-0" />
              <div className="flex-1 h-[1.5px] bg-blue-500" />
            </div>
          </div>
        )}
        {hours.map(hour => {
          const hourEntries = getEntriesStartingAtHour(entries, anchor, hour)
          return (
            <div key={hour} className={cn(
              'border-b border-neutral-200 dark:border-neutral-800 min-h-[48px] flex relative',
              isOffHour(hour) && 'bg-neutral-50 dark:bg-neutral-900/50'
            )}>
              <div className={cn('w-[50px] text-[11px] text-neutral-400 text-right pr-3 pt-1 flex-shrink-0', isOffHour(hour) && 'opacity-50')}>
                {format(setHours(new Date(), hour), 'h a')}
              </div>
              <div className="flex-1 relative overflow-visible">
                {hourEntries.map((entry, idx) => {
                  const durationHours = getEntryDurationHours(entry)
                  const heightPx = Math.max(durationHours * 48, 24)
                  const count = hourEntries.length
                  const widthPct = count > 1 ? `${Math.floor(100 / count)}%` : undefined
                  const leftPct = count > 1 ? `${Math.floor((100 / count) * idx)}%` : undefined
                  return (
                    <div
                      key={entry.id}
                      onClick={() => onSelect(entry)}
                      style={{ height: `${heightPx}px`, zIndex: 20 + idx, ...(widthPct ? { width: widthPct, left: leftPct } : {}) }}
                      className={cn(
                        'absolute top-0 rounded px-2 py-1 text-[12px] cursor-pointer overflow-hidden flex items-start gap-1.5',
                        count <= 1 && 'inset-x-0',
                        typeColors(entry.type).bg,
                        typeColors(entry.type).text,
                        selectedId === entry.id && 'ring-1 ring-current'
                      )}
                    >
                      {entry.source === 'google' && <img src="https://logos.composio.dev/api/googlecalendar" alt="" className="w-3.5 h-3.5 flex-shrink-0 mt-px" />}
                      <div className="min-w-0 flex-1">
                        <span className="truncate block">{titleCase(entry.label)}</span>
                        {heightPx >= 40 && entry.start && entry.end && (
                          <span className="truncate block opacity-70 text-[10px]">
                            {format(parseISO(entry.start), 'h:mm a')} – {format(parseISO(entry.end), 'h:mm a')}
                          </span>
                        )}
                        {heightPx >= 60 && entry.location && (
                          <span className="truncate block opacity-60 text-[10px]">{entry.location}</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

/* ── Helpers ─────────────────────────────────────────── */

function getEntriesForDay(entries: CalendarEntry[], day: Date): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.start) return isSameDay(parseISO(e.start), day)
    if (e.due) return isSameDay(parseISO(e.due), day)
    if (e.cron) return cronMatchesDay(e.cron, day)
    return false
  })
}

function getEntriesForHour(entries: CalendarEntry[], day: Date, hour: number): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.start && e.start.includes('T')) {
      const d = parseISO(e.start)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.due && e.due.includes('T')) {
      const d = parseISO(e.due)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.cron) {
      return cronMatchesDay(e.cron, day) && cronMatchesHour(e.cron, hour)
    }
    return false
  })
}

function getEntriesStartingAtHour(entries: CalendarEntry[], day: Date, hour: number): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.start && e.start.includes('T')) {
      const d = parseISO(e.start)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.due && e.due.includes('T')) {
      const d = parseISO(e.due)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.cron) {
      return cronMatchesDay(e.cron, day) && cronMatchesHour(e.cron, hour)
    }
    return false
  })
}

function getEntryDurationHours(entry: CalendarEntry): number {
  if (entry.start && entry.end) {
    const startMs = parseISO(entry.start).getTime()
    const endMs = parseISO(entry.end).getTime()
    const hours = (endMs - startMs) / (1000 * 60 * 60)
    if (hours > 0) return hours
  }
  return 1 // default 1 hour for entries without end time
}

function cronMatchesDay(cron: string, day: Date): boolean {
  const parts = cron.split(/\s+/)
  if (parts.length < 5) return false
  const dow = parts[4]
  if (dow === '*') return true
  const dayNum = day.getDay()
  if (dow.includes('-')) {
    const [start, end] = dow.split('-').map(Number)
    return dayNum >= start && dayNum <= end
  }
  if (dow.includes(',')) {
    return dow.split(',').map(Number).includes(dayNum)
  }
  return Number(dow) === dayNum
}

function cronMatchesHour(cron: string, hour: number): boolean {
  const parts = cron.split(/\s+/)
  if (parts.length < 5) return false
  const cronHour = parts[1]
  if (cronHour === '*') return true
  return Number(cronHour) === hour
}
