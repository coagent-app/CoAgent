// apps/desktop/src/components/DocumentEditor.tsx
import React, { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface DocumentEditorProps {
  document: { fileId: string; template: string; data: any }
  onSave: (fileId: string, data: any) => void
  onClose: () => void
}

interface ExperienceEntry {
  company: string
  role: string
  dates: string
  bullets: string
}

interface SkillGroup {
  category: string
  items: string
}

interface EducationEntry {
  school: string
  degree: string
  dates: string
}

interface ResumeFormState {
  name: string
  email: string
  phone: string
  location: string
  linkedin: string
  website: string
  summary: string
  experience: ExperienceEntry[]
  skills: SkillGroup[]
  education: EducationEntry[]
  certifications: string
}

// ── Constants ────────────────────────────────────────────────────────────────

const TEMPLATE_LABELS: Record<string, string> = {
  resume: 'Resume',
  cover_letter: 'Cover Letter',
  proposal: 'Proposal',
  invoice: 'Invoice',
  report: 'Report',
}

const TOTAL_RESUME_SECTIONS = 6

// ── Shared input/label styles ────────────────────────────────────────────────

const inputCls =
  'w-full px-2.5 py-1.5 text-[12.5px] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 placeholder:text-neutral-400 dark:placeholder:text-neutral-500'

const labelCls =
  'text-[11px] font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide'

// ── Small UI helpers ─────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <p className={labelCls}>{children}</p>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function SectionDivider({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <p className="text-[11.5px] font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wide whitespace-nowrap">
        {title}
      </p>
      <div className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
    </div>
  )
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11.5px] font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors border border-dashed border-neutral-300 dark:border-neutral-600 rounded-lg px-3 py-1.5 w-full"
    >
      + {label}
    </button>
  )
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors px-2 py-0.5 rounded"
    >
      Remove
    </button>
  )
}

// ── Stagger wrapper ──────────────────────────────────────────────────────────

function StaggerSection({
  index,
  visibleCount,
  children,
}: {
  index: number
  visibleCount: number
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'transition-all duration-300',
        visibleCount >= index ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
      )}
    >
      {children}
    </div>
  )
}

// ── Resume form initialiser ──────────────────────────────────────────────────

function initResumeState(data: any): ResumeFormState {
  const experience: ExperienceEntry[] =
    Array.isArray(data?.experience) && data.experience.length > 0
      ? data.experience.map((e: any) => ({
          company: e.company ?? '',
          role: e.role ?? '',
          dates: e.dates ?? '',
          bullets: Array.isArray(e.bullets) ? e.bullets.join('\n') : (e.bullets ?? ''),
        }))
      : [{ company: '', role: '', dates: '', bullets: '' }]

  const skills: SkillGroup[] =
    Array.isArray(data?.skills) && data.skills.length > 0
      ? data.skills.map((s: any) => ({
          category: s.category ?? '',
          items: Array.isArray(s.items) ? s.items.join(', ') : (s.items ?? ''),
        }))
      : [{ category: '', items: '' }]

  const education: EducationEntry[] =
    Array.isArray(data?.education) && data.education.length > 0
      ? data.education.map((e: any) => ({
          school: e.school ?? '',
          degree: e.degree ?? '',
          dates: e.dates ?? '',
        }))
      : [{ school: '', degree: '', dates: '' }]

  return {
    name: data?.name ?? '',
    email: data?.contact?.email ?? data?.email ?? '',
    phone: data?.contact?.phone ?? data?.phone ?? '',
    location: data?.contact?.location ?? data?.location ?? '',
    linkedin: data?.contact?.linkedin ?? data?.linkedin ?? '',
    website: data?.contact?.website ?? data?.website ?? '',
    summary: data?.summary ?? '',
    experience,
    skills,
    education,
    certifications: Array.isArray(data?.certifications)
      ? data.certifications.join('\n')
      : (data?.certifications ?? ''),
  }
}

