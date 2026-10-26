-- Virtual tyre strategy is separate from car specifications and physical CU writes.
-- Measured lapTime and totalTime remain untouched.
ALTER TABLE "Session" ADD COLUMN "tyreMismatchPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SessionDriver" ADD COLUMN "tyreType" TEXT NOT NULL DEFAULT 'dry';
ALTER TABLE "SessionDriver" ADD COLUMN "pendingTyreType" TEXT;
ALTER TABLE "SessionDriver" ADD COLUMN "simulatedTotalTime" INTEGER;
ALTER TABLE "SessionDriver" ADD COLUMN "simulatedBestLapTime" INTEGER;
ALTER TABLE "Lap" ADD COLUMN "simulatedLapTime" REAL;
ALTER TABLE "Lap" ADD COLUMN "tyreAtLap" TEXT;
ALTER TABLE "Lap" ADD COLUMN "weatherAtLap" TEXT;

CREATE TABLE "TyreChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sessionDriverId" TEXT NOT NULL,
    "controller" INTEGER NOT NULL,
    "fromType" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "pitStopId" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TyreChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TyreChange_sessionDriverId_fkey" FOREIGN KEY ("sessionDriverId") REFERENCES "SessionDriver" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TyreChange_pitStopId_fkey" FOREIGN KEY ("pitStopId") REFERENCES "PitStop" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TyreChange_pitStopId_key" ON "TyreChange"("pitStopId");
CREATE INDEX "TyreChange_sessionId_changedAt_idx" ON "TyreChange"("sessionId", "changedAt");
CREATE INDEX "TyreChange_sessionDriverId_idx" ON "TyreChange"("sessionDriverId");
