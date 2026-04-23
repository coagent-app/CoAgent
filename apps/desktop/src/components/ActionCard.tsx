import React, { useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionCardState = {
  id: string
  messageIdx: number
  title: string
  platform: string
  summary?: string
  body?: string
  variants?: { label: string; body: string }[]
  fields?: { label: string; value: string }[]
  action: { label: string; confirmPrompt: string }
  status: 'pending' | 'sent' | 'dismissed'
  sentAt?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  slack: 'Slack',
  imessage: 'iMessage',
  googlecalendar: 'Google Calendar',
  outlook: 'Outlook',
  linear: 'Linear',
  notion: 'Notion',
  jira: 'Jira',
  asana: 'Asana',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  sms: 'SMS',
  stripe: 'Stripe',
}

function platformLabel(slug: string): string {
  return PLATFORM_LABELS[slug] ?? (slug.charAt(0).toUpperCase() + slug.slice(1))
}

function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="2.5,8.5 6.5,12.5 13.5,3.5" />
    </svg>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ActionCard({
  card,
  onApprove,
  onDismiss,
}: {
  card: ActionCardState
  onApprove: (cardId: string, selectedVariantLabel?: string) => void
  onDismiss: (cardId: string) => void
}) {
  const [activeVariantIdx, setActiveVariantIdx] = useState(0)

  // Sent or dismissed: render nothing
  if (card.status === 'sent' || card.status === 'dismissed') return null

  // Pending: full card
  const hasVariants = card.variants && card.variants.length > 0
  const activeVariant = hasVariants ? card.variants![activeVariantIdx] : undefined
  const bodyText = activeVariant?.body ?? card.body

  function handleApprove() {
    onApprove(card.id, activeVariant?.label)
  }

  function handleDismiss() {
    onDismiss(card.id)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleApprove()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleDismiss()
    }
  }

  const logoUrl = `https://logos.composio.dev/api/${card.platform}`

  return (
    <div className="flex justify-start">
      <div
        className="max-w-[620px] w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl overflow-hidden"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {/* Target strip */}
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-neutral-100/60 dark:bg-neutral-800/60 border-b border-neutral-200 dark:border-neutral-800">
          <img
            src={logoUrl}
            width={18}
            height={18}
            alt=""
            className="rounded-[4px] flex-shrink-0"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
          <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-200">
            {card.title}
          </span>
          {card.summary && (
            <>
              <span className="text-neutral-400 dark:text-neutral-500">·</span>
              <span className="text-[12.5px] text-neutral-500 dark:text-neutral-400 truncate">
                {card.summary}
              </span>
            </>
          )}
        </div>

        {/* Body section */}
        <div className="p-4 space-y-3">
          {/* Variant tabs */}
          {hasVariants && (
            <div className="inline-flex gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800/60">
              {card.variants!.map((variant, idx) => {
                const isActive = idx === activeVariantIdx
                const letter = String.fromCharCode(65 + idx) // A, B, C...
                return (
                  <button
                    key={variant.label}
                    onClick={() => setActiveVariantIdx(idx)}
                    className={
                      isActive
                        ? 'inline-flex items-center bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 shadow-sm ring-1 ring-neutral-200 dark:ring-neutral-700 px-3 py-1 rounded-md text-[12.5px] font-medium'
                        : 'inline-flex items-center text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 px-3 py-1 rounded-md text-[12.5px] font-medium'
                    }
                  >
                    <span className="inline-flex w-4 h-4 items-center justify-center text-[10px] font-bold rounded-full bg-neutral-200 dark:bg-neutral-700 mr-1.5">
                      {letter}
                    </span>
                    {variant.label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Body text */}
          {bodyText && (
            <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-neutral-700 dark:text-neutral-300 m-0">
              {bodyText}
            </pre>
          )}

          {/* Fields grid */}
          {card.fields && card.fields.length > 0 && (
            <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
              {card.fields.map((field) => (
                <React.Fragment key={field.label}>
                  <span className="text-[11px] uppercase tracking-wider font-medium text-neutral-500 dark:text-neutral-400 self-start pt-px">
                    {field.label}
                  </span>
                  <span className="text-[13px] text-neutral-800 dark:text-neutral-200">
                    {field.value}
                  </span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50 flex items-center justify-end gap-2">
          <button
            onClick={handleDismiss}
            className="text-[12.5px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 px-2.5 py-1.5 rounded-md transition-colors"
          >
            Dismiss
          </button>
          <button
            onClick={handleApprove}
            disabled={!card.action.confirmPrompt}
            className="inline-flex items-center gap-2 bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-colors"
          >
            <img
              src={logoUrl}
              width={14}
              height={14}
              alt=""
              className="rounded-[3px] flex-shrink-0"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
            {card.action.label || 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
