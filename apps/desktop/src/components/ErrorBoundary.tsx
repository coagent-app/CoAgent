import React, { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center', fontFamily: 'system-ui' }}>
          <h2 style={{ marginBottom: 16 }}>Something went wrong</h2>
          <p style={{ color: '#666', marginBottom: 24 }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }) }}
            style={{
              padding: '8px 24px',
              borderRadius: 8,
              border: '1px solid #ccc',
              background: '#f5f5f5',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
