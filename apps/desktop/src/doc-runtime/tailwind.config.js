/** @type {import('tailwindcss').Config} */
module.exports = {
  // No file scanning — we rely solely on safelist because the agent generates
  // HTML at runtime. The precompiled bundle covers every class the whitelist
  // regex allows.
  content: [],

  safelist: [
    // ── Semantic doc/section/editable classes ──────────────────────────
    'doc',
    'doc-page',
    'doc-header',
    'doc-body',
    'doc-footer',
    { pattern: /^sec(-[a-z]+)?$/ },
    { pattern: /^ed-[a-z]+(-[a-z]+)*$/ },

    // ── Layout ─────────────────────────────────────────────────────────
    { pattern: /^(block|inline(-block|-flex|-grid)?|flex|grid|hidden|contents|flow-root|table(-[a-z]+)?)$/ },
    { pattern: /^(flex|grid)-(row|col|row-reverse|col-reverse|1|auto|none|wrap|nowrap|wrap-reverse)$/ },
    { pattern: /^items-(start|end|center|baseline|stretch)$/ },
    { pattern: /^justify-(start|end|center|between|around|evenly|stretch|normal)$/ },
    { pattern: /^justify-items-(start|end|center|stretch)$/ },
    { pattern: /^content-(start|end|center|between|around|evenly|baseline|stretch|normal)$/ },
    { pattern: /^self-(auto|start|end|center|stretch|baseline)$/ },
    { pattern: /^place-(items|content|self)-(start|end|center|between|around|evenly|stretch|baseline)$/ },
    { pattern: /^(flex|grid)-(auto|none|\d+)$/ },
    { pattern: /^flex-(shrink|grow|auto|none|initial)$/ },
    { pattern: /^grow(-0)?$/ },
    { pattern: /^shrink(-0)?$/ },
    { pattern: /^basis-(auto|full|\d+\/\d+|\d+(px|rem|em|%)?|\[.+\])$/ },
    { pattern: /^grid-cols-\d+$/ },
    { pattern: /^grid-rows-\d+$/ },
    { pattern: /^col-(span|start|end)-\d+$/ },
    { pattern: /^row-(span|start|end)-\d+$/ },
    { pattern: /^order-(\d+|first|last|none)$/ },
    { pattern: /^gap-(\d+|px)$/ },
    { pattern: /^gap-(x|y)-(\d+|px)$/ },

    // ── Spacing ────────────────────────────────────────────────────────
    { pattern: /^(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr)-(\d+|auto|px)$/ },
    { pattern: /^space-(x|y)-(\d+|px|reverse)$/ },

    // ── Sizing ─────────────────────────────────────────────────────────
    { pattern: /^(w|h|min-w|min-h|max-w|max-h)-(auto|\d+|px|full|screen|min|max|fit|prose|\d+\/\d+)$/ },
    // Arbitrary value sizes like w-[816px] are handled via the doc-page component class above.
    { pattern: /^aspect-(auto|square|video)$/ },
    { pattern: /^object-(contain|cover|fill|none|scale-down)$/ },
    { pattern: /^object-(top|right|bottom|left|center)$/ },

    // ── Typography ─────────────────────────────────────────────────────
    { pattern: /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/ },
    { pattern: /^text-(left|center|right|justify|start|end)$/ },
    { pattern: /^text-(wrap|nowrap|balance|pretty)$/ },
    { pattern: /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/ },
    { pattern: /^font-(sans|serif|mono|display)$/ },
    { pattern: /^leading-(none|tight|snug|normal|relaxed|loose|\d+)$/ },
    { pattern: /^tracking-(tighter|tight|normal|wide|wider|widest)$/ },
    { pattern: /^(uppercase|lowercase|capitalize|normal-case)$/ },
    { pattern: /^(italic|not-italic)$/ },
    { pattern: /^(underline|overline|line-through|no-underline)$/ },
    { pattern: /^(truncate|text-ellipsis|text-clip)$/ },
    { pattern: /^(whitespace|break)-(normal|nowrap|pre|pre-line|pre-wrap|words|all|keep)$/ },
    { pattern: /^antialiased$/ },

    // ── Colors — text ──────────────────────────────────────────────────
    { pattern: /^text-(background|foreground|muted|muted-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|border)$/ },
    { pattern: /^text-(black|white|transparent|current|inherit)$/ },
    { pattern: /^text-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/ },

    // ── Colors — background ────────────────────────────────────────────
    { pattern: /^bg-(background|foreground|muted|muted-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|border)$/ },
    { pattern: /^bg-(black|white|transparent|current|inherit)$/ },
    { pattern: /^bg-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/ },

    // ── Colors — border ────────────────────────────────────────────────
    { pattern: /^border-(background|foreground|muted|muted-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|border)$/ },
    { pattern: /^border-(black|white|transparent|current|inherit)$/ },
    { pattern: /^border-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/ },

    // ── Borders ────────────────────────────────────────────────────────
    { pattern: /^border(-[trbl])?(-\d+)?$/ },
    { pattern: /^border-(solid|dashed|dotted|double|hidden|none)$/ },
    { pattern: /^divide-(x|y)(-\d+)?$/ },
    { pattern: /^divide-(solid|dashed|dotted|double|none)$/ },
    { pattern: /^outline(-\d+)?$/ },
    { pattern: /^outline-(solid|dashed|dotted|double|none)$/ },
    { pattern: /^ring(-\d+)?$/ },
    { pattern: /^ring-(inset|offset)$/ },
    { pattern: /^ring-offset-\d+$/ },

    // ── Rounded ────────────────────────────────────────────────────────
    { pattern: /^rounded(-[a-z]+)?(-[a-z]+)?$/ },

    // ── Shadows ────────────────────────────────────────────────────────
    { pattern: /^shadow(-[a-z]+)?$/ },

    // ── Position ───────────────────────────────────────────────────────
    { pattern: /^(static|fixed|absolute|relative|sticky)$/ },
    { pattern: /^(top|right|bottom|left|inset)(-[a-z0-9]+)?$/ },
    { pattern: /^z-(\d+|auto)$/ },

    // ── Overflow ───────────────────────────────────────────────────────
    { pattern: /^overflow(-[xy])?-(auto|hidden|clip|visible|scroll)$/ },

    // ── Opacity ────────────────────────────────────────────────────────
    { pattern: /^opacity-(\d+)$/ },

    // ── Interactivity ──────────────────────────────────────────────────
    { pattern: /^cursor-(auto|default|pointer|wait|text|move|help|not-allowed|none|context-menu|progress|cell|crosshair|vertical-text|alias|copy|no-drop|grab|grabbing|all-scroll|col-resize|row-resize|n-resize|e-resize|s-resize|w-resize|ne-resize|nw-resize|se-resize|sw-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|zoom-in|zoom-out)$/ },
    { pattern: /^(select|pointer-events)-(none|text|all|auto)$/ },

    // ── Transitions ────────────────────────────────────────────────────
    { pattern: /^transition(-[a-z]+)?$/ },
    { pattern: /^duration-(\d+)$/ },
    { pattern: /^ease-(linear|in|out|in-out)$/ },
    { pattern: /^delay-(\d+)$/ },
    { pattern: /^animate-(none|spin|ping|pulse|bounce)$/ },
  ],

  theme: {
    extend: {
      colors: {
        // shadcn-compatible CSS custom property mappings — the agent writes
        // bg-background, text-foreground, border-border etc. naturally because
        // these names match its training distribution on shadcn/ui codebases.
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        border: 'hsl(var(--border))',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-body)'],
      },
    },
  },

  plugins: [],
}
