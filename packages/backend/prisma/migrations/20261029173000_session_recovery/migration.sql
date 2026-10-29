-- Recover an orphan without inventing a race finish or removing telemetry.
ALTER TABLE "Session" ADD COLUMN "recoveredAt" DATETIME;
ALTER TABLE "Session" ADD COLUMN "recoveredFromStatus" TEXT;
