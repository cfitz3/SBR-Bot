-- CreateEnum
CREATE TYPE "MetricPeriod" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "discordId" TEXT,
    "surface" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "ts" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricRollup" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "metric" TEXT NOT NULL,
    "period" "MetricPeriod" NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "dims" JSONB NOT NULL DEFAULT '{}',
    "count" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsEvent_guildId_type_ts_idx" ON "AnalyticsEvent"("guildId", "type", "ts");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_ts_idx" ON "AnalyticsEvent"("ts");

-- CreateIndex
CREATE INDEX "MetricRollup_guildId_metric_period_bucketStart_idx" ON "MetricRollup"("guildId", "metric", "period", "bucketStart");

-- CreateIndex
CREATE INDEX "MetricRollup_period_bucketStart_idx" ON "MetricRollup"("period", "bucketStart");
