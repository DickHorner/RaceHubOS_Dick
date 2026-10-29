import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

const API_URL = import.meta.env.VITE_API_URL || ''

export default function SessionRecovery({ directorKey }) {
  const { t } = useTranslation('mobileControl')
  const [data, setData] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(false)

  const refresh = useCallback(() => {
    return fetch(`${API_URL}/api/race-control/director/session-recovery`, {
      headers: { Authorization: `Bearer ${directorKey}` },
    })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok || !result.success) throw new Error(t('sessionRecoveryLoadError'))
        setSelectedId('')
        setConfirmed(false)
        setData(result.data)
        setError('')
      })
      .catch((cause) => {
        setData(null)
        setError(cause.message)
      })
  }, [directorKey, t])

  useEffect(() => {
    refresh()
    if (window.location.hash === '#session-recovery') document.getElementById('session-recovery')?.scrollIntoView()
    window.addEventListener('session:status_changed', refresh)
    return () => window.removeEventListener('session:status_changed', refresh)
  }, [refresh])

  const selected = data?.sessions.find((row) => row.id === selectedId && row.id !== data.boundSessionId)

  async function recover(event) {
    event.preventDefault()
    if (pending.current || !confirmed || !selected) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/session-recovery/${selected.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ confirmed: true, expectedStatus: selected.status }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) {
        throw new Error(t(response.status === 409 ? 'sessionRecoveryConflict' : 'sessionRecoveryError'))
      }
      setNotice(t('sessionRecoverySuccess', { name: selected.name || selected.id }))
      await refresh()
    } catch (cause) {
      setError(cause.message)
      setConfirmed(false)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <section
      id="session-recovery"
      data-testid="session-recovery-panel"
      tabIndex={-1}
      className="rounded-xl border border-border bg-card p-5 space-y-4 scroll-mt-4"
    >
      <h2 className="font-semibold">{t('sessionRecoveryTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('sessionRecoveryHelp')}</p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={busy}
        onClick={refresh}
        data-testid="session-recovery-refresh"
      >
        {t('sessionRecoveryRefresh')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-600" data-testid="session-recovery-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-green-600" data-testid="session-recovery-notice">
          {notice}
        </p>
      )}
      {!data && !error && <p role="status">{t('loading')}</p>}
      {data && (
        <form onSubmit={recover} className="space-y-4" data-testid="session-recovery-form">
          <p className="text-sm">{data.boundSessionId ? t('sessionRecoveryBoundHelp') : t('sessionRecoveryUnknown')}</p>
          {!data.sessions.length && <p role="status">{t('sessionRecoveryEmpty')}</p>}
          <fieldset className="space-y-3" disabled={busy}>
            <legend className="text-sm font-medium mb-2">{t('sessionRecoverySelect')}</legend>
            {data.sessions.map((row) => (
              <div key={row.id} className="rounded-lg border border-border p-3 space-y-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="orphan-session"
                    value={row.id}
                    data-testid={`session-recovery-choice-${row.id}`}
                    disabled={row.id === data.boundSessionId}
                    checked={selectedId === row.id}
                    onChange={() => {
                      setSelectedId(row.id)
                      setConfirmed(false)
                    }}
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium">{row.name || t('session')}</span>
                    <span className="block text-sm">
                      {t(`glossary:sessionTypeFull.${row.type}`)} · {t(`glossary:sessionStatus.${row.status}`)}
                    </span>
                    <span className="block break-all text-xs text-muted-foreground">{row.id}</span>
                    {row.id === data.boundSessionId && (
                      <span className="block text-sm text-amber-600">{t('sessionRecoveryBound')}</span>
                    )}
                  </span>
                </label>
                <Link to={`/sessions/${row.id}`} className="inline-block py-2 text-sm underline">
                  {t('sessionRecoveryDetails')}
                </Link>
              </div>
            ))}
          </fieldset>
          {selected && (
            <>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={confirmed}
                  data-testid="session-recovery-confirm"
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {t('sessionRecoveryConfirm', { name: selected.name || selected.id })}
              </label>
              <Button
                type="submit"
                className="min-h-11"
                disabled={busy || !confirmed}
                data-testid="session-recovery-submit"
              >
                {t('sessionRecoveryApply')}
              </Button>
            </>
          )}
        </form>
      )}
    </section>
  )
}
