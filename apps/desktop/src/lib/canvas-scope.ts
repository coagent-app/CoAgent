// canvas-scope — builds the react-runner scope passed to every Canvas render.
//
// The agent writes TSX that imports from:
//   - '@brand'       → { brand, Logo, Signature }
//   - 'recharts'     → full recharts surface
//   - 'lucide-react' → all icons
//   - 'react'        → React + hooks
//
// react-runner resolves those names via scope.import (see its docs). Every
// imported module must carry __esModule: true so `import X from 'y'` and
// `import { X } from 'y'` both work.
//
// IMPORTANT: the caller must memoize the return value of buildCanvasScope.
// Passing a new scope object on every render causes useRunner to recompile
// on every tick, which stomps on streaming renders and thrashes Sucrase.

import React from 'react'
import * as Recharts from 'recharts'
import * as Lucide from 'lucide-react'
import type { Scope } from 'react-runner'
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

/**
 * Build the scope object passed to useRunner. Call this once per brand
 * value set and memoize the result — changing the scope identity forces
 * a full recompile.
 */
export function buildCanvasScope(brand: BrandValues): Scope {
  const Logo: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = (props) => {
    if (!brand.logoUrl) {
      return React.createElement(
        'div',
        {
          style: {
            fontWeight: 700,
            color: brand.primary,
            fontFamily: brand.fontHeading,
            fontSize: 20,
            ...(props.style || {}),
          },
          className: props.className,
        },
        brand.name,
      )
    }
    return React.createElement('img', {
      src: brand.logoUrl,
      alt: brand.name || 'logo',
      ...props,
      style: { maxHeight: 48, objectFit: 'contain', ...(props.style || {}) },
    })
  }

  const Signature: React.FC<{ className?: string; style?: React.CSSProperties }> = ({
    className,
    style,
  }) =>
    React.createElement(
      'div',
      {
        className,
        style: {
          fontFamily: brand.fontHeading,
          color: brand.primary,
          fontWeight: 600,
          ...style,
        },
      },
      brand.name,
    )

  const brandModule = {
    brand,
    Logo,
    Signature,
    useBrand: () => brand,
    __esModule: true,
  }

  return {
    // top-level React (for JSX runtime inside the compiled code)
    React,
    // named import resolver
    import: {
      react: { ...React, default: React, __esModule: true },
      '@brand': brandModule,
      brand: brandModule, // tolerate `import ... from 'brand'`
      recharts: { ...Recharts, __esModule: true },
      'lucide-react': { ...Lucide, __esModule: true },
    },
  }
}
