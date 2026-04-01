import type { Autonomy, DayName } from '@coagent/shared'

export interface VerticalPreset {
  id: string
  appName: string
  bundleId: string
  defaultRole: string
  defaultAutonomy: Autonomy
  activeHours: { start: number; end: number }
  activeDays: DayName[]
  suggestedIntegrations: string[]
  onboardingHint: string  // helps the agent ask the right onboarding question
}

export const PRESETS: Record<string, VerticalPreset> = {
  personal: {
    id: 'personal',
    appName: 'CoAgent',
    bundleId: 'com.coagent.personal',
    defaultRole: '',
    defaultAutonomy: 'ask_first',
    activeHours: { start: 7, end: 24 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    suggestedIntegrations: ['gmail', 'googlecalendar', 'googledrive'],
    onboardingHint: 'Ask what they do for work and what they want help with.',
  },
  'real-estate': {
    id: 'real-estate',
    appName: 'CoAgent for Real Estate',
    bundleId: 'com.coagent.real-estate',
    defaultRole: 'Real Estate Agent',
    defaultAutonomy: 'balanced',
    activeHours: { start: 8, end: 19 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    suggestedIntegrations: ['gmail', 'googlecalendar', 'follow_up_boss', 'docusign', 'googledrive', 'calendly'],
    onboardingHint: 'Ask about their market, property types, and what part of the deal cycle they need the most help with.',
  },
  sales: {
    id: 'sales',
    appName: 'CoAgent for Sales',
    bundleId: 'com.coagent.sales',
    defaultRole: 'Sales Professional',
    defaultAutonomy: 'balanced',
    activeHours: { start: 8, end: 19 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    suggestedIntegrations: ['gmail', 'googlecalendar', 'hubspot', 'linkedin'],
    onboardingHint: 'Ask what they sell, their sales cycle, and where they lose the most time.',
  },
  ecommerce: {
    id: 'ecommerce',
    appName: 'CoAgent for E-commerce',
    bundleId: 'com.coagent.ecommerce',
    defaultRole: 'E-commerce Manager',
    defaultAutonomy: 'autonomous',
    activeHours: { start: 7, end: 24 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    suggestedIntegrations: ['gmail', 'shopify', 'stripe', 'slack', 'googlesheets'],
    onboardingHint: 'Ask about their store, product types, and biggest operational pain points.',
  },
  agency: {
    id: 'agency',
    appName: 'CoAgent for Agencies',
    bundleId: 'com.coagent.agency',
    defaultRole: 'Agency Professional',
    defaultAutonomy: 'ask_first',
    activeHours: { start: 9, end: 18 },
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    suggestedIntegrations: ['gmail', 'slack', 'googledrive', 'notion'],
    onboardingHint: 'Ask about their clients, what kind of work they deliver, and how they track projects.',
  },
}

export function getPreset(vertical?: string): VerticalPreset {
  return PRESETS[vertical || 'personal'] || PRESETS.personal
}
