import React from 'react'
import ReactMarkdown from 'react-markdown'

/**
 * Shared markdown component overrides for react-markdown.
 *
 * Provides a neutral prose-like appearance without relying on
 * @tailwindcss/typography. Used by DetailPane and QueueDrawer.
 */
export const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ children }) => <h1 style={{ fontSize: '1em', fontWeight: 700, marginBottom: '0.4em', marginTop: '0.75em' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: '1em', fontWeight: 600, marginBottom: '0.35em', marginTop: '0.75em' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: '1em', fontWeight: 600, marginBottom: '0.3em', marginTop: '0.6em' }}>{children}</h3>,
  p: ({ children }) => <p style={{ marginBottom: '0.5em', lineHeight: '1.6' }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  ul: ({ children }) => <ul style={{ paddingLeft: '1.25em', marginBottom: '0.5em', listStyleType: 'disc' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: '1.25em', marginBottom: '0.5em', listStyleType: 'decimal' }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: '0.2em', lineHeight: '1.6' }}>{children}</li>,
  hr: ({}) => <hr className="border-none border-t border-neutral-200 dark:border-neutral-700 my-3" />,
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return (
        <pre className="bg-neutral-100 dark:bg-neutral-800 rounded px-3 py-2.5 overflow-x-auto mb-2" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
          <code>{children}</code>
        </pre>
      )
    }
    return <code className="bg-neutral-100 dark:bg-neutral-800 rounded px-1" style={{ fontFamily: 'monospace', fontSize: '0.85em', padding: '0 0.3em' }}>{children}</code>
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-neutral-300 dark:border-neutral-600 pl-3 text-neutral-500 dark:text-neutral-400 my-2">{children}</blockquote>
  ),
}
