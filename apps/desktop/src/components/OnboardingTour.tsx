import React, { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { MessageSquare, Zap, CalendarDays, FolderOpen, Inbox, ArrowRight, ArrowLeft, Check, Sparkles, Puzzle } from 'lucide-react'
import type { AgentSettings } from '@coagent/shared'

interface OnboardingTourProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
  onOpenIntegrations: () => void
  onNavigate: (view: string) => void
  onActivate?: (token: string, relayUrl: string) => void
  hasRelay?: boolean
  setTourDone: (done: boolean) => void
}

const STEPS = [
  { id: 'welcome', view: null, sidebar: null },
  { id: 'chat', view: 'chat', sidebar: 'Chat' },
  { id: 'schedule', view: 'calendar', sidebar: 'Schedule' },
  { id: 'queue', view: 'queue', sidebar: 'Queue' },
  { id: 'skills', view: 'skills', sidebar: 'Skills' },
  { id: 'files', view: 'files', sidebar: 'Files' },
  { id: 'integrations', view: null, sidebar: null },
  { id: 'done', view: 'chat', sidebar: null },
] as const

type StepId = typeof STEPS[number]['id']

const FEATURE_CONTENT: Record<string, { icon: React.ElementType; title: string; description: string; details: string[] }> = {
  chat: {
    icon: MessageSquare,
    title: 'Chat',
    description: 'Your main interface with Co-Agent. Talk naturally — it understands context and takes real actions.',
    details: [
      'Draft and send emails, Slack messages, and notifications',
      'Research the web, companies, and people in real time',
      'Remembers everything across conversations — preferences, contacts, past work',
      'Runs Python code, analyzes data, and creates visualizations',
      'Spawns multiple sub-agents to handle parallel tasks simultaneously',
      'Attach files, images, or voice — drop them right into the chat',
    ],
  },
  schedule: {
    icon: CalendarDays,
    title: 'Schedule',
    description: 'Your agent works on a schedule — even when you\'re not looking. Set routines and let it handle recurring work autonomously.',
    details: [
      'Two-way Google Calendar sync — your agent sees and creates events',
      'Daily heartbeats: your agent wakes up, checks your calendar, and runs tasks',
      'Set active hours so it only works when you want it to',
      'Cron-based routines — "check my leads every Monday" just works',
      'Wakes your Mac from sleep to run scheduled tasks on time',
    ],
  },
  queue: {
    icon: Inbox,
    title: 'Queue',
    description: 'You stay in control. Before your agent sends an email, posts a message, or takes any external action — it asks for your approval here.',
    details: [
      'Review every outgoing email, Slack message, or API call before it happens',
      'Edit the content inline — fix a subject line or tweak the wording',
      'Approve or reject with one click',
      'Batch approve when you trust the agent\'s judgment',
      'Nothing leaves your machine without your explicit OK',
    ],
  },
  skills: {
    icon: Zap,
    title: 'Skills',
    description: 'Pre-built and custom automations your agent can use. Think of them as reusable playbooks it follows.',
    details: [
      'Comes with built-in skills — email outreach, lead research, document creation',
      'Create your own: describe a workflow in plain English and save it',
      'Skills can chain tools together — research → draft → send, all in one step',
      'Share skills across conversations — build once, use forever',
      'Edit and refine skills as your workflow evolves',
    ],
  },
  files: {
    icon: FolderOpen,
    title: 'Files',
    description: 'Your agent\'s knowledge base. Upload documents, and it can search, read, and reference them in any conversation.',
    details: [
      'Supports PDF, DOCX, XLSX, images, and text files',
      'Video and audio files are automatically transcribed — your agent can search spoken content',
      'Semantic search — find files by meaning, not just keywords',
      'Fill PDF forms programmatically with your agent',
      'Auto-organizes files into folders based on content',
      'Generated documents (proposals, reports) are saved here automatically',
    ],
  },
  integrations: {
    icon: Puzzle,
    title: 'Integrations',
    description: 'Connect the apps you already use. Your agent can read from and act on all of them.',
    details: [
      'Gmail — read, draft, send, and reply to emails',
      'Google Calendar — view, create, and manage events',
      'Slack — read channels and send messages',
      'Apollo — find people, companies, and enrich contact data',
      'Notion, Google Docs, Calendly, Mailchimp, and more',
      'Each integration gives your agent real tools — not just data access',
    ],
  },
}

