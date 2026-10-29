ALTER TABLE "SessionDriver" ADD COLUMN "pendingFuelLaps" INTEGER;
ALTER TABLE "SessionDriver" ADD COLUMN "pendingFuelUnits" INTEGER;
ALTER TABLE "VirtualFuelEvent" ADD COLUMN "targetUnits" INTEGER;
ALTER TABLE "SessionDriver" ADD COLUMN "fuelPlanVersion" INTEGER NOT NULL DEFAULT 0;
