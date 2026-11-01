import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// A destination may arrive after its lazy page or authorised section loads.
export default function ScrollToFeature() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (!hash || hash.includes('=')) return
    let id
    try {
      id = decodeURIComponent(hash.slice(1))
    } catch {
      return
    }
    const scroll = () => {
      const target = document.getElementById(id)
      if (!target) return false
      target.scrollIntoView({ block: 'start' })
      return true
    }
    if (scroll()) return
    const observer = new MutationObserver(() => {
      if (scroll()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const timeout = setTimeout(() => observer.disconnect(), 5000)
    return () => {
      observer.disconnect()
      clearTimeout(timeout)
    }
  }, [pathname, hash])
  return null
}
