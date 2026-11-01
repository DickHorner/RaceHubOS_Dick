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
  const [targetMode, setTargetMode] = useState(
    assignment.pendingFuelUnits != null && assignment.pendingFuelLaps == null ? 'percent' : 'laps'
  )
  const [targetPercent, setTargetPercent] = useState(
    assignment.pendingFuelUnits == null ? '' : String(assignment.pendingFuelUnits / 100)
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
  const estimatedLaps = perLap && validVirtualFuelUnits(units) ? Math.floor(units / perLap) : null
  const percentUnits = Number(targetPercent) * 100
  const percentValid =
    targetPercent.trim() !== '' && Number.isInteger(Number(targetPercent)) && validVirtualFuelUnits(percentUnits)
  const targetUnits =
    targetMode === 'percent' ? (percentValid ? percentUnits : null) : virtualFuelTarget(Number(targetLaps), perLap)
  const resultingUnits = targetUnits !== null && validVirtualFuelUnits(units) ? Math.max(units, targetUnits) : null
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

  const completedLaps = live?.totalLaps ?? assignment.totalLaps
  const remainingLaps =
    Number.isSafeInteger(session.maxLaps) &&
    session.maxLaps > 0 &&
    Number.isSafeInteger(completedLaps) &&
    completedLaps >= 0
      ? Math.max(0, session.maxLaps - completedLaps)
      : null
  const finishUnits = virtualFuelTarget(remainingLaps, perLap)
  const finishBalance = finishUnits !== null && validVirtualFuelUnits(units) ? units - finishUnits : null
  const showFinishPlan =
    session.virtualFuelRate != null &&
    [SessionType.RACE, SessionType.QUALIF].includes(session.type) &&
    [SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.FINISHING].includes(session.status)

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

  async function save(target) {
    if (pending.current || !available) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`${API_URL}/api/race-control/driver/fuel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ...target, expectedVersion: assignment.fuelPlanVersion ?? 0 }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) {
        if (response.status === 409) await fetchSession(session.id)
        throw new Error(t('fuelStrategy.saveError'))
      }
      if (!(await fetchSession(session.id))) throw new Error(t('fuelStrategy.refreshError'))
      if (target.targetLaps !== undefined) setTargetLaps(target.targetLaps == null ? '' : String(target.targetLaps))
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
      <p data-testid="fuel-strategy-requirements" className="text-sm text-muted-foreground">
        {t('fuelStrategy.requirements')}
      </p>
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
      {session.virtualFuelRate != null && perLap !== null && (
        <p data-testid="fuel-full-range" className="text-sm text-muted-foreground">
          {t('fuelStrategy.fullRange', { laps: Math.floor(VIRTUAL_FUEL_FULL / perLap) })}
        </p>
      )}
      {showFinishPlan ? (
        <section data-testid="fuel-finish-plan" className="rounded-lg bg-muted p-3 space-y-2">
          <h3 className="text-sm font-semibold">{t('fuelStrategy.finishTitle')}</h3>
          <p data-testid="fuel-finish-laps" className="text-sm">
            {remainingLaps === null
              ? t('fuelStrategy.finishUnknown')
              : remainingLaps === 0
                ? t('fuelStrategy.finishReached')
                : t('fuelStrategy.finishRemaining', { laps: remainingLaps })}
          </p>
          {remainingLaps > 0 && (
            <>
              <p data-testid="fuel-finish-demand" className="text-sm">
                {perLap === null
                  ? t('fuelStrategy.noEstimate')
                  : finishUnits === null
                    ? t('fuelStrategy.finishCapacity')
                    : t('fuelStrategy.finishDemand', { percent: finishUnits / 100 })}
              </p>
              {finishUnits !== null && (
                <p data-testid="fuel-finish-balance" className="text-sm">
                  {finishBalance === null
                    ? t('fuelStrategy.finishBalanceUnknown')
                    : t(finishBalance >= 0 ? 'fuelStrategy.finishReserve' : 'fuelStrategy.finishShortfall', {
                        percent: Math.abs(finishBalance) / 100,
                      })}
                </p>
              )}
            </>
          )}
          <Button
            type="button"
            variant="outline"
            data-testid="fuel-finish-use"
            disabled={!available || busy || finishUnits === null || remainingLaps === 0}
            onClick={() => {
              setTargetMode('laps')
              setTargetLaps(String(remainingLaps))
            }}
          >
            {t('fuelStrategy.finishUse')}
          </Button>
        </section>
      ) : (
        <section data-testid="fuel-finish-plan" className="rounded-lg bg-muted p-3 space-y-2">
          <h3 className="font-semibold">{t('fuelStrategy.finishTitle')}</h3>
          <p className="text-sm">{t('fuelStrategy.finishPrerequisite')}</p>
        </section>
      )}
      <p className="text-sm" data-testid="fuel-saved-plan">
        {session.virtualFuelRate == null
          ? t('fuelStrategy.off')
          : assignment.pendingFuelLaps != null
            ? t('fuelStrategy.pending', {
                laps: assignment.pendingFuelLaps,
                percent: assignment.pendingFuelUnits / 100,
              })
            : assignment.pendingFuelUnits != null
              ? t('fuelStrategy.pendingPercent', { percent: assignment.pendingFuelUnits / 100 })
              : t('fuelStrategy.fullTank')}
      </p>
      <p className="text-xs text-muted-foreground">{t('fuelStrategy.pitNote')}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (targetUnits !== null)
            save(targetMode === 'percent' ? { targetUnits } : { targetLaps: Number(targetLaps) })
        }}
      >
        <fieldset disabled={!available || busy} className="space-y-2">
          <legend className="text-sm font-medium">{t('fuelStrategy.targetMode')}</legend>
          <div className="flex flex-wrap gap-4">
            {['laps', 'percent'].map((mode) => (
              <label key={mode} className="flex items-center gap-2 min-h-11">
                <input
                  type="radio"
                  name="fuel-target-mode"
                  data-testid={`fuel-mode-${mode}`}
                  value={mode}
                  checked={targetMode === mode}
                  onChange={() => setTargetMode(mode)}
                />
                {t(`fuelStrategy.mode_${mode}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <label htmlFor="fuel-target-value" className="text-sm font-medium block">
          {t(targetMode === 'percent' ? 'fuelStrategy.targetPercent' : 'fuelStrategy.target')}
        </label>
        <Input
          id="fuel-target-value"
          data-testid={targetMode === 'percent' ? 'fuel-target-percent' : 'fuel-target-laps'}
          type="number"
          min={targetMode === 'percent' ? 0 : 1}
          max={targetMode === 'percent' ? 100 : VIRTUAL_FUEL_FULL}
          step={1}
          value={targetMode === 'percent' ? targetPercent : targetLaps}
          disabled={!available || busy}
          onChange={(event) =>
            targetMode === 'percent' ? setTargetPercent(event.target.value) : setTargetLaps(event.target.value)
          }
        />
        <p data-testid="fuel-target-preview" className="text-sm text-muted-foreground">
          {targetMode === 'laps' && perLap === null
            ? t('fuelStrategy.noEstimate')
            : targetUnits === null
              ? t(targetMode === 'percent' ? 'fuelStrategy.startInvalid' : 'fuelStrategy.invalidTarget')
              : t(targetMode === 'percent' ? 'fuelStrategy.percentPreview' : 'fuelStrategy.preview', {
                  percent: targetUnits / 100,
                })}
        </p>
        {session.virtualFuelRate != null && targetUnits !== null && (
          <p data-testid="fuel-refill-preview" className="text-sm text-muted-foreground">
            {resultingUnits === null
              ? t('fuelStrategy.refillUnavailable')
              : perLap === null
                ? t('fuelStrategy.refillWithoutRange', {
                    added: (resultingUnits - units) / 100,
                    percent: resultingUnits / 100,
                  })
                : t('fuelStrategy.refillPreview', {
                    added: (resultingUnits - units) / 100,
                    percent: resultingUnits / 100,
                    laps: Math.floor(resultingUnits / perLap),
                  })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" data-testid="fuel-plan-save" disabled={!available || busy || targetUnits === null}>
            {t(busy ? 'fuelStrategy.saving' : 'fuelStrategy.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="fuel-plan-clear"
            disabled={!available || busy || assignment.pendingFuelUnits == null}
            onClick={() => save({ targetLaps: null })}
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
