-- Optional display-only weather; existing sessions remain dry (weatherSeed IS NULL).
ALTER TABLE "Session" ADD COLUMN "weatherSeed" INTEGER;
ALTER TABLE "Session" ADD COLUMN "weatherInitial" TEXT NOT NULL DEFAULT 'dry';
ALTER TABLE "Session" ADD COLUMN "weatherRainChance" INTEGER NOT NULL DEFAULT 35;
ALTER TABLE "Session" ADD COLUMN "weatherIntervalSeconds" INTEGER NOT NULL DEFAULT 60;
