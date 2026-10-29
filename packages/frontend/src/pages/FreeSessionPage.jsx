import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  PanelRightClose,
  PanelRightOpen,
  FlaskConical,
  Clock,
  Flag,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDevice } from '../context/DeviceContext'
import { useSession } from '../context/SessionContext'
import { useApp } from '../context/AppContext'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import SessionSection from '../components/championship/SessionSection'
import SessionLeaderboard from '../components/race/SessionLeaderboard'
import Soundboard from '../components/race/Soundboard'
import StartingGrid from '../components/race/StartingGrid'
import StandingsTabs from '../components/championship/StandingsTabs'
import { STANDARD_SESSION_TYPES, SessionStatus, SessionType, sessionTypeFullKey } from '@racehubos/shared'

const API_URL = import.meta.env.VITE_API_URL || ''

// Tailwind cannot build class names at runtime, so each type's colour is
// spelled out; the list of types themselves comes from @racehubos/shared
const TAB_STYLE = {
  [SessionType.PRACTICE]: {
    icon: FlaskConical,
    color: 'data-active:!text-session-practice hover:!text-session-practice',
  },
  [SessionType.QUALIF]: { icon: Clock, color: 'data-active:!text-session-qualif hover:!text-session-qualif' },
  [SessionType.RACE]: { icon: Flag, color: 'data-active:!text-session-race hover:!text-session-race' },
}

const emptyStandings = () => Object.fromEntries(STANDARD_SESSION_TYPES.map((type) => [type, []]))
const WIDGETS = ['leaderboard', 'standings']

