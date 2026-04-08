// apps/desktop/src/lib/pdf/theme.ts
// Brand kit → react-pdf StyleSheet. react-pdf can't read CSS vars, so we
// bake brand colors into a typed palette that block components consume.

import { hexToRgba } from '../colors'

export interface BrandPalette {
  primary: string
  primarySoft: string    // primary @ 0.25
  primaryBg: string      // primary @ 0.05
  secondary: string
  tertiary: string
  success: string
  warning: string
  danger: string
  neutral: string
  chartPalette: string[] // ordered cycle for multi-series charts
}

const DEFAULT_PRIMARY = '#1a2744'

export interface BrandInput {
  primary?: string
  secondary?: string
  tertiary?: string
}

const isSet = (c?: string) => typeof c === 'string' && c.trim() !== ''

export function buildBrandPalette(brand?: BrandInput): BrandPalette {
  const primary = brand?.primary || DEFAULT_PRIMARY
  const secondary = brand?.secondary || ''
  const tertiary = brand?.tertiary || ''
  const success = '#059669'
  const warning = '#d97706'
  const danger = '#dc2626'
  const neutral = '#6b7280'

  // Chart palette skips unset user colors so a primary-only brand doesn't
  // render bars 2 and 3 in the same color as bar 1.
  const chartPalette: string[] = [primary]
  if (isSet(secondary)) chartPalette.push(secondary)
  if (isSet(tertiary)) chartPalette.push(tertiary)
  chartPalette.push(success, danger, neutral)

  return {
    primary,
    primarySoft: hexToRgba(primary, 0.25),
    primaryBg: hexToRgba(primary, 0.05),
    // Individual palette slots keep their fallback behavior — non-chart blocks
    // (KPI borders, header eyebrow, callouts) need a real color value.
    secondary: secondary || primary,
    tertiary: tertiary || secondary || primary,
    success,
    warning,
    danger,
    neutral,
    chartPalette,
  }
}

// Semantic callout styles (brand-independent). Matches web renderer.
export const PDF_CALLOUT_STYLES = {
  info:    { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', icon: 'i' },
  warn:    { bg: '#fffbeb', border: '#fde68a', text: '#b45309', icon: '!' },
  success: { bg: '#ecfdf5', border: '#a7f3d0', text: '#047857', icon: '+' },
  tip:     { bg: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9', icon: '*' },
} as const
