import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SessionStatus,
  SessionType,
  VIRTUAL_FUEL_FULL,
  virtualFuelPerLap,
  virtualFuelTarget,
  validVirtualFuelUnits,
} from '@racehubos/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const API_URL = import.meta.env.VITE_API_URL || ''

export default function DriverFuelStrategy({ session, assignment, live, accessToken, fetchSession }) {
  const { t } = useTranslation('driverDisplay')
  const [targetLaps, setTargetLaps] = useState(
    assignment.pendingFuelLaps == null ? '' : String(assignment.pendingFuelLaps)
  )
  const [initialPercent, setInitialPercent] = useState(String((assignment.initialFuelUnits ?? VIRTUAL_FUEL_FULL) / 100))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const pending = useRef(false)

  const perLap = useMemo(
    () =>
      virtualFuelPerLap((session.virtualFuelEvents || []).filter((event) => event.sessionDriverId === assignment.id)),
    [session.virtualFuelEvents, assignment.id]
  )
  const units = live?.virtualFuelUnits ?? assignment.virtualFuelUnits
  const estimatedLaps = perLap && Number.isInteger(units) ? Math.floor(units / perLap) : null
  const targetUnits = virtualFuelTarget(Number(targetLaps), perLap)
  const available =
    accessToken &&
    session.virtualFuelRate != null &&
    [SessionType.RACE, SessionType.QUALIF].includes(session.type) &&
    [SessionStatus.ACTIVE, SessionStatus.PAUSED].includes(session.status) &&
    !assignment.isDNF

  const initialUnits = Number(initialPercent) * 100
  const initialValid =
    initialPercent.trim() !== '' && Number.isInteger(Number(initialPercent)) && validVirtualFuelUnits(initialUnits)
  const initialAvailable =
    accessToken &&
    session.virtualFuelRate != null &&
    [SessionType.RACE, SessionType.QUALIF].includes(session.type) &&
    session.status === SessionStatus.DRAFT

  async function saveInitial(event) {
    event.preventDefault()
    if (pending.current || !initialAvailable || !initialValid) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`${API_URL}/api/race-control/driver/start-fuel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ initialFuelUnits: initialUnits, expectedVersion: assignment.fuelPlanVersion ?? 0 }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) {
        if (response.status === 409) await fetchSession(session.id)
        throw new Error(t('fuelStrategy.startSaveError'))
      }
      if (!(await fetchSession(session.id))) throw new Error(t('fuelStrategy.refreshError'))
      setMessage(t('fuelStrategy.startSaved'))
    } catch (cause) {
      setError(cause.message)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function save(laps) {
    if (pending.current || !available) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`${API_URL}/api/race-control/driver/fuel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetLaps: laps, expectedVersion: assignment.fuelPlanVersion ?? 0 }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) {
        if (response.status === 409) await fetchSession(session.id)
        throw new Error(t('fuelStrategy.saveError'))
      }
      if (!(await fetchSession(session.id))) throw new Error(t('fuelStrategy.refreshError'))
      setTargetLaps(laps == null ? '' : String(laps))
      setMessage(t('fuelStrategy.saved'))
    } catch (cause) {
      setError(cause.message)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <section data-testid="driver-fuel-strategy" className="rounded-xl border border-border bg-card p-5 space-y-3">
      <form onSubmit={saveInitial} className="space-y-3" data-testid="driver-start-fuel">
        <h2 className="font-semibold">{t('fuelStrategy.startTitle')}</h2>
        <p data-testid="start-fuel-saved" className="text-sm">
          {t('fuelStrategy.startConfigured', { percent: (assignment.initialFuelUnits ?? VIRTUAL_FUEL_FULL) / 100 })}
        </p>
        <p className="text-xs text-muted-foreground">{t('fuelStrategy.startHint')}</p>
        <label className="text-sm font-medium block" htmlFor="start-fuel-percent">
          {t('fuelStrategy.startPercent')}
        </label>
        <Input
          id="start-fuel-percent"
          data-testid="start-fuel-percent"
          type="number"
          min="0"
          max="100"
          step="1"
          value={initialPercent}
          disabled={!initialAvailable || busy}
          onChange={(event) => setInitialPercent(event.target.value)}
        />
        <Button type="submit" data-testid="start-fuel-save" disabled={!initialAvailable || busy || !initialValid}>
          {t(busy ? 'fuelStrategy.saving' : 'fuelStrategy.startSave')}
        </Button>
        {!initialValid && <p className="text-sm text-muted-foreground">{t('fuelStrategy.startInvalid')}</p>}
      </form>
      <h2 className="font-semibold border-t border-border pt-3">{t('fuelStrategy.title')}</h2>
      <p data-testid="fuel-range" className="text-2xl font-bold tabular-nums">
        {session.virtualFuelRate != null && estimatedLaps !== null
          ? t('fuelStrategy.range', { laps: estimatedLaps })
          : t('fuelStrategy.noEstimate')}
      </p>
      <p className="text-xs text-muted-foreground">{t('fuelStrategy.estimateNote')}</p>
      <p className="text-sm" data-testid="fuel-saved-plan">
        {session.virtualFuelRate == null
          ? t('fuelStrategy.off')
          : assignment.pendingFuelLaps != null
            ? t('fuelStrategy.pending', {
                laps: assignment.pendingFuelLaps,
                percent: assignment.pendingFuelUnits / 100,
              })
            : t('fuelStrategy.fullTank')}
      </p>
      <p className="text-xs text-muted-foreground">{t('fuelStrategy.pitNote')}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (targetUnits !== null) save(Number(targetLaps))
        }}
      >
        <label htmlFor="fuel-target-laps" className="text-sm font-medium block">
          {t('fuelStrategy.target')}
        </label>
        <Input
          id="fuel-target-laps"
          data-testid="fuel-target-laps"
          type="number"
          min={1}
          max={VIRTUAL_FUEL_FULL}
          step={1}
          value={targetLaps}
          disabled={!available || busy}
          onChange={(event) => setTargetLaps(event.target.value)}
        />
        <p data-testid="fuel-target-preview" className="text-sm text-muted-foreground">
          {perLap === null
            ? t('fuelStrategy.noEstimate')
            : targetUnits === null
              ? t('fuelStrategy.invalidTarget')
              : t('fuelStrategy.preview', { percent: targetUnits / 100 })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="fuel-plan-save" disabled={!available || busy || targetUnits === null}>
            {t(busy ? 'fuelStrategy.saving' : 'fuelStrategy.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="fuel-plan-clear"
            disabled={!available || busy || assignment.pendingFuelLaps == null}
            onClick={() => save(null)}
          >
            {t('fuelStrategy.clear')}
          </Button>
        </div>
      </form>
      {!accessToken && <p className="text-xs text-amber-500">{t('fuelStrategy.tokenRequired')}</p>}
      {!available && accessToken && <p className="text-xs text-amber-500">{t('fuelStrategy.unavailable')}</p>}
      {message && (
        <p role="status" className="text-sm text-green-500">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-500" data-testid="fuel-plan-error">
          {error}
        </p>
      )}
    </section>
  )
}
