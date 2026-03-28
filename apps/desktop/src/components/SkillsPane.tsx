import React, { useState } from 'react'
import { Zap, ChevronRight, Pencil, Trash2, X, Check, Wand2, Puzzle, MessageSquare } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface Skill {
  name: string
  description: string
  instructions: string
  builtin?: boolean
}

interface SkillsPaneProps {
  skills: Skill[]
  onUpdate: (name: string, description: string, instructions: string) => void
  onDelete: (name: string) => void
}

const BUILTIN_DETAILS: Record<string, { tagline: string; features: string[]; usage: string; examples?: string[] }> = {
  'skill-creator': {
    tagline: 'Build custom automations that your agent can run on demand',
    features: [
      'Walks you through designing a skill step by step',
      'Generates tool-specific instructions automatically',
      'Saves the skill so you can invoke it anytime with @name',
    ],
    usage: 'Type @skill-creator in chat to start building',
    examples: [
      'Daily briefing — calendar, emails, Slack, and to-dos at a glance',
      'Follow-up — draft a follow-up email based on recent context',
      'Client recap — summarize all activity with a client over the last 7 days',
      'Weekly recap — summarize the week with loose ends highlighted',
      'Schedule meeting — check availability, suggest slots, draft invite',
    ],
  },
  'integration-builder': {
    tagline: 'Connect any API as a custom integration — no code required',
    features: [
      'Researches the API documentation for you',
      'Proposes capabilities based on what the API can do',
      'Generates and installs an MCP server automatically',
      'Handles authentication setup and credential management',
      'Can iterate and fix tools if something breaks',
    ],
    usage: 'Type @integration-builder in chat to start connecting',
  },
}