export default function FreeSessionPage() {
  const { t } = useTranslation('freeSession')
  const { startRace: triggerCuStart } = useDevice()
  const {
    session,
    entries,
    maxLapsCompleted,
    findOrCreateFreeSession,
    createSession,
    loadSession,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    resetSession,
    clearSession,
  } = useSession()

  const [tracks, setTracks] = useState([])
  const [loading, setLoading] = useState(false)
  const {
    showStandings: legacyShowStandings,
    freeTrack: selectedTrackId,
    setFreeTrack: setSelectedTrackId,
    freeType: selectedType,
    setFreeType: setSelectedType,
  } = useApp()
  const [standings, setStandings] = useState(emptyStandings)
  const [practiceSortBy, setPracticeSortBy] = useState('laps')
  const [drivers, setDrivers] = useState([])
  const [cars, setCars] = useState([])
  const [widgetOrder, setWidgetOrder] = useState(() => (legacyShowStandings ? [...WIDGETS] : ['leaderboard']))
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [layoutError, setLayoutError] = useState(null)

  useEffect(() => {
    let active = true
    fetch(`${API_URL}/api/preferences/freeSession:widgets`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error)
        if (active && Array.isArray(result.data)) {
          setWidgetOrder([...new Set(result.data.filter((id) => WIDGETS.includes(id)))])
        }
      })
      .catch(() => {
        if (active) setLayoutError('loadError')
      })
      .finally(() => {
        if (active) setLayoutLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  async function saveWidgetOrder(next) {
    if (!layoutLoaded || layoutBusy) return
    setLayoutBusy(true)
    setLayoutError(null)
    try {
      const res = await fetch(`${API_URL}/api/preferences/freeSession:widgets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      if (!result.success) throw new Error(result.error)
      setWidgetOrder(next)
    } catch {
      setLayoutError('saveError')
    } finally {
      setLayoutBusy(false)
    }
  }

  function toggleWidget(id) {
    saveWidgetOrder(widgetOrder.includes(id) ? widgetOrder.filter((widget) => widget !== id) : [...widgetOrder, id])
  }

  function moveWidget(id, delta) {
    const index = widgetOrder.indexOf(id)
    if (index < 0 || index + delta < 0 || index + delta >= widgetOrder.length) return
    const next = [...widgetOrder]
    const moving = next[index]
    next[index] = next[index + delta]
    next[index + delta] = moving
    saveWidgetOrder(next)
  }

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tracksRes, driversRes, carsRes] = await Promise.all([
          fetch(`${API_URL}/api/tracks`),
          fetch(`${API_URL}/api/drivers`),
          fetch(`${API_URL}/api/cars`),
        ])
        const [tracksData, driversData, carsData] = await Promise.all([
          tracksRes.json(),
          driversRes.json(),
          carsRes.json(),
        ])
        if (tracksData.success && tracksData.data?.length > 0) {
          setTracks(tracksData.data)
          if (!selectedTrackId) setSelectedTrackId(tracksData.data[0].id)
        }
        if (driversData.success) setDrivers(driversData.data || [])
        if (carsData.success) setCars(carsData.data || [])
      } catch (error) {
        console.error('Error fetching data:', error)
      }
    }
    fetchData()
  }, [])

  useEffect(() => {
    if (selectedTrackId && selectedType) handleLoadSession()
  }, [selectedTrackId, selectedType])

  const fetchStandings = useCallback(async () => {
    if (!selectedTrackId) {
      setStandings(emptyStandings())
      return
    }
    try {
      const res = await fetch(`${API_URL}/api/records/track/${selectedTrackId}?championshipId=null`)
      const data = await res.json()
      if (data.success) {
        setStandings({
          practice: (data.data.practice || []).map((lap) => ({ ...lap, bestTime: lap.lapTime })),
          qualif: (data.data.qualif || []).map((lap) => ({ ...lap, bestTime: lap.lapTime })),
          race: (data.data.race || []).map((lap) => ({
            ...lap,
            bestTime: lap.lapTime,
            totalLaps: lap.totalLaps || lap.laps || 0,
            totalTime: lap.totalTime || null,
          })),
        })
      }
    } catch (error) {
      console.error('Error fetching standings:', error)
    }
  }, [selectedTrackId])

  useEffect(() => {
    fetchStandings()
  }, [selectedTrackId])

  // Refetch standings when a session finishes (auto-finish by time/laps)
  useEffect(() => {
    const onFinished = () => fetchStandings()
    window.addEventListener('session:finished', onFinished)
    return () => window.removeEventListener('session:finished', onFinished)
  }, [fetchStandings])

  const handleLoadSession = useCallback(async () => {
    if (!selectedTrackId || !selectedType) return
    const previousDrivers = session?.drivers || []
    setLoading(true)
    try {
      const foundSession = await findOrCreateFreeSession({ trackId: selectedTrackId, type: selectedType })
      if (!foundSession) return

      // If newly created session has no drivers, copy from previous session
      if ((!foundSession.drivers || foundSession.drivers.length === 0) && previousDrivers.length > 0) {
        const driversConfig = previousDrivers.map((sd) => ({
          controller: sd.controller,
          driverId: sd.driverId,
          carId: sd.carId,
        }))
        await fetch(`${API_URL}/api/sessions/${foundSession.id}/drivers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drivers: driversConfig }),
        })
      }
      await loadSession(foundSession.id)
    } catch (error) {
      console.error('Error loading session:', error)
    } finally {
      setLoading(false)
    }
  }, [selectedTrackId, selectedType, session?.drivers, findOrCreateFreeSession, loadSession])

  const handleNewSession = async () => {
    if (!selectedTrackId || !selectedType) return
    setLoading(true)
    try {
      const result = await createSession({
        trackId: selectedTrackId,
        type: selectedType,
        name: t(`glossary:sessionTypeFull.${selectedType}`),
        status: SessionStatus.DRAFT,
        maxDuration: session?.maxDuration || null,
        maxLaps: session?.maxLaps || null,
        gracePeriod: session?.gracePeriod || 30000,
      })
      if (result.success && result.data?.id && session?.drivers?.length > 0) {
        const driversConfig = session.drivers.map((sd) => ({
          controller: sd.controller,
          driverId: sd.driverId,
          carId: sd.carId,
        }))
        await fetch(`${API_URL}/api/sessions/${result.data.id}/drivers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drivers: driversConfig }),
        })
        await loadSession(result.data.id)
      }
    } catch (error) {
      console.error('Error creating session:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleStart = async () => {
    if (!session?.id) return
    return startSession(session.id)
  }
  const handlePause = async () => {
    if (session?.id) await pauseSession(session.id)
  }
  const handleResume = async () => {
    if (session?.id) await resumeSession(session.id)
  }
  const handleStop = async () => {
    if (!session?.id) return
    await stopSession(session.id)
    await fetchStandings()
  }
  const handleSaveConfig = async (data) => {
    if (!session?.id) return
    try {
      if (
        data.name !== undefined ||
        data.maxDuration !== undefined ||
        data.maxLaps !== undefined ||
        data.gracePeriod !== undefined ||
        data.virtualFuelRate !== undefined ||
        data.requiredPitStops !== undefined ||
        data.weatherSeed !== undefined ||
        data.weatherInitial !== undefined ||
        data.weatherRainChance !== undefined ||
        data.weatherIntervalSeconds !== undefined ||
        data.tyreMismatchPercent !== undefined ||
        data.damageLapThresholdMs !== undefined ||
        data.damageRepairSeconds !== undefined ||
        data.damagePitSeconds !== undefined
      ) {
        const response = await fetch(`${API_URL}/api/sessions/${session.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.name,
            maxDuration: data.maxDuration,
            maxLaps: data.maxLaps,
            gracePeriod: data.gracePeriod,
            virtualFuelRate: data.virtualFuelRate,
            requiredPitStops: data.requiredPitStops,
            weatherSeed: data.weatherSeed,
            weatherInitial: data.weatherInitial,
            weatherRainChance: data.weatherRainChance,
            weatherIntervalSeconds: data.weatherIntervalSeconds,
            tyreMismatchPercent: data.tyreMismatchPercent,
            damageLapThresholdMs: data.damageLapThresholdMs,
            damageRepairSeconds: data.damageRepairSeconds,
            damagePitSeconds: data.damagePitSeconds,
          }),
        })
        if (!response.ok) {
          const failure = await response.json()
          return { success: false, error: failure.error || 'Weather configuration could not be saved' }
        }
      }
      if (data.status !== undefined && data.status !== session.status) {
        await fetch(`${API_URL}/api/sessions/${session.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: data.status }),
        })
      }
      if (data.drivers?.length > 0) {
        // Save to current session
        await fetch(`${API_URL}/api/sessions/${session.id}/drivers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drivers: data.drivers }),
        })
        // Sync to other free sessions on same track
        const otherTypes = STANDARD_SESSION_TYPES.filter((type) => type !== selectedType)
        for (const type of otherTypes) {
          const res = await fetch(`${API_URL}/api/sessions?trackId=${selectedTrackId}&type=${type}&championshipId=null`)
          const result = await res.json()
          if (result.success && result.data?.length > 0) {
            const otherSession = [...result.data].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
            if (otherSession.status === SessionStatus.DRAFT) {
              await fetch(`${API_URL}/api/sessions/${otherSession.id}/drivers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ drivers: data.drivers }),
              })
            }
          }
        }
      }
      const reloaded = await loadSession(session.id)
      if ((data.virtualFuelRate !== undefined || data.requiredPitStops !== undefined) && !reloaded?.success)
        return { success: false }
      return { success: true }
    } catch (err) {
      console.error('Error saving session config:', err)
      return { success: false, error: err.message }
    }
  }

  const handleDeleteSession = async (sessionId) => {
    try {
      await fetch(`${API_URL}/api/sessions/${sessionId}`, { method: 'DELETE' })
      clearSession()
      await handleLoadSession()
    } catch (err) {
      console.error('Error deleting session:', err)
    }
  }

  const handleResetSession = async (sessionId) => {
    const result = await resetSession(sessionId)
    if (result.success) await fetchStandings()
  }

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId)
  const isSessionActive =
    session && ['active', 'paused', 'finishing'].includes(session.status) && session.type === selectedType

  // Preserve the existing race-time standings auto-hide without changing the saved preference.
  const visibleWidgets = isSessionActive ? widgetOrder.filter((id) => id !== 'standings') : widgetOrder
  const showSecondWidget = visibleWidgets.length > 1
  const widgetViews = {
    leaderboard:
      session &&
      (maxLapsCompleted === 0 && session.status !== SessionStatus.FINISHED ? (
        <StartingGrid entries={entries} />
      ) : (
        <SessionLeaderboard
          entries={entries}
          expanded={!showSecondWidget}
          sortBy={
            session.type === SessionType.PRACTICE
              ? practiceSortBy
              : session.type === SessionType.QUALIF
                ? 'bestLap'
                : 'race'
          }
          onSortChange={session.type === SessionType.PRACTICE ? setPracticeSortBy : undefined}
          sessionType={session.type}
          sessionStatus={session.status}
        />
      )),
    standings: (
      <>
        <h2 className="text-sm font-semibold mb-3">{t('standings.title')}</h2>
        <StandingsTabs standings={standings} drivers={drivers} activeTab={selectedType} onTabChange={setSelectedType} />
      </>
    ),
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="border-b px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={selectedTrackId || ''} onValueChange={setSelectedTrackId}>
            {/* A long track name ends with an ellipsis instead of being cut mid-letter */}
            <SelectTrigger className="w-48" title={selectedTrack?.name}>
              <SelectValue placeholder={t('topBar.selectTrackPlaceholder')}>
                <span className="min-w-0 truncate">{selectedTrack?.name}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {tracks.map((track) => (
                <SelectItem key={track.id} value={track.id}>
                  {track.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tabs value={selectedType} onValueChange={setSelectedType}>
            <TabsList>
              {STANDARD_SESSION_TYPES.map((type) => {
                const { icon: Icon, color } = TAB_STYLE[type]
                return (
                  <TabsTrigger key={type} value={type} className={color}>
                    <Icon className="size-3.5" />
                    {t(sessionTypeFullKey(type))}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewSession}
            disabled={!selectedTrackId || isSessionActive || loading}
          >
            <Plus className="size-4" />
            {t('topBar.newSession')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleWidget('standings')}
            disabled={!layoutLoaded || layoutBusy || isSessionActive}
            title={
              isSessionActive
                ? t('layout.autoHidden')
                : widgetOrder.includes('standings')
                  ? t('topBar.hideStandings')
                  : t('topBar.showStandings')
            }
            className={widgetOrder.includes('standings') && !isSessionActive ? 'bg-primary/10 text-primary' : ''}
          >
            {widgetOrder.includes('standings') && !isSessionActive ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLayoutOpen((open) => !open)}
            aria-expanded={layoutOpen}
            aria-controls="free-widget-layout"
          >
            <SlidersHorizontal className="size-4" />
            {t('layout.configure')}
          </Button>
        </div>
      </div>

      {layoutOpen && (
        <fieldset
          id="free-widget-layout"
          className="border-b px-4 py-3 space-y-2"
          disabled={!layoutLoaded || layoutBusy}
        >
          <legend className="text-sm font-semibold">{t('layout.title')}</legend>
          <p className="text-xs text-muted-foreground">{t('layout.pinned')}</p>
          <div className="flex flex-wrap gap-3">
            {[...widgetOrder, ...WIDGETS.filter((id) => !widgetOrder.includes(id))].map((id) => {
              const index = widgetOrder.indexOf(id)
              const disabled = id === 'standings' && isSessionActive
              return (
                <div key={id} className="flex items-center gap-2 rounded-lg border px-2 py-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={index !== -1}
                      disabled={disabled}
                      onChange={() => toggleWidget(id)}
                    />
                    {t(`layout.widgets.${id}`)}
                  </label>
                  {index !== -1 && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={disabled || index === 0}
                        aria-label={t('layout.moveUp', { widget: t(`layout.widgets.${id}`) })}
                        onClick={() => moveWidget(id, -1)}
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={disabled || index === widgetOrder.length - 1}
                        aria-label={t('layout.moveDown', { widget: t(`layout.widgets.${id}`) })}
                        onClick={() => moveWidget(id, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          {isSessionActive && <p className="text-xs text-muted-foreground">{t('layout.autoHidden')}</p>}
        </fieldset>
      )}
      {layoutError && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {t(`layout.${layoutError}`)}
        </p>
      )}

      {/* Main content */}
      <div className="@container flex-1 overflow-auto p-4">
        <Soundboard />
        <div className={`grid grid-cols-1 ${showSecondWidget ? '@4xl:grid-cols-3' : ''} gap-4`}>
          <div className={`${showSecondWidget ? '@4xl:col-span-2' : ''} space-y-4`}>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full size-10 border-b-2 border-primary" />
              </div>
            ) : (
              <>
                <SessionSection
                  session={session}
                  sessions={[]}
                  drivers={drivers}
                  cars={cars}
                  onStart={handleStart}
                  onPause={handlePause}
                  onResume={handleResume}
                  onStop={handleStop}
                  onTriggerCuStart={triggerCuStart}
                  onSaveConfig={handleSaveConfig}
                  onDelete={handleDeleteSession}
                  onReset={handleResetSession}
                />
                {visibleWidgets[0] && (
                  <section data-testid={`free-widget-${visibleWidgets[0]}`}>{widgetViews[visibleWidgets[0]]}</section>
                )}
              </>
            )}
          </div>
          {visibleWidgets[1] && (
            <section data-testid={`free-widget-${visibleWidgets[1]}`}>{widgetViews[visibleWidgets[1]]}</section>
          )}
        </div>
      </div>
    </div>
  )
}
