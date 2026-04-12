import { useEffect, useState } from 'react'

export function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    // Clear inline background set by index.html's early dark-mode script
    document.documentElement.style.background = ''
    document.body.style.background = dark ? '#0a0a0a' : '#fff'
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  return { dark, toggle: () => setDark(d => !d) }
}
