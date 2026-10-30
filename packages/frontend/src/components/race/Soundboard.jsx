import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Mic2,
  Music2,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useVoice } from '../../context/VoiceContext'
import { io } from 'socket.io-client'
import { AUTO_CUE_TYPES, autoCueKey, autoSpeechText } from '../../lib/soundboardAuto'

const API_URL = import.meta.env.VITE_API_URL || ''
const WS_URL = import.meta.env.VITE_WS_URL || ''
const PREF_KEY = 'soundboard:presets'
const AUTO_PREF_KEY = 'soundboard:auto'
const AUTO_HISTORY_KEY = 'racehubos-soundboard-auto-history'
const AUDIO_URL = /^\/api\/upload\/sounds\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(mp3|ogg|wav)$/
const PAD_STYLES = [
  'border-rose-500/50 bg-rose-500/15 hover:bg-rose-500/25',
  'border-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25',
  'border-sky-500/50 bg-sky-500/15 hover:bg-sky-500/25',
  'border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25',
  'border-violet-500/50 bg-violet-500/15 hover:bg-violet-500/25',
  'border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25',
]

function validPreset(preset) {
  return (
    preset &&
    typeof preset.id === 'string' &&
    typeof preset.label === 'string' &&
    preset.label.length > 0 &&
    preset.label.length <= 60 &&
    ((preset.kind === 'speech' &&
      typeof preset.text === 'string' &&
      preset.text.length > 0 &&
      preset.text.length <= 300) ||
      (preset.kind === 'clip' && typeof preset.url === 'string' && AUDIO_URL.test(preset.url)))
  )
}

