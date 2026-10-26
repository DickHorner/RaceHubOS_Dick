-- Penalties are audit records. Raw laps and lap times are never rewritten.
CREATE TABLE "SessionPenalty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sessionDriverId" TEXT,
    "driverId" TEXT,
    "controller" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "SessionPenalty_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionPenalty_sessionDriverId_fkey" FOREIGN KEY ("sessionDriverId") REFERENCES "SessionDriver" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SessionPenalty_sessionId_requestId_key" ON "SessionPenalty"("sessionId", "requestId");
CREATE INDEX "SessionPenalty_sessionId_issuedAt_idx" ON "SessionPenalty"("sessionId", "issuedAt");
CREATE INDEX "SessionPenalty_sessionDriverId_status_idx" ON "SessionPenalty"("sessionDriverId", "status");
