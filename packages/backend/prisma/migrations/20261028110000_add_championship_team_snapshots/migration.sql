-- Team membership at first race GO, independent of later driver transfers.
-- Existing races remain unsnapshotted and must not be reattributed retroactively.
ALTER TABLE "Session" ADD COLUMN "teamMembershipSnapshotted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SessionDriver" ADD COLUMN "teamIdAtStart" TEXT;
