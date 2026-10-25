-- Times are observation instants on the RaceHubOS host (not CU event timestamps).
CREATE TABLE "PitStop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sessionDriverId" TEXT,
    "controller" INTEGER NOT NULL,
    "enteredAt" DATETIME NOT NULL,
    "exitedAt" DATETIME NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    CONSTRAINT "PitStop_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PitStop_sessionDriverId_fkey" FOREIGN KEY ("sessionDriverId") REFERENCES "SessionDriver" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PitStop_sessionId_enteredAt_idx" ON "PitStop"("sessionId", "enteredAt");
CREATE INDEX "PitStop_sessionDriverId_idx" ON "PitStop"("sessionDriverId");
