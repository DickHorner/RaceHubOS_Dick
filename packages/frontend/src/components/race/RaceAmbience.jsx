import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SessionStatus } from '@racehubos/shared'
import { Button } from '@/components/ui/button'
import { createRaceAmbience } from '../../lib/raceAmbience'

export default function RaceAmbience({ status }) {
  const allowed = [SessionStatus.DRAFT, SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING].includes(
    status
  )
  return <AmbienceControls key={String(allowed)} allowed={allowed} />
}

function AmbienceControls({ allowed }) {
  const { t } = useTranslation('race')
  const player = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [starting, setStarting] = useState(false)
  const [volume, setVolume] = useState(20)
  const [muted, setMuted] = useState(false)
  const [ducking, setDucking] = useState(false)
  const [error, setError] = useState(false)

  const stop = useCallback(() => {
    player.current?.stop()
    player.current = null
    setPlaying(false)
    setStarting(false)
    setDucking(false)
  }, [])

  useEffect(
    () => () => {
      player.current?.stop()
      player.current = null
    },
    []
  )

  async function start() {
    if (!allowed || player.current) return
    setError(false)
    setStarting(true)
    let audio
    try {
      audio = createRaceAmbience()
      player.current = audio
      audio.setVolume(muted ? 0 : (volume / 100) * (window.speechSynthesis?.speaking ? 0.2 : 1))
      await audio.resume()
      if (player.current !== audio) return
      setPlaying(true)
      setStarting(false)
    } catch {
      if (!audio || player.current === audio) {
        stop()
        setError(true)
      }
    }
  }

  useEffect(() => {
    if (!playing) return
    const audio = player.current
    // Read the existing browser speech channel: covers VoiceContext, cancellation
    // and soundboard callbacks without replacing any utterance event handlers.
    const update = () => {
      if (player.current !== audio) return
      if (audio.state !== 'running') {
        stop()
        setError(true)
        return
      }
      const speaking = Boolean(window.speechSynthesis?.speaking)
      audio.setVolume(muted ? 0 : (volume / 100) * (speaking ? 0.2 : 1))
      setDucking(speaking)
    }
    audio.setVolume(muted ? 0 : (volume / 100) * (window.speechSynthesis?.speaking ? 0.2 : 1))
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [playing, volume, muted, stop])

  return (
    <section
      id="race-ambience"
      data-testid="race-ambience"
      className="m-4 rounded-lg border border-border bg-muted/20 p-3 space-y-3"
      aria-label={t('ambience.title')}
    >
      <h3 className="text-sm font-semibold">{t('ambience.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('ambience.hint')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          data-testid="ambience-toggle"
          disabled={!allowed}
          onClick={playing || starting ? stop : start}
        >
          {t(playing || starting ? 'ambience.stop' : 'ambience.start')}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="ambience-mute"
          aria-pressed={muted}
          onClick={() => setMuted((value) => !value)}
        >
          {t(muted ? 'ambience.unmute' : 'ambience.mute')}
        </Button>
        <label className="grid min-w-0 gap-1 text-sm">
          <span>
            {t('ambience.volume')} <span className="tabular-nums">{volume}%</span>
          </span>
          <input
            data-testid="ambience-volume"
            className="min-h-11 w-48 max-w-full"
            type="range"
            min="0"
            max="100"
            step="1"
            value={volume}
            onChange={(event) => setVolume(Math.max(0, Math.min(100, Number(event.target.value))))}
          />
        </label>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {t(
          !allowed
            ? 'ambience.finished'
            : starting
              ? 'ambience.starting'
              : !playing
                ? 'ambience.off'
                : muted
                  ? 'ambience.muted'
                  : ducking
                    ? 'ambience.ducking'
                    : 'ambience.playing'
        )}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('ambience.error')}
        </p>
      )}
    </section>
  )
}
