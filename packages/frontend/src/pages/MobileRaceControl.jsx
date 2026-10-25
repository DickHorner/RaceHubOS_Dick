import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevice } from '../context/DeviceContext'
import { useSession } from '../context/SessionContext'
import { Button } from '@/components/ui/button'

const API_URL = import.meta.env.VITE_API_URL || ''

export default function MobileRaceControl() {
  const { t } = useTranslation('mobileControl')
  const { connected, socketConnected } = useDevice()
  const { session, fetchSession, clearSession } = useSession()
  const [configured, setConfigured] = useState(null)
  const [secretInput, setSecretInput] = useState('')
  const [directorKey, setDirectorKey] = useState('')
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [issuedLink, setIssuedLink] = useState('')
  const [vsc, setVsc] = useState({ status: 'inactive', active: false })
  const [vscCap, setVscCap] = useState(3)
  const [vscDuration, setVscDuration] = useState(0)
  const [now, setNow] = useState(Date.now())
  const updating = useRef(false)

  const refresh = useCallback(async () => {
    if (updating.current) return
    updating.current = true
    try {
      const params = new URLSearchParams({ status: 'active,paused,finishing,draft', limit: '50', sortBy: 'updatedAt', sortOrder: 'desc' })
      const response = await fetch(`${API_URL}/api/sessions?${params}`)
      if (!response.ok) throw new Error(t('loadError'))
      const result = await response.json()
      if (!result.success) throw new Error(t('loadError'))
      const vscResponse = await fetch(`${API_URL}/api/race-control/vsc`)
      if (!vscResponse.ok) throw new Error(t('loadError'))
      const vscResult = await vscResponse.json()
      if (!vscResult.success) throw new Error(t('loadError'))
      setVsc(vscResult.data)
      const available = result.data || []
      setSessions(available)
      const id = available.some((s) => s.id === selectedId) ? selectedId : available[0]?.id || ''
      if (id !== selectedId) setSelectedId(id)
      if (id) {
        if (!(await fetchSession(id))) throw new Error(t('loadError'))
      } else {
        clearSession()
      }
      setLoading(false)
    } catch (cause) {
      console.warn('[MobileRaceControl] Read failed:', cause.message)
      setError(t('loadError'))
      setLoading(false)
    } finally {
      updating.current = false
    }
  }, [selectedId, fetchSession, clearSession, t])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    fetch(`${API_URL}/api/race-control/status`)
      .then((response) => response.json())
      .then((result) => setConfigured(result.enabled === true))
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 10000)
    const onVisible = () => { if (!document.hidden) refresh() }
    window.addEventListener('session:status_changed', refresh)
    window.addEventListener('session:finished', refresh)
    window.addEventListener('session:vsc', refresh)
    window.addEventListener('session:vsc_error', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('session:status_changed', refresh)
      window.removeEventListener('session:finished', refresh)
      window.removeEventListener('session:vsc', refresh)
      window.removeEventListener('session:vsc_error', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  useEffect(() => {
    if (socketConnected) refresh()
  }, [socketConnected, refresh])

  async function authorize(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/check`, {
        headers: { Authorization: `Bearer ${secretInput}` },
      })
      if (!response.ok) throw new Error(t('wrongCredential'))
      setDirectorKey(secretInput)
      setSecretInput('')
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  async function control(action) {
    if (!session?.id || !directorKey || busy) return
    if (action === 'stop' && !window.confirm(t('confirmStop'))) return
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ sessionId: session.id }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('controlError'))
      await refresh()
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  async function controlVsc(action) {
    const id = action === 'end' ? vsc.sessionId : session?.id
    if (!id || !directorKey || busy) return
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/vsc/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ sessionId: id, cap: vscCap, durationSeconds: vscDuration }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('vscError'))
      setVsc(result.data)
      await refresh()
    } catch (cause) {
      setError(cause.message)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function issueLink(driverId) {
    if (!session?.id || !directorKey || busy) return
    setError('')
    setIssuedLink('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/driver-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ sessionId: session.id, driverId }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('linkError'))
      const url = `${window.location.origin}/display/driver/${encodeURIComponent(driverId)}#chaos=${result.token}`
      setIssuedLink(url)
      try {
        await navigator.clipboard.writeText(url)
      } catch {
        // HTTP LAN origins may not expose Clipboard API. Link remains selectable below.
      }
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  const assigned = (session?.drivers || []).filter((row) => row.driverId && !row.deletedAt)

  return (
    <main className="min-h-dvh bg-background text-foreground p-4 sm:p-8">
      <div className="mx-auto max-w-xl space-y-5">
        <header className="border-b border-border pb-4">
          <h1 className="text-2xl font-black">RaceHubOS · {t('title')}</h1>
          <p className="text-xs text-muted-foreground mt-2">{t('trustedLan')}</p>
        </header>

        {error && <p role="alert" className="rounded-lg border border-red-500/40 text-red-500 p-3">{error}</p>}
        {configured === false && <p role="alert" className="rounded-lg border border-amber-500/40 text-amber-500 p-4">{t('notConfigured')}</p>}
        {configured && !directorKey && (
          <form onSubmit={authorize} className="rounded-xl border border-border bg-card p-5 space-y-3">
            <label className="block text-sm font-medium" htmlFor="director-credential">{t('credential')}</label>
            <input
              id="director-credential"
              type="password"
              autoComplete="off"
              required
              value={secretInput}
              onChange={(event) => setSecretInput(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
            <Button disabled={busy || !secretInput} type="submit">{t('unlock')}</Button>
          </form>
        )}

        {directorKey && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span role="status" className="text-sm text-green-500">{t('authorized')}</span>
              <Button variant="outline" size="sm" onClick={() => { setDirectorKey(''); setIssuedLink('') }}>
                {t('lock')}
              </Button>
            </div>
            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
              <label className="text-sm font-medium block" htmlFor="race-select">{t('session')}</label>
              <select
                id="race-select"
                value={selectedId}
                onChange={(event) => { setSelectedId(event.target.value); setIssuedLink('') }}
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              >
                {!sessions.length && <option value="">{loading ? t('loading') : t('noSession')}</option>}
                {sessions.map((row) => <option key={row.id} value={row.id}>{row.name || row.type} · {row.status}</option>)}
              </select>
              {session?.id === selectedId && (
                <>
                  <p className="text-sm">{t('state')}: {t(`glossary:sessionStatus.${session.status}`, { defaultValue: session.status })}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy || !connected || session.status !== 'active'} onClick={() => control('pause')} variant="outline">
                      {t('pause')}
                    </Button>
                    <Button disabled={busy || !connected || session.status !== 'paused'} onClick={() => control('resume')}>
                      {t('resume')}
                    </Button>
                    <Button disabled={busy || !connected || !['active', 'paused', 'finishing'].includes(session.status)} onClick={() => control('stop')} variant="destructive">
                      {t('stop')}
                    </Button>
                  </div>
                </>
              )}
            </section>
            {((session?.id === selectedId && session.type === 'race') || vsc.status !== 'inactive') && (
              <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="font-bold">{t('vscTitle')}</h2>
                <p role="status" className="text-sm">{t('vscState')}: {t(`vscStatus.${vsc.status}`)}</p>
                {vsc.expiresAt && vsc.status === 'active' && (
                  <p className="font-mono text-lg tabular-nums">
                    {t('vscRemaining', { seconds: Math.max(0, Math.ceil((Date.parse(vsc.expiresAt) - now) / 1000)) })}
                  </p>
                )}
                {vsc.error && <p role="alert" className="text-sm text-red-500">{vsc.error}</p>}
                {vsc.status === 'inactive' && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-sm">{t('vscCap')}
                      <input type="number" min="1" max="10" value={vscCap}
                        onChange={(event) => setVscCap(Number(event.target.value))}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1" />
                    </label>
                    <label className="text-sm">{t('vscDuration')}
                      <input type="number" min="0" max="3600" value={vscDuration}
                        onChange={(event) => setVscDuration(Number(event.target.value))}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1" />
                    </label>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t('vscWarning')}</p>
                {vsc.status === 'inactive' ? (
                  <Button onClick={() => controlVsc('start')} disabled={busy || !connected || session.status !== 'active' || vscCap < 1 || vscCap > 10 || vscDuration < 0 || vscDuration > 3600 || (vscDuration > 0 && vscDuration < 5)}>
                    {t('vscStart')}
                  </Button>
                ) : (
                  <Button variant="outline" disabled={busy || !connected} onClick={() => controlVsc('end')}>
                    {t('vscEnd')}
                  </Button>
                )}
              </section>
            )}
            {session?.id === selectedId && assigned.length > 0 && (
              <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="font-bold">{t('driverLinks')}</h2>
                <p className="text-xs text-muted-foreground">{t('linkWarning')}</p>
                <div className="flex flex-wrap gap-2">
                  {assigned.map((row) => (
                    <Button key={row.id} type="button" variant="outline" disabled={busy} onClick={() => issueLink(row.driverId)}>
                      {row.driver?.name || `${t('controller')} ${row.controller + 1}`}
                    </Button>
                  ))}
                </div>
                {issuedLink && (
                  <div className="space-y-2">
                    <label className="block text-sm" htmlFor="issued-driver-link">{t('copyLink')}</label>
                    <input id="issued-driver-link" readOnly value={issuedLink} onFocus={(event) => event.target.select()} className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs" />
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  )
}