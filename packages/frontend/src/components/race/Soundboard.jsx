import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Pencil, Play, Plus, Square, Trash2, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVoice } from '../../context/VoiceContext'
import { io } from 'socket.io-client'

const API_URL = import.meta.env.VITE_API_URL || ''
const WS_URL = import.meta.env.VITE_WS_URL || ''
const PREF_KEY = 'soundboard:presets'
const AUDIO_URL = /^\/api\/upload\/sounds\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(mp3|ogg|wav)$/

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

export default function Soundboard({ directorKey = '' }) {
  const { t } = useTranslation('soundboard')
  const { speak } = useVoice()
  const [open, setOpen] = useState(Boolean(directorKey))
  const [presets, setPresets] = useState([])
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
    return () => {
      active = false
      audioRef.current?.pause()
    }
  }, [t])

  useEffect(() => {
    playbackRef.current = { playPreset, stopPlayback }
  })

  useEffect(() => {
    if (directorKey || target !== 'director') return
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
  }, [directorKey, target])

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
    if (directorKey || target === 'local') {
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
    const remotelyPlaying = !directorKey && target === 'director'
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
    if (!directorKey || receiverWantedRef.current) return
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
        outcome = playbackRef.current.playPreset(data.preset)
        receivedRef.current.set(data.requestId, outcome)
        if (receivedRef.current.size > 64) receivedRef.current.delete(receivedRef.current.keys().next().value)
      }
      acknowledge?.(await outcome)
    })
    socket.on('soundboard:stop', (data, acknowledge) => {
      playbackRef.current.stopPlayback()
      acknowledge?.({ status: 'stopped' })
    })
  }

  function stopPlayback() {
    playTokenRef.current += 1
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    speechSynthesis.cancel()
    setPlayingId(null)
  }

  async function playPreset(preset) {
    if (muted) return { status: 'muted' }
    stopPlayback()
    setError('')
    setPlayingId(preset.id)
    const token = playTokenRef.current
    try {
      if (preset.kind === 'speech') {
        return await new Promise((resolve) => {
          let settled = false
          const complete = (status) => {
            if (!settled) {
              settled = true
              resolve({ status })
            }
          }
          const utterance = speak(preset.text, { force: true, volume })
          if (!utterance) {
            setPlayingId(null)
            complete('blocked')
            return
          }
          utterance.onstart = () => complete('started')
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
      audio.onended = () => {
        if (playTokenRef.current === token) setPlayingId(null)
      }
      audio.onerror = () => {
        if (playTokenRef.current === token) {
          setPlayingId(null)
          setError(t('playError'))
        }
      }
      await audio.play()
      return { status: playTokenRef.current === token ? 'started' : 'blocked' }
    } catch {
      if (playTokenRef.current === token) {
        setPlayingId(null)
        setError(t('playError'))
      }
      return { status: 'blocked' }
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

  return (
    <section className="rounded-lg border bg-card mb-4" aria-label={t('title')}>
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)}>
          <Volume2 className="size-4" /> {t('title')}{' '}
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
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
        {directorKey && (
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
          {!directorKey && (
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
          {directorKey && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(`receiverState.${receiverState}`)}
            </p>
          )}
          {remoteStatus && (
            <p role="status" className="text-xs text-green-600">
              {remoteStatus}
            </p>
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
                {!directorKey && (
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
                {!directorKey && (
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
                {!directorKey && (
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
                {!directorKey && (
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
          {!directorKey && !formOpen && (
            <Button variant="outline" size="sm" onClick={() => editPreset()} disabled={busy || presets.length >= 32}>
              <Plus className="size-4" /> {t('add')}
            </Button>
          )}
          {!directorKey && formOpen && (
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
