import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Pencil, Play, Plus, Square, Trash2, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVoice } from '../../context/VoiceContext'

const API_URL = import.meta.env.VITE_API_URL || ''
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

export default function Soundboard() {
  const { t } = useTranslation('soundboard')
  const { speak } = useVoice()
  const [open, setOpen] = useState(false)
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
  const [error, setError] = useState('')
  const audioRef = useRef(null)
  const playTokenRef = useRef(0)

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

  function playPreset(preset) {
    if (muted) return
    stopPlayback()
    setError('')
    setPlayingId(preset.id)
    const token = playTokenRef.current
    try {
      if (preset.kind === 'speech') {
        const utterance = speak(preset.text, { force: true, volume })
        if (!utterance) throw new Error(t('playError'))
        utterance.onend = () => {
          if (playTokenRef.current === token) setPlayingId(null)
        }
        utterance.onerror = () => {
          if (playTokenRef.current !== token) return
          setPlayingId(null)
          setError(t('playError'))
        }
      } else {
        const audio = new Audio(`${API_URL}${preset.url}`)
        audioRef.current = audio
        audio.volume = volume
        audio.onended = () => {
          if (playTokenRef.current === token) setPlayingId(null)
        }
        audio.onerror = () => {
          if (playTokenRef.current !== token) return
          setPlayingId(null)
          setError(t('playError'))
        }
        audio.play().catch(() => {
          if (playTokenRef.current !== token) return
          setPlayingId(null)
          setError(t('playError'))
        })
      }
    } catch {
      setPlayingId(null)
      setError(t('playError'))
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
        <Button variant="outline" size="sm" onClick={stopPlayback} disabled={!playingId}>
          <Square className="size-3" /> {t('stop')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!muted) stopPlayback()
            setMuted(!muted)
          }}
        >
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />} {t(muted ? 'unmute' : 'mute')}
        </Button>
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
          <div className="flex flex-wrap gap-2">
            {presets.map((preset, index) => (
              <div key={preset.id} className="flex items-center rounded-md border bg-background">
                <Button
                  variant={playingId === preset.id ? 'default' : 'ghost'}
                  size="sm"
                  disabled={muted || busy}
                  onClick={() => playPreset(preset)}
                  title={t('play')}
                >
                  <Play className="size-3" /> {preset.label}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => editPreset(preset)}
                  aria-label={`${t('edit')}: ${preset.label}`}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || index === 0}
                  onClick={() => movePreset(index, -1)}
                  aria-label={`${t('up')}: ${preset.label}`}
                >
                  <ChevronUp className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || index === presets.length - 1}
                  onClick={() => movePreset(index, 1)}
                  aria-label={`${t('down')}: ${preset.label}`}
                >
                  <ChevronDown className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => deletePreset(preset)}
                  aria-label={`${t('delete')}: ${preset.label}`}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
          {presets.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
          {!formOpen && (
            <Button variant="outline" size="sm" onClick={() => editPreset()} disabled={busy || presets.length >= 32}>
              <Plus className="size-4" /> {t('add')}
            </Button>
          )}
          {formOpen && (
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
