import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevice } from '../context/DeviceContext'
import { useSession } from '../context/SessionContext'
import { Button } from '@/components/ui/button'
import Soundboard from '../components/race/Soundboard'
import LanShareLink from '../components/LanShareLink'
import { SessionStatus, SessionType, PenaltyKind, PenaltyStatus, TyreType, DamageStatus } from '@racehubos/shared'

const API_URL = import.meta.env.VITE_API_URL || ''
const DIRECTOR_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export default function MobileRaceControl() {
  const { t } = useTranslation('mobileControl')
  const { connected, socketConnected } = useDevice()
  const { session, elapsed, fetchSession, clearSession } = useSession()
  const [configured, setConfigured] = useState(null)
  const [setupAvailable, setSetupAvailable] = useState(false)
  const [generatedSecret, setGeneratedSecret] = useState('')
  const [setupSecretInput, setSetupSecretInput] = useState('')
  const [replacementSecret, setReplacementSecret] = useState('')
  const [credentialChanged, setCredentialChanged] = useState(false)
  const [secretCopied, setSecretCopied] = useState(false)
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
  const [now, setNow] = useState(0)
  const [penaltyDriverId, setPenaltyDriverId] = useState('')
  const [penaltyKind, setPenaltyKind] = useState(PenaltyKind.TIME)
  const [penaltyValue, setPenaltyValue] = useState(5)
  const [penaltyReason, setPenaltyReason] = useState('')
  const updating = useRef(false)
  const penaltyPending = useRef(false)
  const pendingDirectorKey = useRef(new URLSearchParams(window.location.hash.slice(1)).get('director'))

  const refresh = useCallback(async () => {
    if (updating.current) return
    updating.current = true
    try {
      const params = new URLSearchParams({
        status: 'active,paused,finishing,draft,finished',
        limit: '50',
        sortBy: 'updatedAt',
        sortOrder: 'desc',
      })
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
    const credential = pendingDirectorKey.current
    if (!credential) return
    // Retain the pending key across React StrictMode's setup/cleanup replay.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    if (credential.length < 32 || credential.length > 256) {
      pendingDirectorKey.current = null
      return
    }
    let active = true
    fetch(`${API_URL}/api/race-control/director/check`, {
      headers: { Authorization: `Bearer ${credential}` },
    })
      .then((response) => {
        if (!response.ok) throw new Error(t('wrongCredential'))
        if (!active) return
        pendingDirectorKey.current = null
        setDirectorKey(credential)
        setConfigured(true)
      })
      .catch(() => {
        if (!active) return
        pendingDirectorKey.current = null
        setError(t('wrongCredential'))
      })
    return () => {
      active = false
    }
  }, [t])

  useEffect(() => {
    fetch(`${API_URL}/api/race-control/status`)
      .then((response) => response.json())
      .then((result) => {
        setConfigured(result.enabled === true)
        setSetupAvailable(result.setupAvailable === true)
      })
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 10000)
    const onVisible = () => {
      if (!document.hidden) refresh()
    }
    window.addEventListener('session:status_changed', refresh)
    window.addEventListener('session:finished', refresh)
    window.addEventListener('session:vsc', refresh)
    window.addEventListener('session:vsc_error', refresh)
    window.addEventListener('session:damage_changed', refresh)
    window.addEventListener('session:pit_stop', refresh)
    window.addEventListener('session:tyre_changed', refresh)
    window.addEventListener('session:penalties_changed', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('session:status_changed', refresh)
      window.removeEventListener('session:finished', refresh)
      window.removeEventListener('session:vsc', refresh)
      window.removeEventListener('session:vsc_error', refresh)
      window.removeEventListener('session:damage_changed', refresh)
      window.removeEventListener('session:pit_stop', refresh)
      window.removeEventListener('session:tyre_changed', refresh)
      window.removeEventListener('session:penalties_changed', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  useEffect(() => {
    if (socketConnected) refresh()
  }, [socketConnected, refresh])

  async function setupRaceControl() {
    if (busy || !setupAvailable) return
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setupSecretInput ? { secret: setupSecretInput } : {}),
      })
      const result = await response.json()
      if (!response.ok || !result.success || !result.secret) throw new Error(result.error || t('setupError'))
      setDirectorKey(result.secret)
      setSetupSecretInput('')
      setGeneratedSecret(result.secret)
      setSecretCopied(false)
      setConfigured(true)
      setSetupAvailable(false)
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  async function copyGeneratedSecret() {
    try {
      await navigator.clipboard.writeText(generatedSecret)
      setSecretCopied(true)
    } catch {
      document.getElementById('generated-director-key')?.select()
      setSecretCopied(false)
    }
  }

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

  async function changeDirectorCredential(event) {
    event.preventDefault()
    if (busy || !directorKey || !DIRECTOR_SECRET_PATTERN.test(replacementSecret)) return
    setError('')
    setCredentialChanged(false)
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/credential`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${directorKey}`,
        },
        body: JSON.stringify({ secret: replacementSecret }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('changeSecretError'))
      setDirectorKey(replacementSecret)
      setReplacementSecret('')
      setGeneratedSecret('')
      setIssuedLink('')
      setCredentialChanged(true)
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

  async function confirmTyres(sessionDriverId) {
    if (!session?.id || !directorKey || busy) return
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/tyres/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ sessionId: session.id, sessionDriverId }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('tyreConfirmError'))
      await refresh()
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  async function changePenalty(action, penaltyId = null) {
    if (!session?.id || !directorKey || busy || penaltyPending.current) return
    penaltyPending.current = true
    setError('')
    setBusy(true)
    try {
      const endpoint =
        action === 'issue'
          ? '/api/race-control/director/penalties'
          : `/api/race-control/director/penalties/${encodeURIComponent(penaltyId)}/revoke`
      const details =
        action === 'issue'
          ? {
              sessionDriverId: selectedPenaltyDriverId,
              kind: penaltyKind,
              amount: penaltyKind === PenaltyKind.TIME ? penaltyValue * 1000 : penaltyValue,
              reason: penaltyReason.trim(),
              requestId: Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
                byte.toString(16).padStart(2, '0')
              ).join(''),
            }
          : {}
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ sessionId: session.id, ...details }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('penaltyError'))
      if (action === 'issue') setPenaltyReason('')
      await fetchSession(session.id)
    } catch (cause) {
      setError(cause.message)
    } finally {
      penaltyPending.current = false
      setBusy(false)
    }
  }

  async function confirmRepair(sessionDriverId, pitStopId) {
    if (!session?.id || !directorKey || busy || !window.confirm(t('damageVerifyConfirm'))) return
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/race-control/director/damage/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ sessionId: session.id, sessionDriverId, pitStopId }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('damageConfirmError'))
      await refresh()
    } catch (cause) {
      setError(cause.message)
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
      setIssuedLink(`/display/driver/${encodeURIComponent(driverId)}#chaos=${result.token}`)
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }

  const assigned = (session?.drivers || []).filter((row) => row.driverId && !row.deletedAt)
  const selectedPenaltyDriverId = assigned.some((row) => row.id === penaltyDriverId)
    ? penaltyDriverId
    : assigned[0]?.id || ''
  const validPenaltyAmount =
    Number.isInteger(penaltyValue) &&
    penaltyValue >= 1 &&
    penaltyValue <= (penaltyKind === PenaltyKind.TIME ? 3600 : 100)

  return (
    <main className="min-h-dvh bg-background text-foreground p-4 sm:p-8">
      <div className="mx-auto max-w-xl space-y-5">
        <header className="border-b border-border pb-4">
          <h1 className="text-2xl font-black">RaceHubOS · {t('title')}</h1>
          <p className="text-xs text-muted-foreground mt-2">{t('trustedLan')}</p>
        </header>

        {error && (
          <p role="alert" className="rounded-lg border border-red-500/40 text-red-500 p-3">
            {error}
          </p>
        )}
        {configured === false && (
          <section className="rounded-lg border border-amber-500/40 bg-card p-4 space-y-3">
            <p role="status" className="text-sm">
              {t('notConfigured')}
            </p>
            {setupAvailable ? (
              <>
                <p className="text-sm text-muted-foreground">{t('setupHere')}</p>
                <label className="block text-sm font-medium" htmlFor="custom-director-key">
                  {t('setupCustomSecret')}
                </label>
                <input
                  id="custom-director-key"
                  type="password"
                  autoComplete="new-password"
                  minLength={32}
                  maxLength={128}
                  pattern="[A-Za-z0-9_-]{32,128}"
                  value={setupSecretInput}
                  onChange={(event) => setSetupSecretInput(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                />
                <p className="text-xs text-muted-foreground">{t('secretRequirements')}</p>
                <Button
                  type="button"
                  disabled={busy || (setupSecretInput !== '' && !DIRECTOR_SECRET_PATTERN.test(setupSecretInput))}
                  onClick={setupRaceControl}
                >
                  {t('setupButton')}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('setupOnRacePc')}</p>
                <Button type="button" variant="outline" onClick={() => window.location.reload()}>
                  {t('retryStatus')}
                </Button>
              </>
            )}
          </section>
        )}
        {generatedSecret && (
          <section className="rounded-lg border border-border bg-card p-4 space-y-3">
            <label className="block text-sm font-medium" htmlFor="generated-director-key">
              {t('setupSecretLabel')}
            </label>
            <input
              id="generated-director-key"
              readOnly
              value={generatedSecret}
              onFocus={(event) => event.target.select()}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
            <p className="text-sm text-muted-foreground">{t('setupSecretHint')}</p>
            <Button type="button" variant="outline" onClick={copyGeneratedSecret}>
              {t('copySecret')}
            </Button>
            {secretCopied && (
              <p role="status" className="text-sm text-green-600">
                {t('setupSecretCopied')}
              </p>
            )}
          </section>
        )}
        {configured && !directorKey && (
          <form onSubmit={authorize} className="rounded-xl border border-border bg-card p-5 space-y-3">
            <label className="block text-sm font-medium" htmlFor="director-credential">
              {t('credential')}
            </label>
            <input
              id="director-credential"
              type="password"
              autoComplete="off"
              required
              value={secretInput}
              onChange={(event) => setSecretInput(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
            <Button disabled={busy || !secretInput} type="submit">
              {t('unlock')}
            </Button>
          </form>
        )}

        {directorKey && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span role="status" className="text-sm text-green-500">
                {t('authorized')}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDirectorKey('')
                  setIssuedLink('')
                  setGeneratedSecret('')
                  setCredentialChanged(false)
                }}
              >
                {t('lock')}
              </Button>
            </div>
            <Soundboard directorKey={directorKey} />
            <section className="rounded-xl border border-border bg-card p-5 space-y-2">
              <h2 className="text-sm font-semibold">{t('shareDirector')}</h2>
              <LanShareLink path="/display/control" directorKey={directorKey} />
            </section>
            <form onSubmit={changeDirectorCredential} className="rounded-xl border border-border bg-card p-5 space-y-3">
              <label className="block text-sm font-medium" htmlFor="replacement-director-key">
                {t('changeSecret')}
              </label>
              <input
                id="replacement-director-key"
                type="password"
                autoComplete="new-password"
                minLength={32}
                maxLength={128}
                pattern="[A-Za-z0-9_-]{32,128}"
                required
                value={replacementSecret}
                onChange={(event) => {
                  setReplacementSecret(event.target.value)
                  setCredentialChanged(false)
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
              <p className="text-xs text-muted-foreground">{t('secretRequirements')}</p>
              <p className="text-xs text-amber-600">{t('changeSecretWarning')}</p>
              <Button type="submit" disabled={busy || !DIRECTOR_SECRET_PATTERN.test(replacementSecret)}>
                {t('saveSecret')}
              </Button>
              {credentialChanged && (
                <p role="status" className="text-sm text-green-600">
                  {t('secretChanged')}
                </p>
              )}
            </form>
            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
              <label className="text-sm font-medium block" htmlFor="race-select">
                {t('session')}
              </label>
              <select
                id="race-select"
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value)
                  setIssuedLink('')
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              >
                {!sessions.length && <option value="">{loading ? t('loading') : t('noSession')}</option>}
                {sessions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name || row.type} · {row.status}
                  </option>
                ))}
              </select>
              {session?.id === selectedId && (
                <>
                  <p className="text-sm">
                    {t('state')}: {t(`glossary:sessionStatus.${session.status}`, { defaultValue: session.status })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || !connected || session.status !== SessionStatus.ACTIVE}
                      onClick={() => control('pause')}
                      variant="outline"
                    >
                      {t('pause')}
                    </Button>
                    <Button
                      disabled={busy || !connected || session.status !== SessionStatus.PAUSED}
                      onClick={() => control('resume')}
                    >
                      {t('resume')}
                    </Button>
                    <Button
                      disabled={busy || !connected || !['active', 'paused', 'finishing'].includes(session.status)}
                      onClick={() => control('stop')}
                      variant="destructive"
                    >
                      {t('stop')}
                    </Button>
                  </div>
                </>
              )}
            </section>
            {((session?.id === selectedId && session.type === SessionType.RACE) || vsc.status !== 'inactive') && (
              <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="font-bold">{t('vscTitle')}</h2>
                <p role="status" className="text-sm">
                  {t('vscState')}: {t(`vscStatus.${vsc.status}`)}
                </p>
                {vsc.expiresAt && now > 0 && vsc.active && (
                  <p className="font-mono text-lg tabular-nums">
                    {t('vscRemaining', { seconds: Math.max(0, Math.ceil((Date.parse(vsc.expiresAt) - now) / 1000)) })}
                  </p>
                )}
                {vsc.error && (
                  <p role="alert" className="text-sm text-red-500">
                    {vsc.error}
                  </p>
                )}
                {vsc.status === 'inactive' && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-sm">
                      {t('vscCap')}
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={vscCap}
                        onChange={(event) => setVscCap(Number(event.target.value))}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1"
                      />
                    </label>
                    <label className="text-sm">
                      {t('vscDuration')}
                      <input
                        type="number"
                        min="0"
                        max="3600"
                        value={vscDuration}
                        onChange={(event) => setVscDuration(Number(event.target.value))}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1"
                      />
                    </label>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t('vscWarning')}</p>
                {vsc.status === 'inactive' ? (
                  <Button
                    onClick={() => controlVsc('start')}
                    disabled={
                      busy ||
                      !connected ||
                      session.status !== SessionStatus.ACTIVE ||
                      vscCap < 1 ||
                      vscCap > 10 ||
                      vscDuration < 0 ||
                      vscDuration > 3600 ||
                      (vscDuration > 0 && vscDuration < 5)
                    }
                  >
                    {t('vscStart')}
                  </Button>
                ) : (
                  <Button variant="outline" disabled={busy || !connected} onClick={() => controlVsc('end')}>
                    {t('vscEnd')}
                  </Button>
                )}
              </section>
            )}
            {session?.id === selectedId &&
              session.type === SessionType.RACE &&
              assigned.some((row) => row.pendingTyreType) && (
                <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                  <h2 className="font-bold">{t('tyreConfirmTitle')}</h2>
                  <p className="text-xs text-muted-foreground">{t('tyreConfirmWarning')}</p>
                  {assigned
                    .filter((row) => row.pendingTyreType)
                    .map((row) => (
                      <div key={row.id} className="flex items-center justify-between gap-3 border-t border-border pt-3">
                        <div className="text-sm">
                          <p className="font-semibold">
                            {row.driver?.name || `${t('controller')} ${row.controller + 1}`}
                          </p>
                          <p>
                            {t(row.tyreType === TyreType.WET ? 'tyreWet' : 'tyreDry')} →{' '}
                            {t(row.pendingTyreType === TyreType.WET ? 'tyreWet' : 'tyreDry')}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || ![SessionStatus.ACTIVE, SessionStatus.PAUSED].includes(session.status)}
                          onClick={() => confirmTyres(row.id)}
                        >
                          {t('tyreConfirm')}
                        </Button>
                      </div>
                    ))}
                </section>
              )}
            {session?.id === selectedId && session.type === SessionType.RACE && (
              <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="font-bold">{t('penaltiesTitle')}</h2>
                <p className="text-xs text-muted-foreground">{t('penaltyHelp')}</p>
                {assigned.length > 0 &&
                  [
                    SessionStatus.ACTIVE,
                    SessionStatus.PAUSED,
                    SessionStatus.FINISHING,
                    SessionStatus.FINISHED,
                  ].includes(session.status) && (
                    <>
                      <label className="block text-sm" htmlFor="penalty-driver">
                        {t('penaltyDriver')}
                        <select
                          id="penalty-driver"
                          value={selectedPenaltyDriverId}
                          onChange={(event) => setPenaltyDriverId(event.target.value)}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1"
                        >
                          {assigned.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.driver?.name || `${t('controller')} ${row.controller + 1}`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="text-sm" htmlFor="penalty-kind">
                          {t('penaltyKind')}
                          <select
                            id="penalty-kind"
                            value={penaltyKind}
                            onChange={(event) => setPenaltyKind(event.target.value)}
                            className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1"
                          >
                            <option value={PenaltyKind.TIME}>{t('penaltyTime')}</option>
                            <option value={PenaltyKind.LAP}>{t('penaltyLap')}</option>
                          </select>
                        </label>
                        <label className="text-sm" htmlFor="penalty-amount">
                          {t(penaltyKind === PenaltyKind.TIME ? 'penaltySeconds' : 'penaltyLaps')}
                          <input
                            id="penalty-amount"
                            type="number"
                            min="1"
                            max={penaltyKind === PenaltyKind.TIME ? 3600 : 100}
                            step="1"
                            value={penaltyValue}
                            onChange={(event) => setPenaltyValue(Number(event.target.value))}
                            className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1"
                          />
                        </label>
                      </div>
                      <label className="block text-sm" htmlFor="penalty-reason">
                        {t('penaltyReason')}
                        <input
                          id="penalty-reason"
                          type="text"
                          maxLength={200}
                          value={penaltyReason}
                          onChange={(event) => setPenaltyReason(event.target.value)}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 mt-1"
                        />
                      </label>
                      <Button
                        type="button"
                        disabled={
                          busy || !selectedPenaltyDriverId || !validPenaltyAmount || penaltyReason.trim().length < 3
                        }
                        onClick={() => changePenalty('issue')}
                      >
                        {t('penaltyIssue')}
                      </Button>
                    </>
                  )}
                {session.penalties?.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">{t('penaltyHistory')}</h3>
                    {session.penalties.map((penalty) => {
                      const row = assigned.find((driver) => driver.id === penalty.sessionDriverId)
                      return (
                        <div
                          key={penalty.id}
                          className="flex items-center justify-between gap-3 border-t border-border pt-2"
                        >
                          <div className="min-w-0 text-sm">
                            <p className="font-medium">
                              {row?.driver?.name || `${t('controller')} ${penalty.controller + 1}`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {penalty.kind === PenaltyKind.TIME
                                ? `+${penalty.amount / 1000} s`
                                : `−${penalty.amount} ${t('penaltyLaps')}`}{' '}
                              · {penalty.reason}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t(penalty.status === PenaltyStatus.ACTIVE ? 'penaltyActive' : 'penaltyRevoked')}
                            </p>
                          </div>
                          {penalty.status === PenaltyStatus.ACTIVE && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => changePenalty('revoke', penalty.id)}
                            >
                              {t('penaltyRevoke')}
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )}
            {session?.id === selectedId &&
              session.type === SessionType.RACE &&
              assigned.some((row) => row.damageStatus === DamageStatus.ACTIVE) && (
                <section className="rounded-xl border border-amber-500/40 bg-card p-5 space-y-3">
                  <h2 className="font-bold">{t('damageRepairTitle')}</h2>
                  <p className="text-xs text-muted-foreground">{t('damageRepairWarning')}</p>
                  {assigned
                    .filter((row) => row.damageStatus === DamageStatus.ACTIVE)
                    .map((row) => {
                      const eligible = (session.pitStops || []).filter(
                        (stop) =>
                          stop.sessionDriverId === row.id &&
                          stop.source === 'cu' &&
                          stop.durationMs >= session.damagePitSeconds * 1000 &&
                          new Date(stop.enteredAt).getTime() >= new Date(row.damageTriggeredAt).getTime()
                      )
                      return (
                        <div key={row.id} className="border-t border-border pt-3 space-y-2">
                          <p className="font-semibold">
                            {row.driver?.name || `${t('controller')} ${row.controller + 1}`}
                            {' · '}
                            {t('damageRemaining', {
                              seconds: Math.max(0, Math.ceil(row.damageDeadlineElapsedMs / 1000 - elapsed)),
                            })}
                          </p>
                          {eligible.length === 0 ? (
                            <p className="text-xs text-amber-600">{t('damageNoPit')}</p>
                          ) : (
                            eligible.slice(-3).map((stop) => (
                              <div key={stop.id} className="flex items-center justify-between gap-3">
                                <p className="text-xs text-muted-foreground">
                                  {new Date(stop.exitedAt).toLocaleTimeString()} · ~
                                  {(stop.durationMs / 1000).toFixed(1)} s
                                </p>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    busy ||
                                    ![SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING].includes(
                                      session.status
                                    )
                                  }
                                  onClick={() => confirmRepair(row.id, stop.id)}
                                >
                                  {t('damageConfirm')}
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      )
                    })}
                </section>
              )}
            {session?.id === selectedId && assigned.length > 0 && (
              <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="font-bold">{t('driverLinks')}</h2>
                <p className="text-xs text-muted-foreground">{t('linkWarning')}</p>
                <div className="flex flex-wrap gap-2">
                  {assigned.map((row) => (
                    <Button
                      key={row.id}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => issueLink(row.driverId)}
                    >
                      {row.driver?.name || `${t('controller')} ${row.controller + 1}`}
                    </Button>
                  ))}
                </div>
                {issuedLink && <LanShareLink key={issuedLink} path={issuedLink} inputId="issued-driver-link" />}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  )
}
