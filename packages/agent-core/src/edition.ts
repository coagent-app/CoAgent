import { getPreset, type VerticalPreset } from './presets.js'

export type { VerticalPreset }
export { getPreset, PRESETS } from './presets.js'

let _edition: { vertical: string; team: boolean; preset: VerticalPreset } | null = null

export function getEdition() {
  if (!_edition) {
    const vertical = process.env.COAGENT_VERTICAL || 'personal'
    const team = process.env.COAGENT_TEAM === 'true'
    const preset = getPreset(vertical)
    _edition = { vertical, team, preset }
  }
  return _edition
}
