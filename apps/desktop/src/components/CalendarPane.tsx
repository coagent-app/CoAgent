import React, { useState, useMemo, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Circle, Trash2, Repeat, Calendar as CalendarIcon } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  eachDayOfInterval, format, addWeeks, subWeeks,
  addMonths, subMonths, addDays, subDays,
  isSameDay, isSameMonth, isToday, parseISO,
  setHours, getHours,
} from 'date-fns'
import type { CalendarEntry } from '@coagent/shared'

type CalendarView = 'week' | 'month' | 'day' | 'agenda'

interface CalendarPaneProps {
  entries: CalendarEntry[]
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  activeHours?: { start: number; end: number }
}

const TYPE_COLORS = {
  routine: { bg: 'bg-sky-100 dark:bg-sky-900/30', text: 'text-sky-700 dark:text-sky-300', dot: 'bg-sky-400' },
  task:    { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-400' },
  event:   { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
}

export function CalendarPane({ entries, onComplete, onDelete, activeHours = { start: 7, end: 24 } }: CalendarPaneProps) {
  const [view, setView] = useState<CalendarView>('week')
  const [anchor, setAnchor] = useState(new Date())

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
        </div>
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

      {/* View content */}
      <div className="flex-1 overflow-hidden px-4">
        {view === 'agenda' && <AgendaView entries={entries} onComplete={onComplete} onDelete={onDelete} />}
        {view === 'week' && <WeekView entries={entries} anchor={anchor} activeHours={activeHours} />}
        {view === 'month' && <MonthView entries={entries} anchor={anchor} />}
        {view === 'day' && <DayView entries={entries} anchor={anchor} activeHours={activeHours} />}
      </div>
    </div>
  )
}

/* ── Agenda View ────────────────────────────────────── */

function AgendaView({ entries, onComplete, onDelete }: { entries: CalendarEntry[]; onComplete: (id: string) => void; onDelete: (id: string) => void }) {
  const uncompleted = entries.filter(e => !e.completed)
  const tasks = uncompleted.filter(e => e.type === 'task')
  const routines = uncompleted.filter(e => e.type === 'routine')
  const events = uncompleted.filter(e => e.type === 'event')

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-4">
        {uncompleted.length === 0 ? (
          <p className="text-[14px] text-neutral-400 dark:text-neutral-500 mt-4">No calendar entries yet. Ask Co-Agent to add one.</p>
        ) : (
          <>
            {tasks.length > 0 && <AgendaSection title="Tasks" entries={tasks} onComplete={onComplete} onDelete={onDelete} />}
            {routines.length > 0 && <AgendaSection title="Routines" entries={routines} onComplete={onComplete} onDelete={onDelete} />}
            {events.length > 0 && <AgendaSection title="Events" entries={events} onComplete={onComplete} onDelete={onDelete} />}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function AgendaSection({ title, entries, onComplete, onDelete }: { title: string; entries: CalendarEntry[]; onComplete: (id: string) => void; onDelete: (id: string) => void }) {
  const colors = TYPE_COLORS[entries[0]?.type || 'task']
  return (
    <div className="mb-6">
      <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2">{title}</p>
      <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
        {entries.map(entry => (
          <div key={entry.id} className="flex items-start gap-3 py-3 group">
            {entry.type === 'task' && (
              <button onClick={() => onComplete(entry.id)} className="mt-0.5 flex-shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-emerald-500 transition-colors">
                <Circle size={15} strokeWidth={1.75} />
              </button>
            )}
            {entry.type === 'routine' && <Repeat size={14} className={cn('mt-0.5 flex-shrink-0', colors.text)} />}
            {entry.type === 'event' && <CalendarIcon size={14} className={cn('mt-0.5 flex-shrink-0', colors.text)} />}
            <div className="flex-1 min-w-0">
              <p className="text-[14px] text-neutral-800 dark:text-neutral-200 leading-relaxed">{entry.label}</p>
              <p className={cn('text-[12px] mt-0.5', colors.text)}>
                {entry.cron || (entry.due && formatTime(entry.due)) || (entry.start && `${formatTime(entry.start)}${entry.end ? ` – ${formatTime(entry.end)}` : ''}`)}
              </p>
            </div>
            <button onClick={() => onDelete(entry.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300 dark:text-neutral-600 hover:text-red-500 flex-shrink-0 mt-0.5">
              <Trash2 size={13} />
            </button>
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

function WeekView({ entries, anchor, activeHours }: { entries: CalendarEntry[]; anchor: Date; activeHours: { start: number; end: number } }) {
  const weekStart = startOfWeek(anchor, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(anchor, { weekStartsOn: 0 }) })
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const isOffHour = (h: number) => h < activeHours.start || h >= activeHours.end
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (el) el.scrollTop = activeHours.start * 48
  }, [])

  return (
    <ScrollArea className="h-full">
      <div ref={scrollRef} className="grid grid-cols-[50px_repeat(7,1fr)] min-w-0">
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

        {hours.map(hour => (
          <React.Fragment key={hour}>
            <div className={cn('text-[10px] text-neutral-400 text-right pr-2 pt-1 h-[48px]', isOffHour(hour) && 'opacity-50')}>
              {format(setHours(new Date(), hour), 'h a')}
            </div>
            {days.map(day => {
              const dayEntries = getEntriesForHour(entries, day, hour)
              return (
                <div key={`${day.toISOString()}-${hour}`}
                  className={cn(
                    'h-[48px] border-l border-b border-neutral-200 dark:border-neutral-700 relative',
                    isToday(day) && !isOffHour(hour) && 'bg-blue-50/30 dark:bg-blue-950/10',
                    isOffHour(hour) && 'bg-neutral-50 dark:bg-neutral-900/50'
                  )}>
                  {dayEntries.map(entry => (
                    <div key={entry.id} className={cn('absolute inset-x-0.5 top-0.5 rounded px-1 py-0.5 text-[10px] truncate', TYPE_COLORS[entry.type].bg, TYPE_COLORS[entry.type].text)}>
                      {entry.label}
                    </div>
                  ))}
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

function MonthView({ entries, anchor }: { entries: CalendarEntry[]; anchor: Date }) {
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
              'border-b border-r border-neutral-200 dark:border-neutral-700 p-1.5 overflow-hidden',
              !isSameMonth(day, anchor) && 'opacity-40',
              isToday(day) && 'bg-blue-50/50 dark:bg-blue-950/20'
            )}>
              <p className={cn('text-[11px] font-medium mb-0.5', isToday(day) ? 'text-blue-600' : 'text-neutral-500')}>{format(day, 'd')}</p>
              {dayEntries.slice(0, 3).map(entry => (
                <div key={entry.id} className={cn('text-[9px] truncate rounded px-1 mb-0.5', TYPE_COLORS[entry.type].bg, TYPE_COLORS[entry.type].text)}>
                  {entry.label}
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

function DayView({ entries, anchor, activeHours }: { entries: CalendarEntry[]; anchor: Date; activeHours: { start: number; end: number } }) {
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const isOffHour = (h: number) => h < activeHours.start || h >= activeHours.end
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (el) el.scrollTop = activeHours.start * 48
  }, [])

  return (
    <ScrollArea className="h-full">
      <div ref={scrollRef} className="px-4">
        {hours.map(hour => {
          const hourEntries = getEntriesForHour(entries, anchor, hour)
          return (
            <div key={hour} className={cn(
              'flex border-b border-neutral-200 dark:border-neutral-700 min-h-[48px]',
              isOffHour(hour) && 'bg-neutral-50 dark:bg-neutral-900/50'
            )}>
              <div className={cn('w-[50px] text-[11px] text-neutral-400 text-right pr-3 pt-1 flex-shrink-0', isOffHour(hour) && 'opacity-50')}>
                {format(setHours(new Date(), hour), 'h a')}
              </div>
              <div className="flex-1 py-0.5">
                {hourEntries.map(entry => (
                  <div key={entry.id} className={cn('rounded px-2 py-1 mb-0.5 text-[12px]', TYPE_COLORS[entry.type].bg, TYPE_COLORS[entry.type].text)}>
                    {entry.label}
                  </div>
                ))}
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
    if (e.due) return isSameDay(parseISO(e.due), day)
    if (e.start) return isSameDay(parseISO(e.start), day)
    if (e.cron) return cronMatchesDay(e.cron, day)
    return false
  })
}

function getEntriesForHour(entries: CalendarEntry[], day: Date, hour: number): CalendarEntry[] {
  return entries.filter(e => {
    if (e.completed) return false
    if (e.due && e.due.includes('T')) {
      const d = parseISO(e.due)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.start && e.start.includes('T')) {
      const d = parseISO(e.start)
      return isSameDay(d, day) && getHours(d) === hour
    }
    if (e.cron) {
      return cronMatchesDay(e.cron, day) && cronMatchesHour(e.cron, hour)
    }
    return false
  })
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
