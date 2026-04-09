// canvas-brand.ts — generates branded CSS for the markdown canvas iframe.

import type { AgentSettings } from '@coagent/shared'

export interface BrandValues {
  name: string
  logoUrl: string
  primary: string
  secondary: string
  tertiary: string
  fontHeading: string
  fontBody: string
}

export function brandFromSettings(settings: AgentSettings | null | undefined): BrandValues {
  return {
    name: settings?.brand_company || settings?.name || '',
    logoUrl: settings?.brand_logo || '',
    primary: settings?.brand_primary || '#1a2744',
    secondary: settings?.brand_secondary || '#6b7280',
    tertiary: settings?.brand_tertiary || '#e11d48',
    fontHeading: 'system-ui, -apple-system, sans-serif',
    fontBody: 'system-ui, -apple-system, sans-serif',
  }
}

export function buildBrandCSS(brand: BrandValues): string {
  return `
    html, body { margin: 0; padding: 0; background: white; }
    body {
      font-family: ${brand.fontBody};
      color: #1a1a1a;
      font-size: 15px;
      line-height: 1.7;
    }

    /* Container */
    .canvas-root {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px;
    }

    /* Logo header */
    .canvas-logo {
      margin-bottom: 32px;
    }
    .canvas-logo img {
      max-height: 48px;
      object-fit: contain;
    }
    .canvas-logo-text {
      font-family: ${brand.fontHeading};
      font-weight: 700;
      font-size: 20px;
      color: ${brand.primary};
    }

    /* Typography */
    h1, h2, h3, h4, h5, h6 {
      font-family: ${brand.fontHeading};
      color: ${brand.primary};
      font-weight: 600;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }
    h1 { font-size: 28px; }
    h2 { font-size: 22px; }
    h3 { font-size: 18px; }
    h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }

    p { margin: 0 0 1em; }

    strong { color: #111; }

    a { color: ${brand.primary}; text-decoration: underline; }

    blockquote {
      border-left: 3px solid ${brand.primary};
      margin: 1em 0;
      padding: 0.5em 1em;
      color: #555;
      background: #f9f9f9;
    }

    hr {
      border: none;
      border-top: 2px solid ${brand.primary};
      margin: 2em 0;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
      font-size: 14px;
    }
    thead th {
      background: ${brand.primary};
      color: white;
      text-align: left;
      padding: 8px 12px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    tbody td {
      padding: 8px 12px;
      border-bottom: 1px solid #eee;
    }
    tbody tr:last-child td { border-bottom: none; }

    /* Lists */
    ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
    li { margin-bottom: 0.3em; }

    /* Code */
    code {
      background: #f3f4f6;
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 13px;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }
    pre {
      background: #f3f4f6;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
    }
    pre code { background: none; padding: 0; }

    /* Mermaid */
    .mermaid { margin: 1.5em 0; text-align: center; }

    /* Print */
    @media print {
      html, body { background: white; }
      .canvas-root { padding: 0; max-width: none; }
    }
  `
}
