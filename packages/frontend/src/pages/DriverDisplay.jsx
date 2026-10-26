import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SessionStatus, SessionType, TyreType, sessionTypeFullKey } from '@racehubos/shared'
import { useDevice } from '../context/DeviceContext'
import { useSession } from '../context/SessionContext'
import { DriverBadge } from '../components/DriverDisplays'
import LapTime from '../components/race/LapTime'
import GapDisplay from '../components/race/GapDisplay'
import { Button } from '@/components/ui/button'

const API_URL = import.meta.env.VITE_API_URL || ''

export default function DriverDisplay() {
  const { driverId } = useParams()
  const { t } = useTranslation('driverDisplay')
  const { connected, socketConnected, cuStatus } = useDevice()
  const { session, entries, lastServerTime, isStale, fetchSession, clearSession } = useSession()
  const currentSession = useRef(session)
  currentSession.current = session
  const fetching = useRef(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [chaosPending, setChaosPending] = useState(false)
  const [chaosMessage, setChaosMessage] = useState('')
  const [chaosError, setChaosError] = useState('')
  const [tyrePending, setTyrePending] = useState(false)
  const [tyreError, setTyreError] = useState('')
  const [tyreMessage, setTyreMessage] = useState('')
  const accessToken = new URLSearchParams(window.location.hash.slice(1)).get('chaos')

  const refresh = useCallback(async () => {
    if (fetching.current) return
    fetching.current = true
    try {
      const findLatest = async (status) => {
        const params = new URLSearchParams({ status, limit: '1', sortBy: 'updatedAt', sortOrder: 'desc' })
        const response = await fetch(`${API_URL}/api/sessions?${params}`)
        if (!response.ok) throw new Error('Could not load session list')
        const result = await response.json()
        if (!result.success) throw new Error(result.error || 'Could not load session list')
        return result.data?.[0] || null
      }

      const latest = (await findLatest('active,paused,finishing')) || (await findLatest('finished'))
      if (latest?.id !== currentSession.current?.id) clearSession()
      if (latest && !(await fetchSession(latest.id))) throw new Error('Could not load session')
      if (!latest) clearSession()
      setLoadError(false)
    } catch (error) {
      console.warn('[DriverDisplay] Read-only refresh failed:', error.message)
      setLoadError(true)
    } finally {
      fetching.current = false
      setLoading(false)
    }
  }, [clearSession, fetchSession])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15000)
    const onVisible = () => {
      if (!document.hidden) refresh()
    }
    window.addEventListener('session:status_changed', refresh)
    window.addEventListener('session:finished', refresh)
    window.addEventListener('session:tyre_changed', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('session:status_changed', refresh)
      window.removeEventListener('session:finished', refresh)
      window.removeEventListener('session:tyre_changed', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  useEffect(() => {
    if (socketConnected) refresh()
  }, [socketConnected, refresh])

  const racing = session && ['active', 'paused', 'finishing'].includes(session.status)
  const signalMissing = !socketConnected || (racing && (!lastServerTime || isStale))
  const assigned = (session?.drivers || []).filter((row) => row.driverId === driverId && !row.deletedAt)
  const assignment = assigned.length === 1 ? assigned[0] : null
  const live = assignment && entries.find((row) => row.id === assignment.id && row.controller === assignment.controller)
  const driver = assignment?.driver || live?.driver
  const car = assignment?.car || live?.car
  const stats = live?.stats || (assignment && {
    laps: assignment.totalLaps || 0,
    bestLap: assignment.bestLapTime,
    lastLap: assignment.lastLapTime,
    totalTime: assignment.totalTime || 0,
  })
  const position = live?.position || (session?.status === SessionStatus.FINISHED ? assignment?.finalPos : null)
  const leader = entries.find((row) => row.position === 1)

  let gap = null
  if (live && leader && position > 1) {
    if (session.type === SessionType.RACE) {
      const lapDiff = (leader.stats?.laps || 0) - (live.stats?.laps || 0)
      gap = lapDiff > 0
        ? { type: 'laps', value: lapDiff }
        : { type: 'time', value: (live.stats?.totalTime || 0) - (leader.stats?.totalTime || 0) }
    } else if (leader.stats?.bestLap && live.stats?.bestLap) {
      gap = { type: 'time', value: live.stats.bestLap - leader.stats.bestLap }
    }
  }

  const fuel = racing && assignment && connected && !signalMissing && (cuStatus?.mode & 0x1) !== 0
    ? cuStatus?.fuel?.[assignment.controller]
    : null
  const fuelLevel = Number.isInteger(fuel) && fuel >= 0 && fuel <= 15 ? fuel : null
  const virtualFuelUnits = live?.virtualFuelUnits ?? assignment?.virtualFuelUnits ?? null

  async function requestTyres(tyreType) {
    if (!accessToken || tyrePending || !session?.id || !assignment) return
    setTyrePending(true)
    setTyreError('')
    setTyreMessage('')
    try {
      const response = await fetch(`${API_URL}/api/race-control/driver/tyres`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ tyreType }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('tyreError'))
      setTyreMessage(t(result.data.pendingTyreType ? 'tyreRequested' : 'tyreRequestCleared'))
      await fetchSession(session.id)
    } catch (error) {
      setTyreError(error.message)
    } finally {
      setTyrePending(false)
    }
  }

  async function requestChaos() {
    if (!accessToken || chaosPending || !session || !assignment) return
    setChaosPending(true)
    setChaosError('')
    setChaosMessage('')
    try {
      const response = await fetch(`${API_URL}/api/race-control/chaos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('chaosError'))
      setChaosMessage(t(result.alreadyPaused ? 'alreadyPaused' : 'chaosRequested'))
    } catch (error) {
      setChaosError(error.message)
    } finally {
      setChaosPending(false)
    }
  }

  return (
    <main className="min-h-dvh bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <h1 className="text-xl font-black">RaceHubOS · {t('title')}</h1>
          <span role="status" className={`text-xs font-semibold ${signalMissing ? 'text-amber-500' : 'text-green-500'}`}>
            {signalMissing ? t('noSignal') : t('connected')}
          </span>
        </header>

        {loadError && <p role="alert" className="rounded-lg border border-amber-500/40 p-3 text-amber-500">{t('loadError')}</p>}
        {!session ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
            {loading ? t('loading') : t('noSession')}
          </p>
        ) : (
          <>
            <section className="rounded-xl border border-border bg-card p-4 space-y-2">
              <p className="text-sm text-muted-foreground">{t(sessionTypeFullKey(session.type), { defaultValue: session.type })}</p>
              <h2 className="text-xl font-bold break-words">{session.name || t('untitled')}</h2>
              <span className="inline-block rounded-md bg-muted px-3 py-1 text-sm font-semibold">
                {t(`glossary:sessionStatus.${session.status}`, { defaultValue: session.status })}
              </span>
            </section>

            {assigned.length > 1 ? (
              <p role="alert" className="rounded-xl border border-amber-500/40 p-5 text-amber-500">{t('ambiguous')}</p>
            ) : !assignment ? (
              <p className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground">{t('notAssigned')}</p>
            ) : (
              <>
                <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                  {driver && <DriverBadge driver={driver} size="xl" />}
                  <p className="text-sm text-muted-foreground">
                    {car ? `${car.brand} ${car.model}` : t('noCar')} · {t('controller', { number: assignment.controller + 1 })}
                  </p>
                </section>
                <section aria-label={t('statistics')} className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-card border border-border p-5">
                    <p className="text-sm text-muted-foreground">{t('position')}</p>
                    <p className="text-6xl font-black tabular-nums">{position || '–'}</p>
                  </div>
                  <div className="rounded-xl bg-card border border-border p-5">
                    <p className="text-sm text-muted-foreground">{t('laps')}</p>
                    <p className="text-5xl font-black tabular-nums">{stats?.laps ?? '–'}{session.maxLaps ? ` / ${session.maxLaps}` : ''}</p>
                  </div>
                  <div className="rounded-xl bg-card border border-border p-5">
                    <p className="text-sm text-muted-foreground">{t('bestLap')}</p>
                    <LapTime time={stats?.bestLap} size="xl" />
                  </div>
                  <div className="rounded-xl bg-card border border-border p-5">
                    <p className="text-sm text-muted-foreground">{t('lastLap')}</p>
                    <LapTime time={stats?.lastLap} size="xl" />
                  </div>
                  <div className="rounded-xl bg-card border border-border p-5">
                    <p className="text-sm text-muted-foreground">{t('gap')}</p>
                    {live && position ? <GapDisplay gap={gap} position={position} /> : <span>–</span>}
                  </div>
                  <div className="rounded-xl bg-card border border-border p-5">
                    <p className="text-sm text-muted-foreground">{t('hardwareFuel')}</p>
                    <p className="text-2xl font-bold tabular-nums">{fuelLevel === null ? t('unavailable') : `${fuelLevel} / 15`}</p>
                    {session.virtualFuelRate != null && (
                      <div className="mt-3 border-t border-border pt-3">
                        <p className="text-sm text-muted-foreground">{t('virtualFuel')}</p>
                        <p className="text-2xl font-bold tabular-nums">
                          {Number.isInteger(virtualFuelUnits) ? `${Math.round(virtualFuelUnits / 100)} %` : t('unavailable')}
                        </p>
                        <p className="text-xs text-muted-foreground">{t('virtualFuelNote')}</p>
                      </div>
                    )}
                  </div>
                </section>
                {session.type === SessionType.RACE && session.weatherSeed != null && (
                  <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                    <h2 className="font-semibold">{t('tyreTitle')}</h2>
                    <p className="text-sm">{t('tyreCurrent')}: {t((live?.tyreType || assignment.tyreType) === TyreType.WET ? 'tyreWet' : 'tyreDry')}</p>
                    {(live?.pendingTyreType || assignment.pendingTyreType) && (
                      <p role="status" className="text-sm text-amber-600">
                        {t('tyrePending')}: {t((live?.pendingTyreType || assignment.pendingTyreType) === TyreType.WET ? 'tyreWet' : 'tyreDry')}
                      </p>
                    )}
                    {Number.isInteger(live?.simulatedBestLapTime ?? assignment.simulatedBestLapTime) && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">{t('tyreVirtualBest')}</span>
                        <LapTime time={live?.simulatedBestLapTime ?? assignment.simulatedBestLapTime} size="md" />
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{t('tyreHint')}</p>
                    {accessToken && [SessionStatus.ACTIVE, SessionStatus.PAUSED].includes(session.status) && (
                      <div className="grid grid-cols-2 gap-2">
                        <Button type="button" variant="outline" disabled={tyrePending}
                          onClick={() => requestTyres(TyreType.DRY)}>{t('tyreDry')}</Button>
                        <Button type="button" variant="outline" disabled={tyrePending}
                          onClick={() => requestTyres(TyreType.WET)}>{t('tyreWet')}</Button>
                      </div>
                    )}
                    {!accessToken && <p className="text-xs text-amber-500">{t('tyreTokenRequired')}</p>}
                    {tyreMessage && <p role="status" className="text-sm text-green-500">{tyreMessage}</p>}
                    {tyreError && <p role="alert" className="text-sm text-red-500">{tyreError}</p>}
                  </section>
                )}
                {accessToken && ['active', 'paused'].includes(session.status) && (
                  <section className="rounded-xl border border-red-500/40 bg-card p-5 space-y-3">
                    <Button
                      type="button"
                      variant="destructive"
                      className="w-full min-h-20 text-2xl font-black"
                      disabled={chaosPending || session.status !== SessionStatus.ACTIVE || !connected || signalMissing}
                      onClick={requestChaos}
                    >
                      {t('chaosButton')}
                    </Button>
                    <p className="text-sm text-muted-foreground">{t('chaosDescription')}</p>
                    {chaosMessage && <p role="status" className="text-sm text-green-500">{chaosMessage}</p>}
                    {chaosError && <p role="alert" className="text-sm text-red-500">{chaosError}</p>}
                  </section>
                )}
              </>
            )}
          </>
        )}
        <footer className="text-center text-xs text-muted-foreground">{t('readOnly')}</footer>
      </div>
    </main>
  )
}