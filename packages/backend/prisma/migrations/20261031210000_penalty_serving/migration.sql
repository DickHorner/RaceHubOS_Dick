ALTER TABLE "SessionPenalty" ADD COLUMN "servedAt" DATETIME;
ALTER TABLE "SessionPenalty" ADD COLUMN "servedMethod" TEXT;
ALTER TABLE "SessionPenalty" ADD COLUMN "servedReason" TEXT;
ALTER TABLE "SessionPenalty" ADD COLUMN "servedPitStopId" TEXT REFERENCES "PitStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "SessionPenalty_servedPitStopId_key" ON "SessionPenalty"("servedPitStopId");
