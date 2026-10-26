-- Virtual fuel is software-only and independent of the physical CU fuel mode.
-- 10000 units = 100%; events are replayed in increasing autoincrement id order.
ALTER TABLE "Session" ADD COLUMN "virtualFuelRate" INTEGER;

CREATE TABLE "VirtualFuelEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "sessionDriverId" TEXT NOT NULL,
    "controller" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VirtualFuelEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VirtualFuelEvent_sessionDriverId_fkey" FOREIGN KEY ("sessionDriverId") REFERENCES "SessionDriver" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VirtualFuelEvent_sessionId_reference_key" ON "VirtualFuelEvent"("sessionId", "reference");
CREATE INDEX "VirtualFuelEvent_sessionId_id_idx" ON "VirtualFuelEvent"("sessionId", "id");
