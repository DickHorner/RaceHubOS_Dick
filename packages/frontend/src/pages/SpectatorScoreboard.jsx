import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SessionStatus, SessionType, sessionTypeFullKey } from '@racehubos/shared'
import { useDevice } from '../context/DeviceContext'
import { useSession } from '../context/SessionContext'
import SessionLeaderboard from '../components/race/SessionLeaderboard'

const API_URL = import.meta.env.VITE_API_URL || ''

function clock(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '–'
  const value = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0')
  const secs = String(value % 60).padStart(2, '0')
  return hours ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`
}

export default function SpectatorScoreboard() {
  const { t } = useTranslation('scoreboard')
  const { socketConnected } = useDevice()
  const {
    session,
    entries,
    elapsed,
    remaining,
    maxLapsCompleted,
    lastServerTime,
    isStale,
    fetchSession,
    clearSession,
  } = useSession()
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
      if (latest?.id !== currentSession.current?.id) {
        clearSession()
        if (latest && !(await fetchSession(latest.id))) throw new Error('Could not load session')
      } else if (latest && latest.status !== currentSession.current?.status) {
        if (!(await fetchSession(latest.id))) throw new Error('Could not refresh session')
      }
      setLoadError(false)
    } catch (error) {
      console.warn('[SpectatorScoreboard] Read-only refresh failed:', error.message)
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
  const lapCount = Math.max(maxLapsCompleted, ...(session?.drivers || []).map((driver) => driver.totalLaps || 0), 0)
  const sortBy = session?.type === SessionType.QUALIF ? 'bestLap' : session?.type === SessionType.RACE ? 'race' : 'laps'

  return (
    <main className="min-h-dvh bg-background text-foreground p-3 sm:p-6 lg:p-10">
      <div className="mx-auto max-w-screen-2xl space-y-5">
        <header className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <h1 className="text-xl sm:text-3xl font-black tracking-tight">RaceHubOS · {t('title')}</h1>
          <div
            role="status"
            className={`text-xs sm:text-sm font-semibold ${signalMissing ? 'text-amber-500' : 'text-green-500'}`}
          >
            {signalMissing ? t('noSignal') : t('connected')}
          </div>
        </header>

        {loadError && (
          <p role="alert" className="rounded-lg border border-amber-500/40 p-3 text-amber-500">
            {t('loadError')}
          </p>
        )}

        {!session ? (
          <p className="rounded-xl bg-card border border-border p-8 text-center text-muted-foreground">
            {loading ? t('loading') : t('noSession')}
          </p>
        ) : (
          <>
            <section className="rounded-xl border border-border bg-card p-4 sm:p-6 space-y-4">
              <div className="flex flex-wrap justify-between gap-3 items-start">
                <div className="min-w-0">
                  <p className="text-sm uppercase font-medium text-muted-foreground">{t('session')}</p>
                  <h2 className="text-2xl sm:text-4xl font-black break-words">{session.name || t('untitled')}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t(sessionTypeFullKey(session.type), { defaultValue: session.type })}
                    {session.track?.name ? ` · ${session.track.name}` : ''}
                  </p>
                </div>
                <span className="rounded-lg bg-muted px-3 py-2 font-semibold">
                  {t(`glossary:sessionStatus.${session.status}`, { defaultValue: session.status })}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:gap-6">
                <div className="rounded-lg bg-muted/60 p-3 sm:p-5">
                  <p className="text-xs sm:text-base uppercase text-muted-foreground">{t('laps')}</p>
                  <p className="text-2xl sm:text-5xl font-black tabular-nums">
                    {lapCount}
                    {session.maxLaps ? ` / ${session.maxLaps}` : ''}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/60 p-3 sm:p-5">
                  <p className="text-xs sm:text-base uppercase text-muted-foreground">
                    {session.maxDuration ? t('remainingTime') : t('elapsedTime')}
                  </p>
                  <p className="text-2xl sm:text-5xl font-black tabular-nums">
                    {session.status === SessionStatus.FINISHED
                      ? t('finished')
                      : clock(session.maxDuration ? remaining : elapsed)}
                  </p>
                </div>
              </div>
            </section>
            <section aria-label={t('standings')} className="space-y-3">
              <h3 className="text-lg sm:text-2xl font-bold">{t('standings')}</h3>
              <div className="overflow-x-auto pb-3">
                <div className="min-w-[690px]">
                  <SessionLeaderboard
                    entries={entries}
                    sortBy={sortBy}
                    sessionType={session.type}
                    sessionStatus={session.status}
                    expanded
                  />
                </div>
              </div>
            </section>
          </>
        )}
        <footer className="text-xs text-muted-foreground text-center">{t('readOnly')}</footer>
      </div>
    </main>
  )
}
