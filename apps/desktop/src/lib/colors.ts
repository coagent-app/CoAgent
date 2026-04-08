// apps/desktop/src/lib/colors.ts
// Shared color utilities. Import from here rather than duplicating inline.

/**
 * Convert a CSS hex color (#rgb or #rrggbb) to an rgba() string.
 * On parse failure falls back to the brand default #1a2744.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some(n => Number.isNaN(n))) return `rgba(26, 39, 68, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
