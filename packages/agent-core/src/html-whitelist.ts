// Server-side HTML whitelist for the HTML document architecture.
// Validates agent-generated HTML before it is persisted to disk.
// Uses node-html-parser (no DOM, lightweight) for structural parsing.
//
// This is a correctness net, not a full XSS sanitizer — the HTML renders
// only in our own sandboxed iframe. The goal is to reject malformed or
// out-of-vocabulary HTML early so the agent gets a structured error it
// can self-correct from.
//
// See docs/plans/2026-04-08-html-document-architecture.md — "Server-side whitelist"

import { parse, HTMLElement, TextNode } from 'node-html-parser'

// ── Allowed tag set ────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'span', 'strong', 'em',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img', 'figure', 'figcaption',
  'blockquote',
  'hr', 'br',
  'a',
])

// ── Allowed class regex ────────────────────────────────────────────────────
// Covers: doc/sec-*/ed-* vocabulary + Tailwind utility categories from the
// plan's whitelist regex.

const ALLOWED_CLASS_RE =
  /^(doc(-page|-header|-body|-footer)?|sec(-[a-z]+)?|ed-[a-z]+(-[a-z]+)*|grid|flex|gap-|p-|m-|px-|py-|mx-|my-|mt-|mb-|ml-|mr-|pt-|pb-|pl-|pr-|text-|bg-|border|rounded|font-|leading-|tracking-|w-|h-|max-w-|min-h-|items-|justify-|content-|self-|place-|col-|row-|aspect-|object-|opacity-|shadow|ring-|space-|divide-|order-|hidden|block|inline|flex-|grid-|relative|absolute|sticky|top-|left-|right-|bottom-|z-|overflow-|break-|whitespace-|truncate|uppercase|lowercase|capitalize|italic|underline|no-underline|cursor-|select-|pointer-events-|transition|duration-|ease-|delay-|animate-|grow|shrink|basis-|static|fixed|contents|antialiased|not-italic|overline|line-through|normal-case)/

// ── Allowed attributes ─────────────────────────────────────────────────────

const ALLOWED_ATTRS = new Set([
  'class', 'id', 'src', 'alt', 'href', 'colspan', 'rowspan', 'data-editable',
])

// Attributes that start with "on" are event handlers — always rejected.
const EVENT_ATTR_RE = /^on/i

// ── Result types ───────────────────────────────────────────────────────────

export type WhitelistError =
  | 'disallowed_tag'
  | 'disallowed_class'
  | 'disallowed_attribute'
  | 'disallowed_url'
  | 'parse_error'

export type WhitelistResult =
  | { ok: true; html: string }
  | { ok: false; reason: WhitelistError; detail: string }

// ── Main validator ─────────────────────────────────────────────────────────

/**
 * Validate an HTML fragment against the document vocabulary whitelist.
 *
 * Returns `{ ok: true, html }` where `html` is the normalized serialized
 * output of the parsed tree, or `{ ok: false, reason, detail }` on the
 * first violation found.
 */
export function validateHtml(input: string): WhitelistResult {
  let root
  try {
    root = parse(input, {
      lowerCaseTagName: true,
      comment: false,
      blockTextElements: {
        script: false,
        noscript: false,
        style: false,
        pre: true,
      },
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'parse_error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const result = walkNode(root)
  if (!result.ok) return result

  return { ok: true, html: root.toString() }
}

// ── Tree walker ────────────────────────────────────────────────────────────

function walkNode(node: ReturnType<typeof parse> | HTMLElement): WhitelistResult {
  for (const child of node.childNodes) {
    // Text nodes are always fine
    if (child instanceof TextNode) continue

    if (!(child instanceof HTMLElement)) continue

    const tag = child.rawTagName?.toLowerCase() ?? ''

    // ── Tag check ──────────────────────────────────────────────────────
    if (!ALLOWED_TAGS.has(tag)) {
      return {
        ok: false,
        reason: 'disallowed_tag',
        detail: `Tag <${tag}> is not in the allowed vocabulary`,
      }
    }

    // ── Attribute checks ───────────────────────────────────────────────
    for (const [attr, value] of Object.entries(child.attributes)) {
      const attrLower = attr.toLowerCase()

      // Reject event handlers
      if (EVENT_ATTR_RE.test(attrLower)) {
        return {
          ok: false,
          reason: 'disallowed_attribute',
          detail: `Event handler attribute "${attr}" is not allowed`,
        }
      }

      // Reject style entirely (simpler; revisit in a later phase)
      if (attrLower === 'style') {
        return {
          ok: false,
          reason: 'disallowed_attribute',
          detail: `Inline style attributes are not allowed — use Tailwind classes instead`,
        }
      }

      if (!ALLOWED_ATTRS.has(attrLower)) {
        return {
          ok: false,
          reason: 'disallowed_attribute',
          detail: `Attribute "${attr}" is not in the allowed set`,
        }
      }

      // ── URL check on href ────────────────────────────────────────────
      if (attrLower === 'href') {
        const urlResult = validateUrl(value)
        if (!urlResult.ok) return urlResult
      }

      // ── URL check on src ─────────────────────────────────────────────
      if (attrLower === 'src') {
        const urlResult = validateUrl(value)
        if (!urlResult.ok) return urlResult
      }

      // ── Class check ──────────────────────────────────────────────────
      if (attrLower === 'class') {
        const classResult = validateClasses(value)
        if (!classResult.ok) return classResult
      }
    }

    // ── Recurse ────────────────────────────────────────────────────────
    const childResult = walkNode(child)
    if (!childResult.ok) return childResult
  }

  return { ok: true, html: '' }
}

// ── Class validator ────────────────────────────────────────────────────────

function validateClasses(classAttr: string): WhitelistResult {
  const classes = classAttr.trim().split(/\s+/).filter(Boolean)
  for (const cls of classes) {
    if (!ALLOWED_CLASS_RE.test(cls)) {
      return {
        ok: false,
        reason: 'disallowed_class',
        detail: `Class "${cls}" is not in the allowed vocabulary`,
      }
    }
  }
  return { ok: true, html: '' }
}

// ── URL validator ──────────────────────────────────────────────────────────

function validateUrl(value: string): WhitelistResult {
  const trimmed = value.trim()

  // Reject javascript: protocol (catches "javascript:" with any casing/whitespace)
  if (/^javascript\s*:/i.test(trimmed)) {
    return {
      ok: false,
      reason: 'disallowed_url',
      detail: `javascript: URLs are not allowed`,
    }
  }

  // Allow: relative paths (no scheme), http, https, data URIs
  if (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    /^https?:\/\//i.test(trimmed) ||
    /^data:/i.test(trimmed) ||
    trimmed.startsWith('/')
  ) {
    return { ok: true, html: '' }
  }

  // Reject anything else with an unknown scheme
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) {
    return {
      ok: false,
      reason: 'disallowed_url',
      detail: `URL scheme not allowed: "${trimmed.split(':')[0]}:"`,
    }
  }

  // Relative URL — allow
  return { ok: true, html: '' }
}
