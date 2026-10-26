import { useEffect, useState, useMemo } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Flag, MapPin, Trash2, Trophy, Users2, Clock, Timer, Pause, Scale, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import DeleteButton from '../components/ui/DeleteButton'
import ExportButton from '../components/ui/ExportButton'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ConfirmModal } from '../components/ui/Modal'
import SessionLeaderboard from '../components/race/SessionLeaderboard'
import BalancingChart from '../components/balancing/BalancingChart'
import Podium from '../components/race/Podium'
import LapTime from '../components/race/LapTime'
import { SessionStatus, SessionType, rankRaceDrivers, PenaltyKind, PenaltyStatus } from '@racehubos/shared'

const API_URL = import.meta.env.VITE_API_URL || ''

function formatDate(date, locale) {
  return new Date(date).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function SessionDetail() {
  const { t, i18n } = useTranslation('sessions')
  const { id } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/sessions/${id}`)
        const data = await res.json()
        if (data.success) setSession(data.data)
      } catch (err) {
        console.error('Error loading session:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  useEffect(() => {
    const onPenaltyChange = ({ detail }) => {
      if (detail?.sessionId !== id) return
      fetch(`${API_URL}/api/sessions/${id}`)
        .then((response) => response.json())
        .then((result) => {
          if (result.success) setSession(result.data)
        })
        .catch((error) => console.error('Error refreshing penalties:', error))
    }
    window.addEventListener('session:penalties_changed', onPenaltyChange)
    return () => window.removeEventListener('session:penalties_changed', onPenaltyChange)
  }, [id])

  const rankedRaceDrivers = useMemo(() => {
    if (session?.type !== SessionType.RACE) return []
    return rankRaceDrivers(session.drivers || [], session.penalties || [])
  }, [session])

  // Build entries from session.drivers (same format as SessionContext entries)
  const entries = useMemo(() => {
    if (!session?.drivers?.length) return []

    const drivers = session.drivers
    const allBestLaps = drivers.map((d) => d.bestLapTime).filter((t) => t && t > 0)
    const fastestLapTime = allBestLaps.length > 0 ? Math.min(...allBestLaps) : null

    // Sort
    const isRace = session.type === SessionType.RACE
    const sorted = isRace
      ? rankedRaceDrivers
      : [...drivers].sort((a, b) => {
          if (!a.bestLapTime && !b.bestLapTime) return 0
          if (!a.bestLapTime) return 1
          if (!b.bestLapTime) return -1
          return a.bestLapTime - b.bestLapTime
        })

    const leader = sorted[0]

    return sorted.map((sd, i) => {
      let gap = null
      if (i > 0 && leader) {
        if (isRace) {
          const lapDiff = leader.classifiedLaps - sd.classifiedLaps
          if (lapDiff > 0) gap = { type: 'laps', value: lapDiff }
          else
            gap = {
              type: 'time',
              value:
                (sd.classifiedSimulatedTime ?? sd.classifiedTime) -
                (leader.classifiedSimulatedTime ?? leader.classifiedTime),
            }
        } else {
          if (leader.bestLapTime && sd.bestLapTime) gap = { type: 'time', value: sd.bestLapTime - leader.bestLapTime }
        }
      }

      return {
        id: sd.id,
        controller: sd.controller,
        driver: sd.driver,
        car: sd.car,
        gridPos: sd.gridPos ?? null,
        damageStatus: sd.damageStatus,
        damageLapNumber: sd.damageLapNumber,
        damageRepairSource: sd.damageRepairSource,
        tyreType: sd.tyreType,
        pendingTyreType: sd.pendingTyreType,
        virtualFuelUnits: sd.virtualFuelUnits ?? null,
        stats: {
          laps: sd.classifiedLaps ?? sd.totalLaps ?? 0,
          bestLap: sd.bestLapTime || null,
          lastLap: sd.lastLapTime || null,
          totalTime: sd.classifiedTime ?? sd.totalTime ?? 0,
          rankTime: sd.classifiedSimulatedTime,
          simulatedTotalTime: sd.simulatedTotalTime,
          simulatedBestLapTime: sd.simulatedBestLapTime,
          gap,
        },
        position: i + 1,
        positionDelta: 0,
        penaltyLaps: sd.penaltyLaps || 0,
        penaltyTimeMs: sd.penaltyTimeMs || 0,
        hasFastestLap: fastestLapTime && sd.bestLapTime === fastestLapTime,
        isDNF: sd.isDNF || false,
      }
    })
  }, [session, rankedRaceDrivers])

  // Build entries for balancing chart (needs laps array per controller)
  const balancingEntries = useMemo(() => {
    if (!session || session.type !== SessionType.BALANCING || !session.laps?.length) return []

    // Group laps by controller
    const lapsByCtrl = new Map()
    for (const lap of session.laps) {
      if (!lapsByCtrl.has(lap.controller)) lapsByCtrl.set(lap.controller, [])
      lapsByCtrl.get(lap.controller).push({ lapNumber: lap.lapNumber, lapTime: Math.round(lap.lapTime) })
    }

    return (session.drivers || []).map((sd) => ({
      id: sd.id,
      controller: sd.controller,
      driver: sd.driver,
      car: sd.car,
      laps: (lapsByCtrl.get(sd.controller) || []).sort((a, b) => a.lapNumber - b.lapNumber),
      stats: { laps: sd.totalLaps || 0, bestLap: sd.bestLapTime || null },
    }))
  }, [session])

  // Session duration
  const sessionDuration = useMemo(() => {
    if (!session?.startedAt || !session?.finishedAt) return null
    const start = new Date(session.startedAt).getTime()
    const end = new Date(session.finishedAt).getTime()
    return end - start
  }, [session])

  // Fastest lap
  const fastestLap = useMemo(() => {
    const times = (session?.drivers || []).map((d) => d.bestLapTime).filter((t) => t && t > 0)
    return times.length > 0 ? Math.min(...times) : null
  }, [session])

  async function handleDelete() {
    try {
      const res = await fetch(`${API_URL}/api/sessions/${id}`, { method: 'DELETE' })
      if (res.ok) navigate('/history')
    } catch (err) {
      console.error('Error deleting session:', err)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full size-10 border-b-2 border-primary" />
      </div>
    )
  }

  if (!session) {
    return (
      <div className="p-8">
        <Button variant="ghost" onClick={() => navigate('/history')}>
          <ArrowLeft className="size-4" /> {t('common:back')}
        </Button>
        <p className="text-center text-muted-foreground mt-8">{t('profile.notFound')}</p>
      </div>
    )
  }

  const isBalancing = session.type === SessionType.BALANCING
  const TypeIcon = isBalancing ? Scale : session.type === SessionType.RACE ? Flag : Clock

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/history')}>
            <ArrowLeft className="size-4" />
          </Button>
          <TypeIcon className="size-5 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg">
                {session.name || t('unnamedSession', { id: session.id.slice(0, 8) })}
              </h1>
              <Badge variant="outline">
                {t(`glossary:sessionTypeFull.${session.type}`, { defaultValue: session.type })}
              </Badge>
              <Badge variant={session.status === SessionStatus.FINISHED ? 'default' : 'secondary'}>
                {t(`glossary:sessionStatus.${session.status}`, { defaultValue: session.status })}
              </Badge>
              {session.type === SessionType.RACE && session.weatherSeed != null && (
                <Badge variant="outline">
                  {t('profile.weatherFinal', {
                    condition: t(
                      `championships:sessionSection.weather.${session.weatherCondition || session.weatherInitial}`
                    ),
                  })}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              {session.track && (
                <Link to={`/tracks/${session.track.id}`} className="hover:underline flex items-center gap-1">
                  <MapPin className="size-3" />
                  {session.track.name}
                </Link>
              )}
              {session.championship && (
                <Link
                  to={`/championships/${session.championship.id}`}
                  className="hover:underline flex items-center gap-1"
                >
                  <Trophy className="size-3" />
                  {session.championship.name}
                </Link>
              )}
              <span>· {formatDate(session.createdAt, i18n.language)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportButton url={`/api/sessions/${session.id}/export`} />
          <ExportButton
            url={`/api/sessions/${session.id}/export?format=csv&table=results`}
            format="csv"
            label={t('common:csvResults')}
          />
          <ExportButton
            url={`/api/sessions/${session.id}/export?format=csv&table=laps`}
            format="csv"
            label={t('common:csvLaps')}
          />
          <DeleteButton variant="outline" onDelete={handleDelete} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Podium (finished sessions, not balancing) */}
        {session.status === SessionStatus.FINISHED && !isBalancing && session.drivers?.length > 0 && (
          <Card>
            <CardContent className="p-0 overflow-hidden">
              <Podium
                drivers={
                  session.type === SessionType.RACE
                    ? rankedRaceDrivers
                        .filter((driver) => !driver.isDNF)
                        .map((driver) => ({
                          ...driver,
                          totalLaps: driver.classifiedLaps,
                          totalTime:
                            session.tyreMismatchPercent > 0 ? driver.classifiedSimulatedTime : driver.classifiedTime,
                        }))
                    : session.drivers
                }
                sessionType={session.type}
                stats={{
                  duration: sessionDuration ? Math.floor(sessionDuration / 1000) : null,
                  maxDuration: session.maxDuration,
                  maxLaps: session.maxLaps,
                  gracePeriod: session.gracePeriod,
                  gracePeriodUsed: !!session.finishingAt,
                }}
              />
            </CardContent>
          </Card>
        )}

        {/* DNF drivers */}
        {entries.some((e) => e.isDNF) && (
          <div className="flex items-center gap-2 text-sm text-orange-500">
            <Flag className="size-4" />
            DNF :{' '}
            {entries
              .filter((e) => e.isDNF)
              .map((e) => e.driver?.name || `Ctrl ${e.controller + 1}`)
              .join(', ')}
          </div>
        )}

        {/* Main content: Leaderboard or Balancing Chart */}
        {isBalancing ? (
          balancingEntries.some((e) => e.laps.length > 0) ? (
            <BalancingChart entries={balancingEntries} />
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">{t('profile.noLapData')}</CardContent>
            </Card>
          )
        ) : entries.length > 0 ? (
          <SessionLeaderboard
            entries={entries}
            sortBy={session.type === SessionType.RACE ? 'race' : 'bestLap'}
            sessionType={session.type}
            sessionStatus={session.status}
            expanded
          />
        ) : (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">{t('profile.noParticipants')}</CardContent>
          </Card>
        )}

        {/* Observed pit stops */}
        {session.pitStops?.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">{t('profile.pitHistory', { count: session.pitStops.length })}</h3>
              </div>
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground uppercase">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('profile.pitDriver')}</th>
                    <th className="px-4 py-2 font-medium">{t('profile.pitEntered')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('profile.pitDuration')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {session.pitStops.map((stop) => (
                    <tr key={stop.id}>
                      <td className="px-4 py-2">{stop.sessionDriver?.driver?.name || `Ctrl ${stop.controller + 1}`}</td>
                      <td className="px-4 py-2">{new Date(stop.enteredAt).toLocaleTimeString(i18n.language)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">~{(stop.durationMs / 1000).toFixed(1)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {session.tyreChanges?.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">{t('profile.tyreHistory')}</h3>
              </div>
              <ul className="divide-y divide-border">
                {session.tyreChanges.map((change) => {
                  const participant = session.drivers?.find((row) => row.id === change.sessionDriverId)
                  return (
                    <li key={change.id} className="flex justify-between gap-3 px-4 py-2 text-sm">
                      <div>
                        <span className="font-semibold">
                          {participant?.driver?.name || `Ctrl ${change.controller + 1}`}
                        </span>
                        <span className="ml-2">
                          {t(change.fromType === 'wet' ? 'profile.tyreWet' : 'profile.tyreDry')} →{' '}
                          {t(change.toType === 'wet' ? 'profile.tyreWet' : 'profile.tyreDry')}
                        </span>
                        <p className="text-xs text-muted-foreground">
                          {t(change.source === 'simulator' ? 'profile.tyreSimulator' : 'profile.tyreDirector')}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(change.changedAt).toLocaleTimeString(i18n.language)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Audited race penalties; raw lap history below is unchanged. */}
        {session.penalties?.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">{t('profile.penalties', { count: session.penalties.length })}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs text-muted-foreground uppercase">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('profile.pitDriver')}</th>
                      <th className="px-4 py-2 font-medium">{t('profile.penaltyAmount')}</th>
                      <th className="px-4 py-2 font-medium">{t('profile.penaltyReason')}</th>
                      <th className="px-4 py-2 font-medium">{t('profile.penaltyStatus')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {session.penalties.map((penalty) => {
                      const assignment = session.drivers?.find((driver) => driver.id === penalty.sessionDriverId)
                      const value =
                        penalty.kind === PenaltyKind.LAP
                          ? t('profile.penaltyLaps', { count: penalty.amount })
                          : t('profile.penaltyTime', { seconds: penalty.amount / 1000 })
                      return (
                        <tr key={penalty.id}>
                          <td className="px-4 py-2">{assignment?.driver?.name || `Ctrl ${penalty.controller + 1}`}</td>
                          <td className="px-4 py-2 tabular-nums">{value}</td>
                          <td className="px-4 py-2">{penalty.reason}</td>
                          <td className="px-4 py-2">
                            <Badge variant={penalty.status === PenaltyStatus.ACTIVE ? 'default' : 'secondary'}>
                              {t(
                                penalty.status === PenaltyStatus.ACTIVE
                                  ? 'profile.penaltyActive'
                                  : 'profile.penaltyRevoked'
                              )}
                            </Badge>
                            <div className="text-xs text-muted-foreground">
                              {formatDate(penalty.issuedAt, i18n.language)}
                            </div>
                            {penalty.revokedAt && (
                              <div className="text-xs text-muted-foreground">
                                {formatDate(penalty.revokedAt, i18n.language)}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Persisted damage and repair outcomes */}
        {session.drivers?.some((driver) => driver.damageStatus && driver.damageStatus !== 'none') && (
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">{t('profile.damageHistory')}</h3>
              </div>
              <ul className="divide-y divide-border">
                {session.drivers
                  .filter((driver) => driver.damageStatus && driver.damageStatus !== 'none')
                  .map((driver) => (
                    <li key={driver.id} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
                      <div>
                        <p className="font-semibold">{driver.driver?.name || `Ctrl ${driver.controller + 1}`}</p>
                        <p className="text-muted-foreground">
                          {t('profile.damageLap', { lap: driver.damageLapNumber })} ·{' '}
                          {t(`profile.damageStatus.${driver.damageStatus}`)}
                        </p>
                        {driver.damageRepairedAt && (
                          <p className="text-xs text-muted-foreground">
                            {t(
                              driver.damageRepairSource === 'simulator'
                                ? 'profile.damageSimulator'
                                : 'profile.damageDirector'
                            )}
                            {' · '}
                            {new Date(driver.damageRepairedAt).toLocaleTimeString(i18n.language)}
                          </p>
                        )}
                      </div>
                      {driver.damageTriggeredAt && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(driver.damageTriggeredAt).toLocaleTimeString(i18n.language)}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Lap history table */}
        {session.laps?.length > 0 && !isBalancing && (
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold">{t('profile.lapHistory', { count: session.laps.length })}</h3>
              </div>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card border-b border-border">
                    <tr className="text-left text-xs text-muted-foreground uppercase">
                      <th className="px-4 py-2 font-medium">{t('glossary:lap', { count: 1 })}</th>
                      <th className="px-4 py-2 font-medium">{t('glossary:driver', { count: 1 })}</th>
                      <th className="px-4 py-2 font-medium">{t('glossary:car', { count: 1 })}</th>
                      <th className="px-4 py-2 font-medium text-right">{t('profile.time')}</th>
                      {session.tyreMismatchPercent > 0 && (
                        <th className="px-4 py-2 font-medium text-right">{t('profile.simulatedTime')}</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {session.laps.map((lap, i) => {
                      const driver = session.drivers?.find((d) => d.controller === lap.controller)
                      return (
                        <tr key={lap.id || i} className={`${lap.lapTime === fastestLap ? 'bg-purple-500/10' : ''}`}>
                          <td className="px-4 py-1.5 font-mono text-muted-foreground">{lap.lapNumber}</td>
                          <td className="px-4 py-1.5">
                            <div className="flex items-center gap-2">
                              <span
                                className="size-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                                style={{ backgroundColor: driver?.driver?.color || '#6B7280' }}
                              >
                                {(driver?.driver?.name || '?').charAt(0)}
                              </span>
                              <span className="truncate">{driver?.driver?.name || `Ctrl ${lap.controller + 1}`}</span>
                            </div>
                          </td>
                          <td className="px-4 py-1.5 text-muted-foreground truncate">
                            {driver?.car?.brand} {driver?.car?.model}
                          </td>
                          <td className="px-4 py-1.5 text-right">
                            <LapTime time={Math.round(lap.lapTime)} size="sm" highlight={lap.lapTime === fastestLap} />
                          </td>
                          {session.tyreMismatchPercent > 0 && (
                            <td className="px-4 py-1.5 text-right">
                              <LapTime time={lap.simulatedLapTime} size="sm" />
                              {lap.tyreAtLap && (
                                <p className="text-xs text-muted-foreground">
                                  {t(lap.tyreAtLap === 'wet' ? 'profile.tyreWet' : 'profile.tyreDry')} ·{' '}
                                  {t(lap.weatherAtLap === 'rain' ? 'profile.weatherRain' : 'profile.weatherDry')}
                                </p>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