function buildResumeData(form: ResumeFormState): any {
  return {
    name: form.name,
    contact: {
      email: form.email,
      phone: form.phone,
      location: form.location,
      linkedin: form.linkedin,
      website: form.website,
    },
    summary: form.summary,
    experience: form.experience.map(e => ({
      company: e.company,
      role: e.role,
      dates: e.dates,
      bullets: e.bullets
        .split('\n')
        .map(b => b.trim())
        .filter(Boolean),
    })),
    skills: form.skills.map(s => ({
      category: s.category,
      items: s.items
        .split(',')
        .map(i => i.trim())
        .filter(Boolean),
    })),
    education: form.education.map(e => ({
      school: e.school,
      degree: e.degree,
      dates: e.dates,
    })),
    certifications: form.certifications
      .split('\n')
      .map(c => c.trim())
      .filter(Boolean),
  }
}

// ── Resume form ──────────────────────────────────────────────────────────────

function ResumeForm({
  initialData,
  visibleCount,
  onFormChange,
}: {
  initialData: any
  visibleCount: number
  onFormChange: (getter: () => any) => void
}) {
  const [form, setForm] = useState<ResumeFormState>(() => initResumeState(initialData))

  // Expose a getter so the parent can collect data without prop drilling
  useEffect(() => {
    onFormChange(() => buildResumeData(form))
  }, [form, onFormChange])

  function updateField<K extends keyof ResumeFormState>(key: K, value: ResumeFormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // Experience helpers
  function updateExperience(index: number, patch: Partial<ExperienceEntry>) {
    setForm(prev => {
      const next = [...prev.experience]
      next[index] = { ...next[index], ...patch }
      return { ...prev, experience: next }
    })
  }
  function addExperience() {
    setForm(prev => ({
      ...prev,
      experience: [...prev.experience, { company: '', role: '', dates: '', bullets: '' }],
    }))
  }
  function removeExperience(index: number) {
    setForm(prev => ({
      ...prev,
      experience: prev.experience.filter((_, i) => i !== index),
    }))
  }

  // Skills helpers
  function updateSkill(index: number, patch: Partial<SkillGroup>) {
    setForm(prev => {
      const next = [...prev.skills]
      next[index] = { ...next[index], ...patch }
      return { ...prev, skills: next }
    })
  }
  function addSkill() {
    setForm(prev => ({
      ...prev,
      skills: [...prev.skills, { category: '', items: '' }],
    }))
  }
  function removeSkill(index: number) {
    setForm(prev => ({
      ...prev,
      skills: prev.skills.filter((_, i) => i !== index),
    }))
  }

  // Education helpers
  function updateEducation(index: number, patch: Partial<EducationEntry>) {
    setForm(prev => {
      const next = [...prev.education]
      next[index] = { ...next[index], ...patch }
      return { ...prev, education: next }
    })
  }
  function addEducation() {
    setForm(prev => ({
      ...prev,
      education: [...prev.education, { school: '', degree: '', dates: '' }],
    }))
  }
  function removeEducation(index: number) {
    setForm(prev => ({
      ...prev,
      education: prev.education.filter((_, i) => i !== index),
    }))
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Section 1 — Name */}
      <StaggerSection index={1} visibleCount={visibleCount}>
        <Field label="Full name">
          <input
            className={inputCls}
            placeholder="Jane Smith"
            value={form.name}
            onChange={e => updateField('name', e.target.value)}
          />
        </Field>
      </StaggerSection>

      {/* Section 2 — Contact */}
      <StaggerSection index={2} visibleCount={visibleCount}>
        <div className="flex flex-col gap-2.5">
          <SectionDivider title="Contact" />
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Email">
              <input
                className={inputCls}
                placeholder="jane@example.com"
                value={form.email}
                onChange={e => updateField('email', e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                className={inputCls}
                placeholder="+1 555 000 0000"
                value={form.phone}
                onChange={e => updateField('phone', e.target.value)}
              />
            </Field>
            <Field label="Location">
              <input
                className={inputCls}
                placeholder="San Francisco, CA"
                value={form.location}
                onChange={e => updateField('location', e.target.value)}
              />
            </Field>
            <Field label="LinkedIn">
              <input
                className={inputCls}
                placeholder="linkedin.com/in/jane"
                value={form.linkedin}
                onChange={e => updateField('linkedin', e.target.value)}
              />
            </Field>
            <div className="col-span-2">
              <Field label="Website">
                <input
                  className={inputCls}
                  placeholder="https://jane.dev"
                  value={form.website}
                  onChange={e => updateField('website', e.target.value)}
                />
              </Field>
            </div>
          </div>
        </div>
      </StaggerSection>

      {/* Section 3 — Summary */}
      <StaggerSection index={3} visibleCount={visibleCount}>
        <div className="flex flex-col gap-2.5">
          <SectionDivider title="Summary" />
          <Field label="Professional summary">
            <textarea
              className={cn(inputCls, 'resize-y')}
              rows={3}
              placeholder="Results-driven engineer with 8 years of experience..."
              value={form.summary}
              onChange={e => updateField('summary', e.target.value)}
            />
          </Field>
        </div>
      </StaggerSection>

      {/* Section 4 — Experience */}
      <StaggerSection index={4} visibleCount={visibleCount}>
        <div className="flex flex-col gap-3">
          <SectionDivider title="Experience" />
          {form.experience.map((entry, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-2.5 pl-3 border-l-2 border-neutral-200 dark:border-neutral-700"
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Company">
                  <input
                    className={inputCls}
                    placeholder="Acme Corp"
                    value={entry.company}
                    onChange={e => updateExperience(idx, { company: e.target.value })}
                  />
                </Field>
                <Field label="Role">
                  <input
                    className={inputCls}
                    placeholder="Senior Engineer"
                    value={entry.role}
                    onChange={e => updateExperience(idx, { role: e.target.value })}
                  />
                </Field>
                <Field label="Dates">
                  <input
                    className={inputCls}
                    placeholder="Jan 2021 – Present"
                    value={entry.dates}
                    onChange={e => updateExperience(idx, { dates: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Bullets (one per line)">
                <textarea
                  className={cn(inputCls, 'resize-y')}
                  rows={3}
                  placeholder="Led migration to microservices, reducing latency by 40%"
                  value={entry.bullets}
                  onChange={e => updateExperience(idx, { bullets: e.target.value })}
                />
              </Field>
              {form.experience.length > 1 && (
                <div className="flex justify-end">
                  <RemoveButton onClick={() => removeExperience(idx)} />
                </div>
              )}
            </div>
          ))}
          <AddButton onClick={addExperience} label="Add experience" />
        </div>
      </StaggerSection>

      {/* Section 5 — Skills */}
      <StaggerSection index={5} visibleCount={visibleCount}>
        <div className="flex flex-col gap-3">
          <SectionDivider title="Skills" />
          {form.skills.map((group, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-2.5 pl-3 border-l-2 border-neutral-200 dark:border-neutral-700"
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Category">
                  <input
                    className={inputCls}
                    placeholder="Languages"
                    value={group.category}
                    onChange={e => updateSkill(idx, { category: e.target.value })}
                  />
                </Field>
                <Field label="Items (comma-separated)">
                  <input
                    className={inputCls}
                    placeholder="TypeScript, Rust, Go"
                    value={group.items}
                    onChange={e => updateSkill(idx, { items: e.target.value })}
                  />
                </Field>
              </div>
              {form.skills.length > 1 && (
                <div className="flex justify-end">
                  <RemoveButton onClick={() => removeSkill(idx)} />
                </div>
              )}
            </div>
          ))}
          <AddButton onClick={addSkill} label="Add skill group" />
        </div>
      </StaggerSection>

      {/* Section 6 — Education + Certifications */}
      <StaggerSection index={6} visibleCount={visibleCount}>
        <div className="flex flex-col gap-3">
          <SectionDivider title="Education" />
          {form.education.map((entry, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-2.5 pl-3 border-l-2 border-neutral-200 dark:border-neutral-700"
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="School">
                  <input
                    className={inputCls}
                    placeholder="MIT"
                    value={entry.school}
                    onChange={e => updateEducation(idx, { school: e.target.value })}
                  />
                </Field>
                <Field label="Degree">
                  <input
                    className={inputCls}
                    placeholder="B.S. Computer Science"
                    value={entry.degree}
                    onChange={e => updateEducation(idx, { degree: e.target.value })}
                  />
                </Field>
                <Field label="Dates">
                  <input
                    className={inputCls}
                    placeholder="2015 – 2019"
                    value={entry.dates}
                    onChange={e => updateEducation(idx, { dates: e.target.value })}
                  />
                </Field>
              </div>
              {form.education.length > 1 && (
                <div className="flex justify-end">
                  <RemoveButton onClick={() => removeEducation(idx)} />
                </div>
              )}
            </div>
          ))}
          <AddButton onClick={addEducation} label="Add education" />

          <div className="mt-1 flex flex-col gap-2.5">
            <SectionDivider title="Certifications" />
            <Field label="Certifications (one per line)">
              <textarea
                className={cn(inputCls, 'resize-y')}
                rows={2}
                placeholder="AWS Certified Solutions Architect"
                value={form.certifications}
                onChange={e => updateField('certifications', e.target.value)}
              />
            </Field>
          </div>
        </div>
      </StaggerSection>
    </div>
  )
}

// ── JSON fallback editor ─────────────────────────────────────────────────────

function JsonEditor({
  initialData,
  onFormChange,
}: {
  initialData: any
  onFormChange: (getter: () => any) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(initialData, null, 2))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onFormChange(() => {
      try {
        return JSON.parse(text)
      } catch {
        return initialData
      }
    })
  }, [text, onFormChange, initialData])

  function handleChange(value: string) {
    setText(value)
    try {
      JSON.parse(value)
      setError(null)
    } catch (e) {
      setError('Invalid JSON')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">
        Form editor coming soon for this template type. Edit raw JSON below.
      </p>
      <textarea
        className={cn(
          inputCls,
          'font-mono resize-y leading-relaxed',
          error && 'border-red-400 dark:border-red-600 focus:ring-red-400',
        )}
        rows={20}
        value={text}
        onChange={e => handleChange(e.target.value)}
        spellCheck={false}
      />
      {error && (
        <p className="text-[11px] text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function DocumentEditor({ document, onSave, onClose }: DocumentEditorProps) {
  const isBuilding = document.fileId === '__building__'
  const templateKey = document.template?.toLowerCase() ?? ''
  const templateLabel = TEMPLATE_LABELS[templateKey] ?? document.template ?? 'Document'
  const isResume = templateKey === 'resume'

  const [visibleCount, setVisibleCount] = useState(0)

  // Staggered reveal — reset when document changes
  useEffect(() => {
    setVisibleCount(0)
    let i = 0
    const timer = setInterval(() => {
      i++
      setVisibleCount(i)
      if (i >= TOTAL_RESUME_SECTIONS) clearInterval(timer)
    }, 150)
    return () => clearInterval(timer)
  }, [document.fileId])

  // Stable getter ref so the save handler always reads the latest form data
  const formGetterRef = React.useRef<(() => any) | null>(null)

  const handleFormChange = useCallback((getter: () => any) => {
    formGetterRef.current = getter
  }, [])

  function handleSave() {
    if (isBuilding) return
    const data = formGetterRef.current ? formGetterRef.current() : document.data
    onSave(document.fileId, data)
  }

  return (
    <div
      className={cn(
        // Panel chrome
        'flex flex-col w-[420px] flex-shrink-0 h-full',
        'border-l border-neutral-200 dark:border-neutral-800',
        'bg-white dark:bg-neutral-950',
        // Slide in from right
        'animate-in slide-in-from-right-4 duration-300',
      )}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex-shrink-0">
        {/* Template badge */}
        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 uppercase tracking-wide">
          {templateLabel}
        </span>

        <div className="flex-1" />

        {isBuilding && (
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500 italic mr-1">
            Building...
          </span>
        )}

        {/* Save */}
        <button
          type="button"
          onClick={handleSave}
          disabled={isBuilding}
          className={cn(
            'px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
            !isBuilding
              ? 'bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200'
              : 'bg-neutral-200 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-600 cursor-not-allowed',
          )}
        >
          Save
        </button>

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* ── Form body ── */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-4 flex flex-col gap-1">
          {isResume ? (
            <ResumeForm
              initialData={document.data}
              visibleCount={visibleCount}
              onFormChange={handleFormChange}
            />
          ) : (
            <JsonEditor
              initialData={document.data}
              onFormChange={handleFormChange}
            />
          )}
          <div className="h-6" />
        </div>
      </ScrollArea>
    </div>
  )
}