export function OnboardingTour({ settings, onUpdate, onOpenIntegrations, onNavigate, onActivate, hasRelay, setTourDone }: OnboardingTourProps) {
  const [step, setStep] = useState<StepId>('welcome')
  const [activationCode, setActivationCode] = useState('')
  const [activationError, setActivationError] = useState('')
  const [activating, setActivating] = useState(false)
  const stepIndex = STEPS.findIndex(s => s.id === step)
  const stepDef = STEPS[stepIndex]

  // Navigate to the correct view when step changes
  useEffect(() => {
    if (stepDef.view) {
      onNavigate(stepDef.view)
    }
  }, [step])

  // Add/remove sidebar highlight class
  useEffect(() => {
    // Clear previous highlights
    document.querySelectorAll('[data-tour-highlight]').forEach(el => {
      el.removeAttribute('data-tour-highlight')
    })

    if (stepDef.sidebar) {
      // Find the sidebar button by its text content
      const sidebarButtons = document.querySelectorAll('.sidebar-nav-item')
      sidebarButtons.forEach(btn => {
        if (btn.textContent?.trim() === stepDef.sidebar) {
          btn.setAttribute('data-tour-highlight', 'true')
        }
      })
    }

    if (step === 'integrations') {
      const manageBtn = document.querySelector('[data-tour-integrations]')
      manageBtn?.setAttribute('data-tour-highlight', 'true')
    }

    return () => {
      document.querySelectorAll('[data-tour-highlight]').forEach(el => {
        el.removeAttribute('data-tour-highlight')
      })
    }
  }, [step])

  function next() {
    const nextStep = STEPS[stepIndex + 1]
    if (nextStep) setStep(nextStep.id)
  }

  function back() {
    const prevStep = STEPS[stepIndex - 1]
    if (prevStep) setStep(prevStep.id)
  }

  function finish() {
    setTourDone(true)
    onNavigate('chat')
  }

  function finishAndGo(action: () => void) {
    setTourDone(true)
    action()
  }

  const isModal = step === 'welcome' || step === 'done'
  const feature = FEATURE_CONTENT[step]

  return (
    <>
      {/* Tour highlight styles */}
      <style>{`
        [data-tour-highlight] {
          position: relative;
          z-index: 52;
          box-shadow: 0 0 0 2px rgb(99 102 241 / 0.5), 0 0 12px 2px rgb(99 102 241 / 0.2);
          border-radius: 8px;
          animation: tour-pulse 2s ease-in-out infinite;
        }
        @keyframes tour-pulse {
          0%, 100% { box-shadow: 0 0 0 2px rgb(99 102 241 / 0.5), 0 0 12px 2px rgb(99 102 241 / 0.2); }
          50% { box-shadow: 0 0 0 3px rgb(99 102 241 / 0.7), 0 0 20px 4px rgb(99 102 241 / 0.3); }
        }
      `}</style>

      {/* Overlay — lighter for feature steps so real UI is visible */}
      <div
        className={cn(
          'fixed inset-0 z-50 transition-colors duration-300',
          isModal ? 'bg-black/50 dark:bg-black/60' : 'bg-black/15 dark:bg-black/25 pointer-events-none'
        )}
      />

      {/* Welcome modal */}
      {step === 'welcome' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl w-[420px] overflow-hidden">
            <div className="h-1 bg-neutral-100 dark:bg-neutral-800">
              <div className="h-full bg-neutral-900 dark:bg-neutral-100 transition-all duration-300 w-[12%]" />
            </div>
            <div className="p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 dark:from-neutral-100 dark:to-neutral-300 flex items-center justify-center mx-auto mb-5 shadow-lg">
                <Sparkles className="w-8 h-8 text-white dark:text-neutral-900" />
              </div>
              <h2 className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                Welcome to Co-Agent
              </h2>
              <p className="text-[13px] text-neutral-400 dark:text-neutral-500 mb-1">
                Private Beta
              </p>
              <p className="text-[14px] text-neutral-500 dark:text-neutral-400 leading-relaxed mb-2">
                Your personal AI operator that runs privately on your machine. It connects to your email, calendar, files, and apps — then takes real actions on your behalf.
              </p>
              <p className="text-[12.5px] text-neutral-400 dark:text-neutral-500 leading-relaxed mb-6">
                Let's walk through what it can do.
              </p>

              {!hasRelay ? (
                <div className="text-left">
                  <input
                    type="text"
                    value={activationCode}
                    onChange={e => { setActivationCode(e.target.value); setActivationError('') }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && activationCode.trim()) {
                        setActivating(true)
                        onActivate?.(activationCode.trim(), (import.meta.env.VITE_RELAY_URL as string))
                        setTimeout(() => setActivating(false), 3000)
                      }
                    }}
                    placeholder="Enter your activation code"
                    className="w-full px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[14px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600 mb-3"
                    autoFocus
                  />
                  {activationError && <p className="text-[12px] text-red-500 mb-3">{activationError}</p>}
                  <button
                    onClick={() => {
                      if (!activationCode.trim()) { setActivationError('Enter your activation code'); return }
                      setActivating(true)
                      onActivate?.(activationCode.trim(), (import.meta.env.VITE_RELAY_URL as string))
                      setTimeout(() => setActivating(false), 3000)
                    }}
                    disabled={activating}
                    className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {activating ? 'Activating…' : 'Activate'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={next}
                  className="flex items-center gap-2 py-2.5 px-6 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity mx-auto"
                >
                  Show me around
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Feature step — floating card at bottom center */}
      {feature && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl border border-neutral-200 dark:border-neutral-700 w-[520px] overflow-hidden">
            {/* Progress */}
            <div className="h-1 bg-neutral-100 dark:bg-neutral-800">
              <div
                className="h-full bg-neutral-900 dark:bg-neutral-100 transition-all duration-300"
                style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
              />
            </div>

            <div className="p-5">
              <div className="flex items-start gap-4 mb-3">
                {/* Icon */}
                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center flex-shrink-0">
                  <feature.icon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-[16px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
                    {feature.title}
                  </h3>
                  <p className="text-[13px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </div>

              {/* Detail bullets */}
              <div className="ml-14 mb-3 space-y-1.5">
                {feature.details.map((detail, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="w-1 h-1 rounded-full bg-neutral-300 dark:bg-neutral-600 mt-[7px] flex-shrink-0" />
                    <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400 leading-snug">{detail}</p>
                  </div>
                ))}
              </div>

              {/* Nav */}
              <div className="flex items-center gap-3 pt-3 border-t border-neutral-100 dark:border-neutral-800">
                <button
                  onClick={back}
                  className="flex items-center gap-1 text-[12.5px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </button>

                <span className="text-[11px] text-neutral-300 dark:text-neutral-600">
                  {stepIndex} of {STEPS.length - 1}
                </span>

                <button
                  onClick={next}
                  className="flex items-center gap-2 py-1.5 px-4 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[13px] font-medium hover:opacity-90 transition-opacity ml-auto"
                >
                  Next
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Done modal */}
      {step === 'done' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl w-[420px] overflow-hidden">
            <div className="h-1 bg-neutral-100 dark:bg-neutral-800">
              <div className="h-full bg-neutral-900 dark:bg-neutral-100 w-full" />
            </div>
            <div className="p-6">
              <div className="text-center mb-5">
                <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center mx-auto mb-3">
                  <Check className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                </div>
                <h2 className="text-[20px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
                  You're all set!
                </h2>
                <p className="text-[13.5px] text-neutral-500 dark:text-neutral-400">
                  Connect your apps first so your agent can actually do things — then start chatting.
                </p>
              </div>

              <div className="flex flex-col gap-2 mb-5">
                <QuickAction
                  icon={Puzzle}
                  title="Connect your apps"
                  subtitle="Gmail, Slack, Calendar, and more"
                  onClick={() => finishAndGo(onOpenIntegrations)}
                />
                <QuickAction
                  icon={CalendarDays}
                  title="Set up your schedule"
                  subtitle="Active hours, routines, and calendar sync"
                  onClick={() => finishAndGo(() => onNavigate('calendar'))}
                />
                <QuickAction
                  icon={Zap}
                  title="Explore your skills"
                  subtitle="Ready-made automations you can customize"
                  onClick={() => finishAndGo(() => onNavigate('skills'))}
                />
              </div>

              <button
                onClick={finish}
                className="w-full py-2.5 rounded-xl bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[14px] font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
              >
                <MessageSquare className="w-4 h-4" />
                Start chatting
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function QuickAction({ icon: Icon, title, subtitle, onClick }: {
  icon: React.ElementType
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 p-3 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-left group"
    >
      <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center flex-shrink-0">
        <Icon className="w-4 h-4 text-neutral-600 dark:text-neutral-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">{title}</div>
        <div className="text-[11.5px] text-neutral-500 dark:text-neutral-400">{subtitle}</div>
      </div>
      <ArrowRight className="w-4 h-4 text-neutral-300 dark:text-neutral-600 group-hover:text-neutral-500 dark:group-hover:text-neutral-400 transition-colors" />
    </button>
  )
}
