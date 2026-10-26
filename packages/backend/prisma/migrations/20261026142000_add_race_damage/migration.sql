-- Optional software-only damage; existing sessions remain disabled.
ALTER TABLE "Session" ADD COLUMN "damageLapThresholdMs" INTEGER;
ALTER TABLE "Session" ADD COLUMN "damageRepairSeconds" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Session" ADD COLUMN "damagePitSeconds" INTEGER NOT NULL DEFAULT 5;

-- One damage episode per driver/session, including its repair evidence or DNF.
ALTER TABLE "SessionDriver" ADD COLUMN "damageStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "SessionDriver" ADD COLUMN "damageLapNumber" INTEGER;
ALTER TABLE "SessionDriver" ADD COLUMN "damageTriggeredAt" DATETIME;
ALTER TABLE "SessionDriver" ADD COLUMN "damageDeadlineElapsedMs" INTEGER;
ALTER TABLE "SessionDriver" ADD COLUMN "damageRepairedAt" DATETIME;
ALTER TABLE "SessionDriver" ADD COLUMN "damageRepairPitStopId" TEXT;
ALTER TABLE "SessionDriver" ADD COLUMN "damageRepairSource" TEXT;
