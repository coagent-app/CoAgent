import React from 'react'
import { cn } from '@/lib/utils'

interface Step {
  tool: string
  label: string
  done: boolean
}

interface ActivityTrayProps {
  steps: Step[]
}

export function ActivityTray({ steps }: ActivityTrayProps) {
  if (steps.length === 0) return null

  return (
    <div className="flex justify-start">
      <div className="ml-1 flex flex-col">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1
          const isActive = !step.done

          return (
            <div key={i} className="flex items-start">
              {/* L-connector */}
              <div className="flex flex-col items-center w-4 flex-shrink-0 mr-1.5">
                {/* Vertical line segment coming from above */}
                <div className="w-px bg-neutral-200 flex-shrink-0" style={{ height: '10px' }} />
                {/* Horizontal leg of the L */}
                <div className="flex items-center w-full">
                  <div className="w-px bg-neutral-200" style={{ height: '6px' }} />
                  <div className="h-px bg-neutral-200 flex-1" />
                </div>
                {/* Vertical continuation downward (unless last) */}
                {!isLast && (
                  <div className="w-px bg-neutral-200 flex-1 min-h-[6px]" />
                )}
              </div>

              {/* Step label */}
              <div className={cn(
                'flex items-center gap-1.5 pb-1.5 text-[11.5px] leading-tight',
                step.done ? 'text-neutral-400' : 'text-neutral-600'
              )}>
                {isActive && (
                  <span className="w-1 h-1 rounded-full bg-blue-400 animate-pulse flex-shrink-0 mt-0.5" />
                )}
                {step.done && (
                  <span className="text-emerald-500 text-[10px] flex-shrink-0 mt-0.5">✓</span>
                )}
                <span className={cn(isActive && 'font-medium')}>
                  {step.label}{isActive ? '…' : ''}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
