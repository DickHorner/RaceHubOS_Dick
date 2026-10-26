export const DamageStatus = Object.freeze({
  NONE: 'none',
  ACTIVE: 'active',
  REPAIRED: 'repaired',
  DNF: 'dnf',
});

export function validDamageConfig({ damageLapThresholdMs, damageRepairSeconds, damagePitSeconds }) {
  return (
    (damageLapThresholdMs === null ||
      (Number.isInteger(damageLapThresholdMs) && damageLapThresholdMs >= 1000 && damageLapThresholdMs <= 600000)) &&
    Number.isInteger(damageRepairSeconds) &&
    damageRepairSeconds >= 5 &&
    damageRepairSeconds <= 3600 &&
    Number.isInteger(damagePitSeconds) &&
    damagePitSeconds >= 1 &&
    damagePitSeconds <= 300 &&
    damagePitSeconds <= damageRepairSeconds
  );
}
