import React from 'react'
import ReactDOM from 'react-dom/client'
import { VoicePill } from './components/VoicePill'

// Don't import styles.css — it adds opaque backgrounds that break transparency

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <VoicePill />
  </React.StrictMode>
)