export default function Soundboard({
  directorKey = '',
  allowDirectorWithoutKey = false,
  operatorOnly = false,
  defaultOpen = false,
}) {
  const { t } = useTranslation('soundboard')
  const { speak, formatTimeVoice } = useVoice()
  const directorAccess = Boolean(directorKey || allowDirectorWithoutKey)
  const [open, setOpen] = useState(directorAccess || defaultOpen)
  const [presets, setPresets] = useState([])
  const [autoMappings, setAutoMappings] = useState({})
  const [autoLoaded, setAutoLoaded] = useState(false)
  const [autoPreview, setAutoPreview] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('speech')
  const [speechText, setSpeechText] = useState('')
  const [file, setFile] = useState(null)
  const [volume, setVolume] = useState(0.9)
  const [muted, setMuted] = useState(false)
  const [playingId, setPlayingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('local')
  const [remoteReady, setRemoteReady] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState('')
  const [receiverState, setReceiverState] = useState('off')
  const [error, setError] = useState('')
  const audioRef = useRef(null)
  const playTokenRef = useRef(0)
  const receiverSocketRef = useRef(null)
  const receiverWantedRef = useRef(false)
  const playbackRef = useRef(null)
  const receivedRef = useRef(new Map())
  const autoQueueRef = useRef([])
  const autoRunningRef = useRef(false)
  const autoPendingRef = useRef(new Set())
  const autoGenerationRef = useRef(0)
  const autoSeenRef = useRef(new Set())
  const mutedRef = useRef(muted)
  const playbackDoneRef = useRef(null)
  mutedRef.current = muted

  useEffect(() => {
    let active = true
    fetch(`${API_URL}/api/preferences/${PREF_KEY}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((result) => {
        if (!result.success) throw new Error(result.error)
        if (active && Array.isArray(result.data)) setPresets(result.data.filter(validPreset).slice(0, 32))
      })
      .catch(() => {
        if (active) setError(t('loadError'))
      })
    fetch(`${API_URL}/api/preferences/${AUTO_PREF_KEY}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((result) => {
        if (active && result.success && result.data && typeof result.data === 'object') {
          setAutoMappings(
            Object.fromEntries(
              AUTO_CUE_TYPES.filter((type) => typeof result.data[type] === 'string').map((type) => [
                type,
                result.data[type],
              ])
            )
          )
        }
      })
      .catch(() => {
        if (active) setError(t('loadError'))
      })
      .finally(() => {
        if (active) setAutoLoaded(true)
      })
    return () => {
      active = false
      audioRef.current?.pause()
    }
  }, [t])

  useEffect(() => {
    playbackRef.current = { playPreset, stopPlayback, handleAutoCue, cancelAuto }
  })

  useEffect(() => {
    if (directorAccess || target !== 'director') return
    let active = true
    async function check() {
      try {
        const response = await fetch(`${API_URL}/api/race-control/soundboard/status`)
        const status = await response.json()
        if (active) setRemoteReady(response.ok && status.ready === true)
      } catch {
        if (active) setRemoteReady(false)
      }
    }
    check()
    const interval = setInterval(check, 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [directorAccess, target])

  useEffect(() => {
    return () => {
      receiverWantedRef.current = false
      receiverSocketRef.current?.disconnect()
    }
  }, [])

  async function sendRemote(action, preset = null) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const requestId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    const response = await fetch(`${API_URL}/api/race-control/soundboard/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, ...(preset ? { presetId: preset.id } : {}) }),
    })
    const result = await response.json()
    if (!response.ok || !result.success) throw new Error(result.error || t('remoteError'))
    return result
  }

  async function playSelected(preset) {
    if (muted || busy) return
    cancelAuto()
    if (operatorOnly || directorAccess || target === 'local') {
      await playPreset(preset)
      return
    }
    stopPlayback()
    setError('')
    setRemoteStatus('')
    setPlayingId(preset.id)
    const token = playTokenRef.current
    try {
      await sendRemote('play', preset)
      if (playTokenRef.current === token) setRemoteStatus(t('remoteStarted'))
    } catch (cause) {
      if (playTokenRef.current !== token) return
      setPlayingId(null)
      setRemoteStatus('')
      setError(cause.message || t('remoteError'))
    }
  }

  async function stopSelected() {
    cancelAuto()
    const remotelyPlaying = !operatorOnly && !directorAccess && target === 'director'
    stopPlayback()
    setRemoteStatus('')
    if (!remotelyPlaying) return
    try {
      await sendRemote('stop')
    } catch (cause) {
      setError(cause.message || t('remoteError'))
    }
  }

  function disableReceiver() {
    cancelAuto()
    receiverWantedRef.current = false
    const socket = receiverSocketRef.current
    receiverSocketRef.current = null
    if (socket?.connected) {
      fetch(`${API_URL}/api/race-control/director/soundboard/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
        body: JSON.stringify({ socketId: socket.id }),
      }).catch(() => {})
    }
    socket?.disconnect()
    stopPlayback()
    setReceiverState('off')
  }

  async function enableReceiver() {
    if (!directorAccess || receiverWantedRef.current) return
    setError('')
    try {
      if (window.AudioContext) {
        const audioContext = new AudioContext()
        await audioContext.resume()
        await audioContext.close()
      }
    } catch {
      setError(t('unlockError'))
      return
    }
    receiverWantedRef.current = true
    setReceiverState('connecting')
    const socket = io(WS_URL, { transports: ['websocket', 'polling'], reconnection: true })
    receiverSocketRef.current = socket
    socket.on('connect', async () => {
      if (!receiverWantedRef.current) return
      try {
        const response = await fetch(`${API_URL}/api/race-control/director/soundboard/receiver`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
          body: JSON.stringify({ socketId: socket.id }),
        })
        const result = await response.json()
        if (!response.ok || !result.success) throw new Error(result.error || t('receiverError'))
        if (receiverWantedRef.current) setReceiverState('ready')
        else {
          fetch(`${API_URL}/api/race-control/director/soundboard/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorKey}` },
            body: JSON.stringify({ socketId: socket.id }),
          }).catch(() => {})
        }
      } catch (cause) {
        if (!receiverWantedRef.current) return
        setError(cause.message || t('receiverError'))
        setReceiverState('error')
        receiverWantedRef.current = false
        socket.disconnect()
      }
    })
    socket.on('disconnect', () => {
      if (receiverWantedRef.current) setReceiverState('offline')
    })
    socket.on('soundboard:deactivate', () => {
      if (!receiverWantedRef.current) return
      disableReceiver()
      setError(t('receiverReplaced'))
    })
    socket.on('soundboard:play', async (data, acknowledge) => {
      if (!receiverWantedRef.current || !validPreset(data?.preset) || typeof data.requestId !== 'string') {
        acknowledge?.({ status: 'blocked' })
        return
      }
      let outcome = receivedRef.current.get(data.requestId)
      if (!outcome) {
        playbackRef.current.cancelAuto()
        outcome = playbackRef.current.playPreset(data.preset)
        receivedRef.current.set(data.requestId, outcome)
        if (receivedRef.current.size > 64) receivedRef.current.delete(receivedRef.current.keys().next().value)
      }
      acknowledge?.(await outcome)
    })
    socket.on('soundboard:stop', (data, acknowledge) => {
      playbackRef.current.cancelAuto()
      playbackRef.current.stopPlayback()
      acknowledge?.({ status: 'stopped' })
    })
    socket.on('soundboard:auto', ({ type, data } = {}) => {
      void playbackRef.current.handleAutoCue(type, data)
    })
  }

  function cancelAuto() {
    autoGenerationRef.current += 1
    autoQueueRef.current = []
  }

  async function runAutoQueue() {
    if (autoRunningRef.current) return
    autoRunningRef.current = true
    try {
      while (autoQueueRef.current.length && receiverWantedRef.current && !mutedRef.current) {
        const { preset } = autoQueueRef.current.shift()
        await playbackRef.current.playPreset(preset, true)
      }
    } finally {
      autoRunningRef.current = false
    }
  }

  async function handleAutoCue(type, data) {
    const key = autoCueKey(type, data)
    if (!key || !receiverWantedRef.current || mutedRef.current || autoPendingRef.current.has(key)) return
    autoPendingRef.current.add(key)
    const generation = autoGenerationRef.current
    try {
      // Read current server preferences: the operator may edit mappings on another PC.
      const [mapped, stored] = await Promise.all([
        fetch(`${API_URL}/api/preferences/${AUTO_PREF_KEY}`).then((res) => res.json()),
        fetch(`${API_URL}/api/preferences/${PREF_KEY}`).then((res) => res.json()),
      ])
      const selectedId = mapped.success && mapped.data?.[type]
      const source = stored.success && Array.isArray(stored.data) ? stored.data : []
      const found = source.find((item) => item?.id === selectedId && validPreset(item))
      if (!found || !receiverWantedRef.current || mutedRef.current || autoGenerationRef.current !== generation) return

      const text = found.kind === 'speech' ? autoSpeechText(found.text, type, data, formatTimeVoice) : null
      if (found.kind === 'speech' && !text) return
      const preset = found.kind === 'speech' ? { ...found, text } : found
      if (text) setAutoPreview(text)

      let previous = []
      try {
        const saved = JSON.parse(localStorage.getItem(AUTO_HISTORY_KEY) || '[]')
        if (Array.isArray(saved)) previous = saved.filter((entry) => typeof entry === 'string').slice(-127)
      } catch {
        // Browser storage may be unavailable; at least avoid duplicates in this tab.
      }
      if (previous.includes(key) || autoSeenRef.current.has(key)) return
      if (autoQueueRef.current.some((entry) => entry.type === 'finished')) return
      if (type === 'finished') autoQueueRef.current = []
      if (autoQueueRef.current.length >= 8) return
      autoSeenRef.current.add(key)
      if (autoSeenRef.current.size > 128) autoSeenRef.current.delete(autoSeenRef.current.values().next().value)
      try {
        localStorage.setItem(AUTO_HISTORY_KEY, JSON.stringify([...previous, key].slice(-128)))
      } catch {
        // No storage permission: in-tab deduplication still applies.
      }
      autoQueueRef.current.push({ type, preset })
      void runAutoQueue()
    } catch {
      setError(t('auto.loadError'))
    } finally {
      autoPendingRef.current.delete(key)
    }
  }

  function stopPlayback() {
    playTokenRef.current += 1
    playbackDoneRef.current?.()
    playbackDoneRef.current = null
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    speechSynthesis.cancel()
    setPlayingId(null)
  }

  async function playPreset(preset, waitUntilEnd = false) {
    if (mutedRef.current) return { status: 'muted' }
    stopPlayback()
    setError('')
    setPlayingId(preset.id)
    const token = playTokenRef.current
    try {
      if (preset.kind === 'speech') {
        return await new Promise((resolve) => {
          let settled = false
          const complete = (status) => {
            if (settled) return
            settled = true
            if (waitUntilEnd) playbackDoneRef.current = null
            resolve({ status })
          }
          const utterance = speak(preset.text, { force: true, volume })
          if (!utterance) {
            setPlayingId(null)
            complete('blocked')
            return
          }
          if (waitUntilEnd) playbackDoneRef.current = () => complete('stopped')
          utterance.onstart = () => {
            if (!waitUntilEnd) complete('started')
          }
          utterance.onend = () => {
            if (playTokenRef.current === token) setPlayingId(null)
            complete('started')
          }
          utterance.onerror = () => {
            if (playTokenRef.current === token) {
              setPlayingId(null)
              setError(t('playError'))
            }
            complete('blocked')
          }
        })
      }
      const audio = new Audio(`${API_URL}${preset.url}`)
      audioRef.current = audio
      audio.volume = volume
      let finish
      const completed = new Promise((resolve) => {
        finish = resolve
      })
      audio.onended = () => {
        if (playTokenRef.current === token) setPlayingId(null)
        finish('started')
      }
      audio.onerror = () => {
        if (playTokenRef.current === token) {
          setPlayingId(null)
          setError(t('playError'))
        }
        finish('blocked')
      }
      if (waitUntilEnd) playbackDoneRef.current = () => finish('stopped')
      await audio.play()
      if (playTokenRef.current !== token) return { status: 'blocked' }
      return waitUntilEnd ? { status: await completed } : { status: 'started' }
    } catch {
      playbackDoneRef.current = null
      if (playTokenRef.current === token) {
        setPlayingId(null)
        setError(t('playError'))
      }
      return { status: 'blocked' }
    }
  }

  async function saveAutoMapping(type, presetId) {
    if (!autoLoaded || busy) return
    setBusy(true)
    setError('')
    const next = { ...autoMappings, [type]: presetId }
    try {
      const response = await fetch(`${API_URL}/api/preferences/${AUTO_PREF_KEY}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || t('saveError'))
      setAutoMappings(next)
    } catch {
      setError(t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  function editPreset(preset = null) {
    setEditingId(preset?.id || null)
    setLabel(preset?.label || '')
    setKind(preset?.kind || 'speech')
    setSpeechText(preset?.text || '')
    setFile(null)
    setError('')
    setFormOpen(true)
    setOpen(true)
  }

  async function persist(next) {
    const res = await fetch(`${API_URL}/api/preferences/${PREF_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const result = await res.json()
    if (!result.success) throw new Error(result.error)
    setPresets(next)
  }

  async function removeAudio(url) {
    if (!AUDIO_URL.test(url)) return
    const res = await fetch(`${API_URL}${url}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  }

  async function savePreset(event) {
    event.preventDefault()
    if (busy) return
    const name = label.trim()
    if (!name || name.length > 60 || (kind === 'speech' && (!speechText.trim() || speechText.length > 300))) {
      setError(t('invalidPreset'))
      return
    }
    const previous = presets.find((preset) => preset.id === editingId)
    if (kind === 'clip' && !file && previous?.kind !== 'clip') {
      setError(t('selectFile'))
      return
    }
    if (kind === 'clip' && file && file.size > 5 * 1024 * 1024) {
      setError(t('fileTooLarge'))
      return
    }
    if (!previous && presets.length >= 32) {
      setError(t('limitReached'))
      return
    }

    setBusy(true)
    setError('')
    let uploadedUrl = null
    let saved = false
    try {
      let url = previous?.kind === 'clip' ? previous.url : null
      if (kind === 'clip' && file) {
        const data = new FormData()
        data.append('audio', file)
        const uploaded = await fetch(`${API_URL}/api/upload/sounds`, { method: 'POST', body: data })
        const response = await uploaded.json()
        if (!uploaded.ok || !response.success) throw new Error(response.error || t('saveError'))
        uploadedUrl = response.data.url
        if (!AUDIO_URL.test(uploadedUrl)) throw new Error(t('saveError'))
        url = uploadedUrl
      }
      const preset = {
        id: previous?.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label: name,
        kind,
        ...(kind === 'speech' ? { text: speechText.trim() } : { url }),
      }
      await persist(
        previous ? presets.map((entry) => (entry.id === previous.id ? preset : entry)) : [...presets, preset]
      )
      saved = true
      setFormOpen(false)
      if (previous?.kind === 'clip' && previous.url !== preset.url) await removeAudio(previous.url)
    } catch (err) {
      if (uploadedUrl && !saved) await removeAudio(uploadedUrl).catch(() => {})
      setError(err.message || t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  async function deletePreset(preset) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await persist(presets.filter((entry) => entry.id !== preset.id))
      if (preset.kind === 'clip') await removeAudio(preset.url)
      if (playingId === preset.id) stopPlayback()
    } catch (err) {
      setError(err.message || t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  async function movePreset(index, delta) {
    if (busy || index + delta < 0 || index + delta >= presets.length) return
    const next = [...presets]
    const moving = next[index]
    next[index] = next[index + delta]
    next[index + delta] = moving
    setBusy(true)
    setError('')
    try {
      await persist(next)
    } catch {
      setError(t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  if (operatorOnly) {
    return (
      <section aria-label={t('title')} className="space-y-5">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3 sm:p-4">
          <Button variant="outline" size="lg" onClick={() => void stopSelected()} disabled={!playingId}>
            <Square className="size-5" /> {t('stop')}
          </Button>
          <Button
            variant={muted ? 'destructive' : 'outline'}
            size="lg"
            onClick={() => {
              if (!muted) void stopSelected()
              setMuted(!muted)
            }}
          >
            {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            {t(muted ? 'unmute' : 'mute')}
          </Button>
          <label className="ml-auto flex items-center gap-3 text-sm font-medium">
            {t('volume')}
            <input
              aria-label={t('volume')}
              className="w-28 accent-primary sm:w-48"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4">
          {presets.map((preset, index) => (
            <button
              key={preset.id}
              type="button"
              disabled={muted || busy}
              onClick={() => void playSelected(preset)}
              className={`relative flex min-h-36 flex-col items-center justify-center gap-4 rounded-2xl border-2 p-4 text-foreground shadow-[0_7px_0_0_rgba(0,0,0,0.2)] transition-[transform,box-shadow,background-color] active:translate-y-1 active:shadow-none focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-44 ${PAD_STYLES[index % PAD_STYLES.length]} ${playingId === preset.id ? 'translate-y-1 ring-4 ring-primary/40 shadow-none' : ''}`}
            >
              <span aria-hidden="true" className="absolute right-3 top-3 text-xs font-black tabular-nums opacity-50">
                {String(index + 1).padStart(2, '0')}
              </span>
              {preset.kind === 'speech' ? (
                <Mic2 className="size-10" aria-hidden="true" />
              ) : (
                <Music2 className="size-10" aria-hidden="true" />
              )}
              <span className="max-w-full break-words text-center text-base font-black leading-tight sm:text-xl">
                {preset.label}
              </span>
            </button>
          ))}
        </div>
        {presets.length === 0 && <p className="text-center text-muted-foreground">{t('empty')}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    )
  }

  return (
    <section className="rounded-lg border bg-card mb-4" aria-label={t('title')}>
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)}>
          <Volume2 className="size-4" /> {t('title')}{' '}
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
        {!directorAccess && (
          <Button asChild variant="outline" size="sm">
            <Link to="/soundboard">
              <LayoutGrid className="size-4" /> {t('operatorMode')}
            </Link>
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={stopSelected} disabled={!playingId}>
          <Square className="size-3" /> {t('stop')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!muted) void stopSelected()
            setMuted(!muted)
          }}
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />} {t(muted ? 'unmute' : 'mute')}
        </Button>
        {directorAccess && (
          <Button variant="outline" size="sm" onClick={receiverWantedRef.current ? disableReceiver : enableReceiver}>
            {t(receiverState === 'ready' ? 'receiverDisable' : 'receiverEnable')}
          </Button>
        )}
        {open && (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {t('volume')}
            <input
              aria-label={t('volume')}
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
        )}
      </div>
      {open && (
        <div className="border-t p-3 space-y-3">
          {!directorAccess && (
            <label className="flex flex-wrap items-center gap-2 text-xs">
              {t('output')}
              <select
                className="rounded-md border bg-background p-1"
                value={target}
                onChange={(event) => {
                  void stopSelected()
                  setTarget(event.target.value)
                  setRemoteStatus('')
                }}
              >
                <option value="local">{t('outputLocal')}</option>
                <option value="director">{t('outputDirector')}</option>
              </select>
              {target === 'director' && (
                <span role="status">{t(remoteReady ? 'receiverReady' : 'receiverOffline')}</span>
              )}
            </label>
          )}
          {directorAccess && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(`receiverState.${receiverState}`)}
            </p>
          )}
          {directorAccess && autoPreview && (
            <p className="text-xs text-muted-foreground">
              {t('auto.lastSpoken')}: {autoPreview}
            </p>
          )}
          {remoteStatus && (
            <p role="status" className="text-xs text-green-600">
              {remoteStatus}
            </p>
          )}
          {!directorAccess && (
            <fieldset className="rounded-md border p-2 space-y-2">
              <legend className="text-sm font-medium">{t('auto.title')}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {AUTO_CUE_TYPES.map((type) => (
                  <label key={type} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="min-w-24">{t(`auto.${type}`)}</span>
                    <select
                      className="min-h-11 min-w-0 flex-1 rounded-md border bg-background p-2"
                      aria-label={t(`auto.${type}`)}
                      value={autoMappings[type] || ''}
                      disabled={!autoLoaded || busy}
                      onChange={(event) => void saveAutoMapping(type, event.target.value)}
                    >
                      <option value="">{t('auto.off')}</option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('auto.description')}</p>
              <p className="text-xs text-muted-foreground">{t('auto.fuelDescription')}</p>
            </fieldset>
          )}
          <div className="flex flex-wrap gap-2">
            {presets.map((preset, index) => (
              <div key={preset.id} className="flex items-center rounded-md border bg-background">
                <Button
                  variant={playingId === preset.id ? 'default' : 'ghost'}
                  size="sm"
                  disabled={muted || busy}
                  onClick={() => playSelected(preset)}
                  title={t('play')}
                >
                  <Play className="size-3" /> {preset.label}
                </Button>
                {!directorAccess && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    onClick={() => editPreset(preset)}
                    aria-label={`${t('edit')}: ${preset.label}`}
                  >
                    <Pencil className="size-3" />
                  </Button>
                )}
                {!directorAccess && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy || index === 0}
                    onClick={() => movePreset(index, -1)}
                    aria-label={`${t('up')}: ${preset.label}`}
                  >
                    <ChevronUp className="size-3" />
                  </Button>
                )}
                {!directorAccess && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy || index === presets.length - 1}
                    onClick={() => movePreset(index, 1)}
                    aria-label={`${t('down')}: ${preset.label}`}
                  >
                    <ChevronDown className="size-3" />
                  </Button>
                )}
                {!directorAccess && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    onClick={() => deletePreset(preset)}
                    aria-label={`${t('delete')}: ${preset.label}`}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {presets.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
          {!directorAccess && !formOpen && (
            <Button variant="outline" size="sm" onClick={() => editPreset()} disabled={busy || presets.length >= 32}>
              <Plus className="size-4" /> {t('add')}
            </Button>
          )}
          {!directorAccess && formOpen && (
            <form className="flex flex-col gap-2 max-w-xl" onSubmit={savePreset}>
              <label className="text-sm font-medium">{t('name')}</label>
              <input
                className="rounded-md border bg-background p-2 text-sm"
                maxLength={60}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                required
              />
              <label className="text-sm font-medium">{t('type')}</label>
              <select
                className="rounded-md border bg-background p-2 text-sm"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value)
                  setFile(null)
                }}
              >
                <option value="speech">{t('speech')}</option>
                <option value="clip">{t('clip')}</option>
              </select>
              {kind === 'speech' ? (
                <>
                  <label className="text-sm font-medium">{t('announcement')}</label>
                  <textarea
                    className="rounded-md border bg-background p-2 text-sm"
                    rows={2}
                    maxLength={300}
                    value={speechText}
                    onChange={(event) => setSpeechText(event.target.value)}
                    required
                  />
                </>
              ) : (
                <>
                  <label className="text-sm font-medium">{t('audioFile')}</label>
                  <input
                    type="file"
                    accept=".mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav"
                    onChange={(event) => setFile(event.target.files?.[0] || null)}
                  />
                  {editingId && <p className="text-xs text-muted-foreground">{t('optionalReplacement')}</p>}
                </>
              )}
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {t(busy ? 'saving' : 'save')}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setFormOpen(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