export function SkillsPane({ skills, onUpdate, onDelete }: SkillsPaneProps) {
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [editInstructions, setEditInstructions] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const builtinSkills = skills.filter(s => s.builtin)
  const customSkills = skills.filter(s => !s.builtin)
  const selected = skills.find(s => s.name === selectedSkill)

  function handleSelect(name: string) {
    setSelectedSkill(name)
    setEditing(false)
    setConfirmDelete(null)
  }

  function handleEdit() {
    if (!selected) return
    setEditDescription(selected.description)
    setEditInstructions(selected.instructions)
    setEditing(true)
  }

  function handleSave() {
    if (!selected) return
    onUpdate(selected.name, editDescription, editInstructions)
    setEditing(false)
  }

  function handleCancel() {
    setEditing(false)
  }

  function handleDelete(name: string) {
    onDelete(name)
    setConfirmDelete(null)
    if (selectedSkill === name) setSelectedSkill(null)
  }

  function renderSkillItem(skill: Skill) {
    return (
      <button
        key={skill.name}
        onClick={() => handleSelect(skill.name)}
        className={cn(
          'flex items-start gap-3 w-full px-3.5 py-3 rounded-lg text-left transition-colors group',
          selectedSkill === skill.name
            ? 'bg-neutral-100 dark:bg-neutral-800'
            : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
        )}
      >
        <Zap size={15} className={cn(
          'flex-shrink-0 mt-0.5',
          selectedSkill === skill.name
            ? 'text-neutral-700 dark:text-neutral-300'
            : 'text-neutral-400 dark:text-neutral-500'
        )} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className={cn(
              'text-[13px] font-medium',
              selectedSkill === skill.name
                ? 'text-neutral-900 dark:text-neutral-100'
                : 'text-neutral-700 dark:text-neutral-300'
            )}>
              {skill.name}
            </p>
            {skill.builtin && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500">
                Built-in
              </span>
            )}
          </div>
          <p className="text-[12px] text-neutral-400 dark:text-neutral-500 mt-0.5 leading-snug">
            {skill.description}
          </p>
        </div>
        <ChevronRight size={14} className="flex-shrink-0 mt-1 text-neutral-300 dark:text-neutral-600" />
      </button>
    )
  }

  function renderBuiltinDetail(skill: Skill) {
    const details = BUILTIN_DETAILS[skill.name]
    if (!details) {
      return (
        <p className="text-[13px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
          {skill.description}
        </p>
      )
    }

    return (
      <div className="flex flex-col gap-6">
        <p className="text-[13.5px] text-neutral-600 dark:text-neutral-300 leading-relaxed">
          {details.tagline}
        </p>

        <div>
          <p className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2.5">
            What it does
          </p>
          <div className="flex flex-col gap-2">
            {details.features.map((f, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <div className="w-1.5 h-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600 mt-[7px] flex-shrink-0" />
                <p className="text-[13px] text-neutral-600 dark:text-neutral-400 leading-snug">{f}</p>
              </div>
            ))}
          </div>
        </div>

        {details.examples && (
          <div>
            <p className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-2.5">
              Example skills to create
            </p>
            <div className="flex flex-col gap-1.5">
              {details.examples.map((ex, i) => {
                const [name, ...rest] = ex.split(' — ')
                return (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600 mt-[7px] flex-shrink-0" />
                    <p className="text-[13px] text-neutral-600 dark:text-neutral-400 leading-snug">
                      <span className="font-medium text-neutral-700 dark:text-neutral-300">{name}</span>
                      {rest.length > 0 && ` — ${rest.join(' — ')}`}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="px-3.5 py-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 border border-neutral-100 dark:border-neutral-700/50">
          <p className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">
            How to use
          </p>
          <p className="text-[13px] text-neutral-600 dark:text-neutral-300 font-medium">
            {details.usage}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Skill list */}
      <div className="w-[340px] border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">Skills</h2>
          <p className="text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5">
            Your agent's playbooks. Say @name in chat to use one.
          </p>
        </div>
        <ScrollArea className="flex-1">
          <div className="px-3 pb-3 flex flex-col gap-1">
            {skills.length === 0 && (
              <div className="px-3 py-8 text-center">
                <Zap size={24} className="mx-auto mb-2 text-neutral-300 dark:text-neutral-600" />
                <p className="text-[13px] text-neutral-400 dark:text-neutral-500">No skills yet</p>
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-1">
                  Ask your agent to create one in chat
                </p>
              </div>
            )}
            {builtinSkills.map(renderSkillItem)}
            {builtinSkills.length > 0 && customSkills.length > 0 && (
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
                <span className="text-[10px] font-medium text-neutral-400 dark:text-neutral-500 uppercase tracking-widest">Custom</span>
                <div className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
              </div>
            )}
            {customSkills.map(renderSkillItem)}
          </div>
        </ScrollArea>
      </div>

      {/* Detail / editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Zap size={32} className="mx-auto mb-3 text-neutral-200 dark:text-neutral-700" />
              <p className="text-[13px] text-neutral-400 dark:text-neutral-500">Select a skill to view or edit</p>
            </div>
          </div>
        ) : editing ? (
          /* Edit mode */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800">
              <div>
                <h3 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
                  Editing: {selected.name}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  <X size={13} />
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 transition-colors"
                >
                  <Check size={13} />
                  Save
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
                  Description
                </label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={e => setEditDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                />
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <label className="block text-[12px] font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
                  Instructions
                </label>
                <textarea
                  value={editInstructions}
                  onChange={e => setEditInstructions(e.target.value)}
                  className="flex-1 min-h-[200px] px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-[13px] text-neutral-900 dark:text-neutral-100 font-mono leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-600"
                />
              </div>
            </div>
          </div>
        ) : (
          /* View mode */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800">
              <div>
                <h3 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
                  {selected.name}
                </h3>
                {!selected.builtin && (
                  <p className="text-[12px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                    {selected.description}
                  </p>
                )}
              </div>
              {!selected.builtin && (
              <div className="flex items-center gap-2">
                {confirmDelete === selected.name ? (
                  <>
                    <span className="text-[12px] text-red-500 mr-1">Delete?</span>
                    <button
                      onClick={() => handleDelete(selected.name)}
                      className="px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="px-2.5 py-1.5 rounded-md text-[12px] font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                    >
                      No
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleEdit}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                    >
                      <Pencil size={13} />
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmDelete(selected.name)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-neutral-500 hover:text-red-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
              )}
            </div>
            <ScrollArea className="flex-1">
              <div className="px-6 py-4">
                {selected.builtin ? renderBuiltinDetail(selected) : (
                  <>
                    <p className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-3">
                      Instructions
                    </p>
                    <pre className="text-[13px] text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap font-mono leading-relaxed">
                      {selected.instructions}
                    </pre>
                  </>
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  )
}
