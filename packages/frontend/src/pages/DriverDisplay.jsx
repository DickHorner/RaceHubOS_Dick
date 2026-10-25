import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SessionStatus, SessionType, sessionTypeFullKey } from '@racehubos/shared'
import { useDevice } from '../context/DeviceContext'
import { useSession } from '../context/SessionContext'
import { DriverBadge } from '../components/DriverDisplays'
import LapTime from '../components/race/LapTime'
import GapDisplay from '../components/race/GapDisplay'

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
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('session:status_changed', refresh)
      window.removeEventListener('session:finished', refresh)
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
                    <p className="text-sm text-muted-foreground">{t('fuel')}</p>
                    <p className="text-2xl font-bold tabular-nums">{fuelLevel === null ? t('unavailable') : `${fuelLevel} / 15`}</p>
                  </div>
                </section>
              </>
            )}
          </>
        )}
        <footer className="text-center text-xs text-muted-foreground">{t('readOnly')}</footer>
      </div>
    </main>
  )
}