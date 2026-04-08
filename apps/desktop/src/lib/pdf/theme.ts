// apps/desktop/src/lib/pdf/theme.ts
// Brand kit → react-pdf StyleSheet. react-pdf can't read CSS vars, so we
// bake brand colors into a typed palette that block components consume.

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

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some(n => Number.isNaN(n))) return `rgba(26, 39, 68, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface BrandInput {
  primary?: string
  secondary?: string
  tertiary?: string
}

export function buildBrandPalette(brand?: BrandInput): BrandPalette {
  const primary = brand?.primary || DEFAULT_PRIMARY
  const secondary = brand?.secondary || ''
  const tertiary = brand?.tertiary || ''
  const success = '#059669'
  const warning = '#d97706'
  const danger = '#dc2626'
  const neutral = '#6b7280'
  return {
    primary,
    primarySoft: hexToRgba(primary, 0.25),
    primaryBg: hexToRgba(primary, 0.05),
    secondary: secondary || primary,
    tertiary: tertiary || secondary || primary,
    success,
    warning,
    danger,
    neutral,
    chartPalette: [
      primary,
      secondary || primary,
      tertiary || secondary || primary,
      success,
      danger,
      neutral,
    ],
  }
}

// Semantic callout styles (brand-independent). Matches web renderer.
export const PDF_CALLOUT_STYLES = {
  info:    { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', icon: 'i' },
  warn:    { bg: '#fffbeb', border: '#fde68a', text: '#b45309', icon: '!' },
  success: { bg: '#ecfdf5', border: '#a7f3d0', text: '#047857', icon: '✓' },
  tip:     { bg: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9', icon: '◆' },
} as const
