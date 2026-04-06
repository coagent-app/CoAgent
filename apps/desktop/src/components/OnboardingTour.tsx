import React, { useState } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { MessageSquare, Zap, CalendarDays, FolderOpen, Puzzle, Inbox, ArrowRight, ArrowLeft, Check, Sparkles } from 'lucide-react'
import type { AgentSettings } from '@coagent/shared'

interface OnboardingTourProps {
  settings: AgentSettings | null
  onUpdate: (patch: Partial<AgentSettings>) => void
  onOpenIntegrations: () => void
  onNavigate: (view: string) => void
}

const STEPS = [
  { id: 'welcome' },
  { id: 'profile' },
  { id: 'chat' },
  { id: 'schedule' },
  { id: 'queue' },
  { id: 'skills' },
  { id: 'files' },
  { id: 'integrations' },
  { id: 'done' },
] as const

type StepId = typeof STEPS[number]['id']

export function OnboardingTour({ settings, onUpdate, onOpenIntegrations, onNavigate }: OnboardingTourProps) {
  const [step, setStep] = useState<StepId>('welcome')
  const [name, setName] = useState(settings?.name || '')
  const [whatYouDo, setWhatYouDo] = useState(settings?.what_you_do || '')

  const stepIndex = STEPS.findIndex(s => s.id === step)

  function next() {
    if (step === 'profile') {
      onUpdate({ name: name.trim(), role: whatYouDo.trim(), what_you_do: whatYouDo.trim() })
    }
    const nextStep = STEPS[stepIndex + 1]
    if (nextStep) setStep(nextStep.id)
  }

  function back() {
    const prevStep = STEPS[stepIndex - 1]
    if (prevStep) setStep(prevStep.id)
  }

  function finish() {
    onUpdate({ onboarded: true, name: name.trim(), role: whatYouDo.trim(), what_you_do: whatYouDo.trim() })
  }

  function finishAndGo(action: () => void) {
    onUpdate({ onboarded: true, name: name.trim(), role: whatYouDo.trim(), what_you_do: whatYouDo.trim() })
    action()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60">
      <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl w-[440px] overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Progress bar */}
        <div className="h-1 bg-neutral-100 dark:bg-neutral-800">
          <div
            className="h-full bg-neutral-900 dark:bg-neutral-100 transition-all duration-300"
            style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="p-6">
          {/* Welcome */}
          {step === 'welcome' && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 dark:from-neutral-100 dark:to-neutral-300 flex items-center justify-center mx-auto mb-4 shadow-lg">
                <Sparkles className="w-7 h-7 text-white dark:text-neutral-900" />
              </div>
              <h2 className="text-[20px] font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                Welcome to Co-Agent
              </h2>
              <p className="text-[13.5px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
                Your personal AI assistant that runs privately on your machine. Let's take a quick tour of what it can do.
              </p>
            </div>
          )}

          {/* Profile */}
          {step === 'profile' && (
            <div>
              <h2 className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
                About you
              </h2>
              <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
                Helps your agent personalize and understand your context.
              </p>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12.5px] font-medium text-neutral-600 dark:text-neutral-400">Name</label>
                  <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="text-[13px]" autoFocus />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12.5px] font-medium text-neutral-600 dark:text-neutral-400">What do you do?</label>
                  <Input value={whatYouDo} onChange={e => setWhatYouDo(e.target.value)} placeholder="e.g. real estate agent, marketing manager" className="text-[13px]" />
                </div>
              </div>
            </div>
          )}

          {/* Feature: Chat */}
          {step === 'chat' && (
            <FeatureStep
              icon={MessageSquare}
              color="blue"
              title="Chat"
              description="Talk to your agent naturally. Ask it to draft emails, look things up, manage your tasks, or anything else you need."
              tips={['Mention @skills to trigger automations', 'Use voice input with the mic button', 'The agent remembers your conversations']}
            />
          )}

          {/* Feature: Schedule */}
          {step === 'schedule' && (
            <FeatureStep
              icon={CalendarDays}
              color="green"
              title="Schedule"
              description="Your agent manages tasks, routines, and calendar events. It can create one-time tasks, recurring routines, and sync with Google Calendar."
              tips={['"Schedule a meeting prep for tomorrow at 2pm"', '"Every Monday morning, send me a weekly briefing"', 'Connect Google Calendar for two-way sync']}
            />
          )}

          {/* Feature: Queue */}
          {step === 'queue' && (
            <FeatureStep
              icon={Inbox}
              color="orange"
              title="Queue"
              description="When your agent wants to do something that needs your approval — like sending an email or making a change — it goes to the queue first."
              tips={['Review and approve or reject actions', 'Set autonomy level in Settings', '"Autonomous" mode skips the queue']}
            />
          )}

          {/* Feature: Skills */}
          {step === 'skills' && (
            <FeatureStep
              icon={Zap}
              color="purple"
              title="Skills"
              description="Reusable automations you can trigger anytime. Create your own or use the built-in ones."
              tips={['"@skill-creator make a daily briefing skill"', '"@integration-builder connect my CRM"', 'Skills chain multiple tools together']}
            />
          )}

          {/* Feature: Files */}
          {step === 'files' && (
            <FeatureStep
              icon={FolderOpen}
              color="amber"
              title="Files"
              description="Upload documents, contracts, and files for your agent to reference. It can search, summarize, fill PDFs, and create new documents."
              tips={['Drag and drop files to upload', 'Agent can generate branded PDFs', 'Search across all your files']}
            />
          )}

          {/* Feature: Integrations */}
          {step === 'integrations' && (
            <FeatureStep
              icon={Puzzle}
              color="indigo"
              title="Integrations"
              description="Connect your tools and services — Gmail, Slack, Google Calendar, iMessage, and more. Your agent can use them all."
              tips={['Click "Manage" in the sidebar to connect apps', 'Custom integrations for any API', 'iMessage and Contacts work on macOS']}
            />
          )}

          {/* Done */}
          {step === 'done' && (
            <div>
              <h2 className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
                You're ready{name ? `, ${name.split(' ')[0]}` : ''}!
              </h2>
              <p className="text-[13px] text-neutral-500 dark:text-neutral-400 mb-5">
                Start by chatting with your agent, or:
              </p>

              <div className="flex flex-col gap-2 mb-2">
                <TourAction
                  icon={Puzzle}
                  color="blue"
                  title="Connect your apps"
                  subtitle="Gmail, Slack, Calendar, and more"
                  onClick={() => finishAndGo(onOpenIntegrations)}
                />
                <TourAction
                  icon={CalendarDays}
                  color="green"
                  title="Set up your schedule"
                  subtitle="Active hours, routines, and calendar"
                  onClick={() => finishAndGo(() => onNavigate('calendar'))}
                />
                <TourAction
                  icon={Zap}
                  color="purple"
                  title="Customize your agent"
                  subtitle="Autonomy, brand, voice, and more"
                  onClick={() => finishAndGo(() => onNavigate('settings'))}
                />
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center gap-3 mt-6">
            {stepIndex > 0 && step !== 'done' && (
              <button onClick={back} className="flex items-center gap-1 text-[12.5px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors">
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            )}
            {step !== 'done' && (
              <button
                onClick={() => { onUpdate({ onboarded: true, name: name.trim(), what_you_do: whatYouDo.trim() }); }}
                className="text-[12.5px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
              >
                Skip tour
              </button>
            )}
            <button
              onClick={step === 'done' ? finish : next}
              className={cn(
                'ml-auto flex items-center gap-2 py-2 px-4 rounded-lg text-[13px] font-medium transition-opacity hover:opacity-90',
                'bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900'
              )}
            >
              {step === 'done' ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Start chatting
                </>
              ) : (
                <>
                  {step === 'welcome' ? 'Get started' : 'Next'}
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const COLOR_MAP: Record<string, { bg: string; icon: string }> = {
  blue: { bg: 'bg-blue-50 dark:bg-blue-950', icon: 'text-blue-600 dark:text-blue-400' },
  green: { bg: 'bg-emerald-50 dark:bg-emerald-950', icon: 'text-emerald-600 dark:text-emerald-400' },
  orange: { bg: 'bg-orange-50 dark:bg-orange-950', icon: 'text-orange-600 dark:text-orange-400' },
  purple: { bg: 'bg-purple-50 dark:bg-purple-950', icon: 'text-purple-600 dark:text-purple-400' },
  amber: { bg: 'bg-amber-50 dark:bg-amber-950', icon: 'text-amber-600 dark:text-amber-400' },
  indigo: { bg: 'bg-indigo-50 dark:bg-indigo-950', icon: 'text-indigo-600 dark:text-indigo-400' },
}

function FeatureStep({ icon: Icon, color, title, description, tips }: {
  icon: React.ElementType
  color: string
  title: string
  description: string
  tips: string[]
}) {
  const c = COLOR_MAP[color] || COLOR_MAP.blue
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', c.bg)}>
          <Icon className={cn('w-5 h-5', c.icon)} />
        </div>
        <h2 className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
      </div>
      <p className="text-[13px] text-neutral-500 dark:text-neutral-400 leading-relaxed mb-4">
        {description}
      </p>
      <div className="flex flex-col gap-2">
        {tips.map(tip => (
          <div key={tip} className="flex items-start gap-2.5 py-1.5 px-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-0.5">•</span>
            <span className="text-[12.5px] text-neutral-600 dark:text-neutral-400">{tip}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TourAction({ icon: Icon, color, title, subtitle, onClick }: {
  icon: React.ElementType
  color: string
  title: string
  subtitle: string
  onClick: () => void
}) {
  const c = COLOR_MAP[color] || COLOR_MAP.blue
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 p-3 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors text-left group"
    >
      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', c.bg)}>
        <Icon className={cn('w-4 h-4', c.icon)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">{title}</div>
        <div className="text-[11.5px] text-neutral-500 dark:text-neutral-400">{subtitle}</div>
      </div>
      <ArrowRight className="w-4 h-4 text-neutral-300 dark:text-neutral-600 group-hover:text-neutral-500 dark:group-hover:text-neutral-400 transition-colors" />
    </button>
  )
}
