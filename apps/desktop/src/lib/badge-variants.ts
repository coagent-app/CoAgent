/**
 * Shared badge variant classes for approval item type labels.
 *
 * BADGE_VARIANTS and BADGE_VARIANTS_DARK are split objects used by components
 * that pass light and dark classes separately to `cn()`.
 *
 * BADGE_VARIANTS_COMBINED merges both into a single string per key and adds
 * extra type keys (task, message, request) used by QueueDrawer.
 */

export const BADGE_VARIANTS: Record<string, string> = {
  contract: 'bg-violet-50 text-violet-700 border-violet-100',
  analysis: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  cma:      'bg-amber-50 text-amber-700 border-amber-100',
  email:    'bg-sky-50 text-sky-700 border-sky-100',
  other:    'bg-neutral-100 text-neutral-600 border-neutral-200',
}

export const BADGE_VARIANTS_DARK: Record<string, string> = {
  contract: 'dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  analysis: 'dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  cma:      'dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  email:    'dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  other:    'dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700',
}

/** Combined light + dark classes, with additional keys used by QueueDrawer. */
export const BADGE_VARIANTS_COMBINED: Record<string, string> = {
  contract: 'bg-violet-50 text-violet-700 border-violet-100 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  analysis: 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  cma:      'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  email:    'bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  task:     'bg-violet-50 text-violet-700 border-violet-100 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800',
  message:  'bg-sky-50 text-sky-700 border-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800',
  request:  'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  other:    'bg-neutral-100 text-neutral-600 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700',
}
