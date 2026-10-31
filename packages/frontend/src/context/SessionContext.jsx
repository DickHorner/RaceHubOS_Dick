import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { io } from 'socket.io-client'
import { useApp } from './AppContext'
import { useVoice } from './VoiceContext'
import { SessionStatus, SessionType, rankRaceDrivers, qualifyingLapTime } from '@racehubos/shared'
import i18n from '../i18n'
import { sessionNames } from '../lib/sessionNames'
import { beginStartTrace, traceStart } from '../lib/startTrace'

const API_URL = import.meta.env.VITE_API_URL || ''
const WS_URL = import.meta.env.VITE_WS_URL || ''

export const SESSION_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  FINISHING: 'finishing',
  FINISHED: 'finished',
}

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const { setSessionActive } = useApp()
  const voice = useVoice()

  // Current session
  const [session, setSession] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])

  // Timing
  const [elapsed, setElapsed] = useState(0)
  const [remaining, setRemaining] = useState(null)
  const [gracePeriodRemaining, setGracePeriodRemaining] = useState(null)
  const [pauseDuration, setPauseDuration] = useState(null)
  const [totalPauseDuration, setTotalPauseDuration] = useState(0)
  const [pauses, setPauses] = useState([])
  const [startedAt, setStartedAt] = useState(null)

  // Session lifecycle
  const [finishingSession, setFinishingSession] = useState(null)
  const [sessionResults, setSessionResults] = useState(null)

  // Data freshness
  const [lastServerTime, setLastServerTime] = useState(null)
  const [isStale, setIsStale] = useState(false)

  // Socket ref
  const socketRef = useRef(null)

  // Ref for voice access from socket listeners
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const announcedRef = useRef({ start: new Set(), finish: new Set(), leader: new Map(), startTimes: new Map() })
  const pendingRaceVoiceRef = useRef({ start: null, finish: null })
  const { raceEvents, raceEventsLoaded, announceRaceEvent } = voice

  useEffect(() => {
    if (!raceEventsLoaded) return

    const pending = pendingRaceVoiceRef.current
    const start = pending.start
    const finish = pending.finish
    pending.start = null
    pending.finish = null

    if (window.location.pathname.startsWith('/display/')) return
    if (
      start &&
      raceEvents.start &&
      sessionRef.current?.id === start.sessionId &&
      sessionRef.current.status === SessionStatus.ACTIVE
    ) {
      void announceRaceEvent(`start:${start.key}`, i18n.t('voice:raceStarted'))
    }
    if (finish && raceEvents.finish && sessionRef.current?.id === finish.sessionId) {
      void announceRaceEvent(`finish:${finish.key}`, i18n.t('voice:raceFinished'))
    }
  }, [raceEventsLoaded, raceEvents, announceRaceEvent])

  // Check data freshness
  useEffect(() => {
    const interval = setInterval(() => {
      if (!lastServerTime) {
        setIsStale(false)
        return
      }
      const age = Date.now() - new Date(lastServerTime).getTime()
      setIsStale(age > 2000)
    }, 500)
    return () => clearInterval(interval)
  }, [lastServerTime])

  // Initialize socket
  useEffect(() => {
    const socket = io(WS_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    })
    socketRef.current = socket

    // Only announce an observed change from one unambiguous race leader to another.
    socket.on('session:leaderboard', (data) => {
      const rows = Array.isArray(data) ? data : data?.leaderboard
      const race = sessionRef.current
      if (
        race?.type === SessionType.RACE &&
        race.status === SessionStatus.ACTIVE &&
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.every((row) => row?.sessionId === race.id)
      ) {
        const leaders = rows.filter((row) => row.position === 1)
        const next =
          leaders.length === 1 && leaders[0].id && leaders[0].driver?.name && leaders[0].totalLaps > 0
            ? leaders[0]
            : null
        const previous = announcedRef.current.leader.get(race.id)
        if (next && (!previous || next.id === previous.id || next.totalLaps > previous.laps)) {
          if (
            previous &&
            previous.id !== next.id &&
            next.totalLaps > previous.laps &&
            voiceRef.current.raceEventsRef.current.leader &&
            !window.location.pathname.startsWith('/display/')
          ) {
            const epoch = announcedRef.current.startTimes.get(race.id) || race.startedAt || ''
            void voiceRef.current.announceRaceEvent(
              `leader:${race.id}:${epoch}:${next.id}:${next.totalLaps}`,
              i18n.t('voice:leaderChange', { name: next.driver.name })
            )
          }
          announcedRef.current.leader.set(race.id, { id: next.id, laps: next.totalLaps })
        }
      }

      if (Array.isArray(data)) {
        setLeaderboard(data)
      } else if (data.leaderboard && Array.isArray(data.leaderboard)) {
        setLeaderboard(data.leaderboard)
      }
    })

    // Session updates
    socket.on('race:session', (data) => {
      setSession(data)
    })

    // Session status changes
    socket.on('session:penalties_changed', (data) => {
      window.dispatchEvent(new CustomEvent('session:penalties_changed', { detail: data }))
    })

    socket.on('session:status_changed', (data) => {
      if (data.sessionId && data.status) {
        setSession((prev) => (prev?.id === data.sessionId ? { ...prev, status: data.status } : prev))
      }
      if (data.timestamp) setLastServerTime(data.timestamp)
      window.dispatchEvent(new CustomEvent('session:status_changed', { detail: data }))
    })

    socket.on('session:vsc', (data) => {
      window.dispatchEvent(new CustomEvent('session:vsc', { detail: data }))
    })
    socket.on('session:vsc_error', (data) => {
      window.dispatchEvent(new CustomEvent('session:vsc_error', { detail: data }))
    })
    socket.on('session:tyre_changed', (data) => {
      window.dispatchEvent(new CustomEvent('session:tyre_changed', { detail: data }))
    })

    socket.on('session:damage_changed', (data) => {
      window.dispatchEvent(new CustomEvent('session:damage_changed', { detail: data }))
    })
    socket.on('session:damage_error', (data) => {
      window.dispatchEvent(new CustomEvent('session:damage_error', { detail: data }))
    })
    socket.on('session:pit_stop', (data) => {
      window.dispatchEvent(new CustomEvent('session:pit_stop', { detail: data }))
    })

    // Session finishing
    socket.on('session:finishing', (data) => {
      setFinishingSession({
        sessionId: data.sessionId,
        endsAt: data.endsAt,
        gracePeriodMs: data.gracePeriodMs,
        reason: data.reason,
      })
    })

    socket.on('session:race_started', (data) => {
      if (sessionRef.current?.id !== data?.sessionId || sessionRef.current.type !== SessionType.RACE || !data.startedAt)
        return
      const key = `${data.sessionId}:${data.startedAt}`
      if (announcedRef.current.start.has(key)) return
      announcedRef.current.start.add(key)
      announcedRef.current.startTimes.set(data.sessionId, data.startedAt)
      announcedRef.current.leader.delete(data.sessionId)
      if (window.location.pathname.startsWith('/display/')) return
      const v = voiceRef.current
      if (!v.raceEventsLoaded) {
        pendingRaceVoiceRef.current.start = { sessionId: data.sessionId, key }
      } else if (v.raceEvents.start) {
        void v.announceRaceEvent(`start:${key}`, i18n.t('voice:raceStarted'))
      }
    })

    // Session finished
    socket.on('session:finished', (data) => {
      const finishKey = `${data.sessionId}:${data.startedAt || ''}`
      const firstFinish = !announcedRef.current.finish.has(finishKey)
      announcedRef.current.finish.add(finishKey)
      setSession((prev) => {
        if (prev?.id !== data.sessionId) return prev
        const drivers = data.leaderboard?.length > 0 ? data.leaderboard : prev.drivers
        return {
          ...prev,
          status: SessionStatus.FINISHED,
          drivers,
          weatherCondition: data.weatherCondition ?? prev.weatherCondition,
        }
      })
      setFinishingSession(null)
      // Keep final leaderboard
      if (data.leaderboard && Array.isArray(data.leaderboard)) {
        setLeaderboard(data.leaderboard)
      }
      setSessionResults({
        sessionId: data.sessionId,
        championshipId: data.championshipId,
        reason: data.reason,
      })
      window.dispatchEvent(new CustomEvent('session:finished', { detail: data }))

      // Spectator screens and repeated socket events must not play race audio.
      if (!firstFinish || window.location.pathname.startsWith('/display/')) return

      // Skip podium/voice for balancing sessions
      if (data.sessionType === SessionType.BALANCING) return

      // Play finish music then announce podium
      try {
        const v = voiceRef.current
        const announceFinish =
          data.sessionType === SessionType.RACE && data.startedAt
            ? () => {
                const currentVoice = voiceRef.current
                if (!currentVoice.raceEventsLoaded) {
                  pendingRaceVoiceRef.current.finish = { sessionId: data.sessionId, key: finishKey }
                } else if (currentVoice.raceEvents.finish) {
                  void currentVoice.announceRaceEvent(`finish:${finishKey}`, i18n.t('voice:raceFinished'))
                }
              }
            : null
        const audio = new Audio('/sounds/race-finish.mp3')
        audio.volume = 0.7
        const hasPodium = v.podiumEnabledRef.current && data.leaderboard?.length > 0
        if (!hasPodium && announceFinish) {
          audio.onended = announceFinish
          audio.onerror = announceFinish
        }
        audio.play().catch(() => {
          if (!hasPodium) announceFinish?.()
        })

        if (hasPodium) {
          const isQualif = data.sessionType === SessionType.QUALIF
          const sorted = [...data.leaderboard]
            .filter((d) => d.driver && (d.totalLaps > 0 || d.bestLapTime))
            .sort((a, b) => {
              if (data.fuelWeightPercent > 0)
                return (a.position ?? a.finalPos ?? Infinity) - (b.position ?? b.finalPos ?? Infinity)
              if (isQualif) return (a.bestLapTime || Infinity) - (b.bestLapTime || Infinity)
              if ((b.totalLaps || 0) !== (a.totalLaps || 0)) return (b.totalLaps || 0) - (a.totalLaps || 0)
              return (a.totalTime || Infinity) - (b.totalTime || Infinity)
            })
          const allLabels = ['first', 'second', 'third'].map((rank) => i18n.t(`voice:ranks.${rank}`))
          const podium = sorted.slice(0, 3).map((driver, i) => ({ driver, label: allLabels[i] }))

          // Announce 3rd, 2nd, 1st
          const announceOrder = [...podium].reverse()

          const delay = 3000
          setTimeout(() => {
            const queue = []
            announceOrder.forEach(({ driver, label }) => {
              if (!driver.driver) return
              const name = driver.driver.name
              const time = isQualif
                ? v.formatTimeVoice(qualifyingLapTime(driver, data.fuelWeightPercent))
                : v.formatTimeVoice(
                    data.fuelWeightPercent > 0
                      ? (driver.classifiedSimulatedTime ?? driver.simulatedTotalTime)
                      : driver.totalTime
                  )
              queue.push(i18n.t('voice:podium', { rank: label, name, time }))
            })

            const speakNext = (index) => {
              if (index >= queue.length) {
                announceFinish?.()
                return
              }
              const utterance = v.speak(queue[index], { rate: 1.0, force: true })
              if (utterance) utterance.onend = () => setTimeout(() => speakNext(index + 1), 500)
              else speakNext(index + 1)
            }
            speakNext(0)
          }, delay)
        }
      } catch {}
    })

    // Real-time positions
    socket.on('positions:updated', (positions) => {
      if (Array.isArray(positions)) {
        setLeaderboard(positions)
      }
    })

    // Heartbeat (timing updates + leaderboard)
    socket.on('session:heartbeat', (data) => {
      setLastServerTime(new Date().toISOString())
      if (data.elapsedTime !== undefined) setElapsed(Math.floor(data.elapsedTime / 1000))
      if (data.remainingTime !== undefined) setRemaining(Math.floor(data.remainingTime / 1000))
      if (data.gracePeriodRemaining !== undefined) {
        setGracePeriodRemaining(data.gracePeriodRemaining > 0 ? Math.ceil(data.gracePeriodRemaining / 1000) : null)
      }
      setPauseDuration(data.pauseDuration ? Math.floor(data.pauseDuration / 1000) : null)
      setTotalPauseDuration(data.totalPauseDuration ? Math.floor(data.totalPauseDuration / 1000) : 0)
      setPauses(data.pauses || [])
      if (data.startedAt) setStartedAt(data.startedAt)
      if (data.weatherCondition !== undefined) {
        setSession((prev) => {
          if (!prev || prev.id !== data.sessionId || prev.weatherCondition === data.weatherCondition) return prev
          return { ...prev, weatherCondition: data.weatherCondition }
        })
      }
      // Update leaderboard from heartbeat (ensures data sync on refresh)
      if (data.leaderboard && Array.isArray(data.leaderboard)) {
        setLeaderboard(data.leaderboard)
      }
    })

    // Best lap voice announcement (skip for balancing)
    socket.on('session:bestlap', (data) => {
      if (window.location.pathname.startsWith('/display/')) return
      if (data.sessionType === SessionType.BALANCING) return
      const v = voiceRef.current
      if (!v.bestLapEnabledRef.current) return
      if (data.maxLapsCompleted < v.minLapsRef.current) return

      const name =
        data.driverName ||
        [data.carBrand, data.carModel].filter(Boolean).join(' ') ||
        i18n.t('voice:car', { number: data.controller + 1 })
      v.speak(i18n.t('voice:bestLap', { name, time: v.formatTimeVoice(data.lapTime) }))
    })

    // Championship events
    socket.on('championship:standings_changed', (data) => {
      window.dispatchEvent(new CustomEvent('championship:standings_changed', { detail: data }))
    })

    socket.on('championship:races_assigned', (data) => {
      window.dispatchEvent(new CustomEvent('championship:races_assigned', { detail: data }))
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  // ==================== Session API ====================

  // Fetch session by ID
  const fetchSession = useCallback(async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}`)
      const data = await response.json()
      if (data.success) {
        setSession(data.data)
        return data.data
      }
      return null
    } catch (error) {
      console.error('[SessionContext] Error fetching session:', error)
      return null
    }
  }, [])

  // Find or create free session (no championship)
  const findOrCreateFreeSession = useCallback(async ({ trackId, type, autoCreate = true }) => {
    try {
      const searchParams = new URLSearchParams({
        trackId,
        type,
        championshipId: 'null',
      })
      const searchRes = await fetch(`${API_URL}/api/sessions?${searchParams}`)
      const searchData = await searchRes.json()

      if (searchData.success && searchData.data?.length > 0) {
        // Return most recent session (sorted by createdAt desc)
        const sorted = [...searchData.data].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        const latestSession = sorted[0]
        setSession(latestSession)
        return latestSession
      }

      // Create new session only if autoCreate is true
      if (!autoCreate) {
        setSession(null)
        return null
      }

      const createRes = await fetch(`${API_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId, type, name: sessionNames()[type], status: SessionStatus.DRAFT }),
      })
      const createData = await createRes.json()

      if (createData.success) {
        setSession(createData.data)
        return createData.data
      }

      return null
    } catch (error) {
      console.error('[SessionContext] Error finding/creating free session:', error)
      return null
    }
  }, [])

  // Create a new session
  const createSession = useCallback(async (params) => {
    try {
      const { championshipId, ...sessionParams } = params
      const url = championshipId ? `${API_URL}/api/championships/${championshipId}/sessions` : `${API_URL}/api/sessions`

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionParams),
      })
      const data = await response.json()

      if (data.success) {
        setSession(data.data)
      }
      return data
    } catch (error) {
      console.error('[SessionContext] Error creating session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Load session - fetch data and optionally load into SyncService
  const loadSession = useCallback(async (sessionId) => {
    if (!sessionId) return { success: false, error: 'No session ID' }

    // Only clear data when switching to a different session
    setSession((prev) => {
      if (prev?.id !== sessionId) {
        setLeaderboard([])
        setElapsed(0)
        setRemaining(null)
        setGracePeriodRemaining(null)
        setStartedAt(null)
        setPauses([])
      }
      return prev
    })

    try {
      // First, get session data
      const sessionRes = await fetch(`${API_URL}/api/sessions/${sessionId}`)
      const sessionData = await sessionRes.json()

      if (!sessionRes.ok || !sessionData.success) {
        console.warn('[SessionContext] Fetch session failed:', sessionData.error)
        return { success: false, error: sessionData.error }
      }

      const sessionInfo = sessionData.data
      setSession(sessionInfo)

      // Initialize timing state from session data
      setStartedAt(sessionInfo.startedAt || null)
      if (sessionInfo.pauses) {
        const pausesData = typeof sessionInfo.pauses === 'string' ? JSON.parse(sessionInfo.pauses) : sessionInfo.pauses
        setPauses(pausesData)
        const totalPause = pausesData.reduce((sum, p) => {
          if (p.end) return sum + (p.end - p.start)
          return sum
        }, 0)
        setTotalPauseDuration(Math.floor(totalPause / 1000))
      } else {
        setPauses([])
        setTotalPauseDuration(0)
      }
      if (!sessionInfo.startedAt) {
        setElapsed(0)
        setRemaining(null)
        setGracePeriodRemaining(null)
        setFinishingSession(null)
      }

      // For draft/active sessions, load into SyncService
      if (['draft', 'active', 'paused'].includes(sessionInfo.status)) {
        await fetch(`${API_URL}/api/sync/load-session/${sessionId}`, { method: 'POST' })
      }

      // Fetch leaderboard with gaps calculated by backend
      const lbRes = await fetch(`${API_URL}/api/sessions/${sessionId}/leaderboard`)
      const lbData = await lbRes.json()
      if (lbData.success && Array.isArray(lbData.data)) {
        setLeaderboard(lbData.data)
      }

      return { success: true, session: sessionInfo }
    } catch (error) {
      console.error('[SessionContext] Error loading session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Start session
  const startSession = useCallback(async (sessionId) => {
    beginStartTrace(sessionId)
    try {
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}/start`, {
        method: 'POST',
      })
      traceStart('http:response', { status: response.status })
      const data = await response.json()
      if (!data.success) traceStart('failed')

      if (data.success) {
        setSession(data.data)
      }
      return data
    } catch (error) {
      traceStart('failed')
      console.error('[SessionContext] Error starting session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Pause session
  const pauseSession = useCallback(async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}/pause`, {
        method: 'POST',
      })
      const data = await response.json()

      if (data.success) {
        setSession(data.data)
      }
      return data
    } catch (error) {
      console.error('[SessionContext] Error pausing session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Resume session
  const resumeSession = useCallback(async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}/resume`, {
        method: 'POST',
      })
      const data = await response.json()

      if (data.success) {
        setSession(data.data)
      }
      return data
    } catch (error) {
      console.error('[SessionContext] Error resuming session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Stop session
  const stopSession = useCallback(async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}/stop`, {
        method: 'POST',
      })
      const data = await response.json()

      if (data.success) {
        setSession(data.data)
      }
      return data
    } catch (error) {
      console.error('[SessionContext] Error stopping session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Reset session
  const resetSession = useCallback(async (sessionId) => {
    try {
      const response = await fetch(`${API_URL}/api/sessions/${sessionId}/reset`, {
        method: 'POST',
      })
      const data = await response.json()

      if (data.success) {
        setSession(data.data)
        setLeaderboard([])
        setElapsed(0)
        setRemaining(null)
        setGracePeriodRemaining(null)
        setStartedAt(null)
        setPauses([])
        setTotalPauseDuration(0)
        setFinishingSession(null)
        setSessionResults(null)
      }
      return data
    } catch (error) {
      console.error('[SessionContext] Error resetting session:', error)
      return { success: false, error: error.message }
    }
  }, [])

  // Clear current session
  const clearSession = useCallback(() => {
    setSession(null)
    setLeaderboard([])
    setElapsed(0)
    setRemaining(null)
    setGracePeriodRemaining(null)
    setStartedAt(null)
    setPauses([])
    setSessionResults(null)
    setFinishingSession(null)
  }, [])

  // Clear session results
  const clearSessionResults = useCallback(() => {
    setSessionResults(null)
  }, [])

  // ==================== Helpers ====================

  const isActive = session?.status === SessionStatus.ACTIVE
  const isFinishing = session?.status === SessionStatus.FINISHING
  const isFinished = session?.status === SessionStatus.FINISHED

  // Notify AppContext of session active state
  useEffect(() => {
    setSessionActive(
      ['active', 'paused', 'finishing'].includes(session?.status) && session?.type !== SessionType.BALANCING
    )
  }, [session?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // ==================== Computed Data ====================

  // Transform leaderboard to entries with computed fields
  // Falls back to session drivers if leaderboard is empty
  const entries = useMemo(() => {
    // A finished scoreboard must keep its own saved results, not a newer session's live leaderboard.
    const source =
      session?.status === SessionStatus.FINISHED && session.drivers?.length > 0
        ? session.drivers
        : leaderboard.length > 0
          ? leaderboard
          : session?.drivers || []
    if (source.length === 0) return []
    const rankedSource =
      session?.status === SessionStatus.FINISHED && session?.type === SessionType.RACE
        ? rankRaceDrivers(source, session.penalties || [])
        : source

    // Find fastest lap
    const allBestLaps = source.map((p) => p.bestLapTime).filter((t) => t && t > 0)
    const fastestLapTime = allBestLaps.length > 0 ? Math.min(...allBestLaps) : null

    return rankedSource
      .map((p, index) => ({
        id: p.id,
        controller: p.controller,
        driver: p.driver,
        car: p.car,
        gridPos: p.gridPos ?? null,
        damageStatus: p.damageStatus,
        damageLapNumber: p.damageLapNumber,
        damageTriggeredAt: p.damageTriggeredAt,
        damageDeadlineElapsedMs: p.damageDeadlineElapsedMs,
        damageRepairedAt: p.damageRepairedAt,
        damageRepairSource: p.damageRepairSource,
        tyreType: p.tyreType,
        pendingTyreType: p.pendingTyreType,
        simulatedTotalTime: p.simulatedTotalTime,
        simulatedBestLapTime: p.simulatedBestLapTime,
        virtualFuelUnits: p.virtualFuelUnits ?? null,
        totalLaps: p.totalLaps ?? null,
        stats: {
          laps: p.classifiedLaps ?? p.totalLaps ?? 0,
          bestLap: p.bestLapTime || null,
          rankBestLap: qualifyingLapTime(p, session?.fuelWeightPercent) ?? Infinity,
          lastLap: p.lastLapTime || null,
          totalTime: p.classifiedTime ?? p.totalTime ?? 0,
          rankTime: p.classifiedSimulatedTime,
          simulatedTotalTime: p.simulatedTotalTime,
          simulatedBestLapTime: p.simulatedBestLapTime,
          gap: p.gap ?? null,
        },
        penaltyLaps: p.penaltyLaps || 0,
        penaltyTimeMs: p.penaltyTimeMs || 0,
        position: rankedSource !== source ? index + 1 : p.position || 0,
        positionDelta: p.positionDelta || 0, // From backend
        hasFastestLap: fastestLapTime && p.bestLapTime === fastestLapTime,
        isDNF: p.isDNF || false,
        laps: p.laps || [], // Lap history for balancing chart
      }))
      .sort((a, b) => (a.position || 99) - (b.position || 99))
  }, [leaderboard, session])

  // Max laps completed
  const maxLapsCompleted = useMemo(() => {
    return Math.max(0, ...leaderboard.map((p) => p.totalLaps || 0))
  }, [leaderboard])

  // Fastest lap time
  const fastestLap = useMemo(() => {
    const times = leaderboard.map((p) => p.bestLapTime).filter((t) => t && t > 0)
    return times.length > 0 ? Math.min(...times) : null
  }, [leaderboard])

  const value = {
    // Session state
    session,
    setSession,
    leaderboard,
    entries,
    maxLapsCompleted,
    fastestLap,
    elapsed,
    remaining,
    gracePeriodRemaining,
    pauseDuration,
    totalPauseDuration,
    pauses,
    startedAt,
    finishingSession,
    sessionResults,

    // Data freshness
    lastServerTime,
    isStale,

    // Session actions
    fetchSession,
    findOrCreateFreeSession,
    createSession,
    loadSession,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    resetSession,
    clearSession,
    clearSessionResults,

    // Helpers
    isActive,
    isFinishing,
    isFinished,

    // Constants
    SESSION_STATUS,
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  return context
}

export default SessionContext
