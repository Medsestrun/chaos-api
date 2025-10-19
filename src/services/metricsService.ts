import BigNumber from 'bignumber.js';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import { logger } from '../common/logger';
import memoryStorage from '../MemoryStorage';

type MetricsData = {
  totalProfit: number;
  matchedProfit: number;
  unmatchedProfit: number;
  investedMargin: number;
  fundingFee: number;
  totalFees: number;
  currentPrice: number;
  openPositionsCount: number;
  closedPositionsCount: number;
  totalTradesCount: number;
};

type PeriodType = 'hour' | 'day' | 'week' | 'month';

type AggregatedMetrics = {
  period: string;
  avgTotalProfit: number;
  avgMatchedProfit: number;
  avgUnmatchedProfit: number;
  avgInvestedMargin: number;
  totalFundingFee: number;
  totalFees: number;
  avgCurrentPrice: number;
  maxOpenPositions: number;
  totalClosedPositions: number;
  totalTrades: number;
  snapshotsCount: number;
};

class MetricsService {
  private static instance: MetricsService;

  private constructor() {}

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  async calculateMetrics(currentPrice: number): Promise<MetricsData> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      throw new Error('Strategy not found');
    }

    const totalProfitResult = await db
      .select({
        realizedPnl: sql<number>`COALESCE(SUM(${schema.orders.closedPnl}), 0)`,
      })
      .from(schema.orders)
      .where(and(eq(schema.orders.status, 'FILLED'), eq(schema.orders.side, 'SELL')));

    const totalFeesResult = await db
      .select({
        fees: sql<number>`COALESCE(SUM(${schema.orders.fee}), 0)`,
      })
      .from(schema.orders)
      .where(eq(schema.orders.status, 'FILLED'));

    const fundingFeesResult = await db
      .select({
        fundingFees: sql<number>`COALESCE(SUM(${schema.fundings.fee}), 0)`,
      })
      .from(schema.fundings);

    const realizedPnl = totalProfitResult[0]?.realizedPnl || 0;
    const totalFees = totalFeesResult[0]?.fees || 0;
    const fundingFee = fundingFeesResult[0]?.fundingFees || 0;
    const totalProfit = BigNumber(realizedPnl).minus(totalFees).minus(fundingFee).toNumber();

    const matchedProfitResult = await db
      .select({
        matchedPnl: sql<number>`COALESCE(SUM(${schema.orders.closedPnl}), 0)`,
        matchedFees: sql<number>`COALESCE(SUM(${schema.orders.fee}), 0)`,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.status, 'FILLED'),
          eq(schema.orders.side, 'SELL'),
          sql`${schema.orders.positionId} IN (SELECT id FROM ${schema.positions} WHERE status = 'CLOSED')`,
        ),
      );

    const matchedPnl = matchedProfitResult[0]?.matchedPnl || 0;
    const matchedFees = matchedProfitResult[0]?.matchedFees || 0;
    const matchedProfit = BigNumber(matchedPnl).minus(matchedFees).toNumber();

    const openPositions = await db.select().from(schema.positions).where(eq(schema.positions.status, 'OPENED'));

    let unmatchedProfit = BigNumber(0);
    let investedMargin = BigNumber(0);

    for (const position of openPositions) {
      const positionPnl = BigNumber(currentPrice).minus(position.avgOpenPrice).multipliedBy(position.size);
      unmatchedProfit = unmatchedProfit.plus(positionPnl);
      const positionValue = BigNumber(position.avgOpenPrice).multipliedBy(position.size);
      investedMargin = investedMargin.plus(positionValue);
    }

    const closedPositionsResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.positions)
      .where(eq(schema.positions.status, 'CLOSED'));

    const totalTradesResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.orders)
      .where(eq(schema.orders.status, 'FILLED'));

    return {
      totalProfit,
      matchedProfit,
      unmatchedProfit: unmatchedProfit.toNumber(),
      investedMargin: investedMargin.toNumber(),
      fundingFee,
      totalFees,
      currentPrice,
      openPositionsCount: openPositions.length,
      closedPositionsCount: closedPositionsResult[0]?.count || 0,
      totalTradesCount: totalTradesResult[0]?.count || 0,
    };
  }

  async saveMetricsSnapshot(currentPrice: number): Promise<typeof schema.metricsSnapshots.$inferSelect> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      throw new Error('Strategy not found');
    }

    try {
      const metrics = await this.calculateMetrics(currentPrice);

      const snapshot = await db
        .insert(schema.metricsSnapshots)
        .values({
          strategyId: strategy.id,
          totalProfit: metrics.totalProfit,
          matchedProfit: metrics.matchedProfit,
          unmatchedProfit: metrics.unmatchedProfit,
          investedMargin: metrics.investedMargin,
          fundingFee: metrics.fundingFee,
          totalFees: metrics.totalFees,
          currentPrice: metrics.currentPrice,
          openPositionsCount: metrics.openPositionsCount,
          closedPositionsCount: metrics.closedPositionsCount,
          totalTradesCount: metrics.totalTradesCount,
        })
        .returning();

      logger.info('Metrics snapshot saved', { snapshotId: snapshot[0]?.id });

      return snapshot[0] as typeof schema.metricsSnapshots.$inferSelect;
    } catch (error) {
      logger.error('Error saving metrics snapshot:', error);
      throw error;
    }
  }

  async getAggregatedMetrics(strategyId: string, periodType: PeriodType, limit = 30): Promise<AggregatedMetrics[]> {
    let groupBy: string;

    switch (periodType) {
      case 'hour':
        groupBy = "strftime('%Y-%m-%d %H', datetime(timestamp, 'unixepoch'))";
        break;
      case 'day':
        groupBy = "strftime('%Y-%m-%d', datetime(timestamp, 'unixepoch'))";
        break;
      case 'week':
        groupBy = "strftime('%Y-W%W', datetime(timestamp, 'unixepoch'))";
        break;
      case 'month':
        groupBy = "strftime('%Y-%m', datetime(timestamp, 'unixepoch'))";
        break;
    }

    const results = await db
      .select({
        period: sql<string>`${sql.raw(groupBy)}`,
        avgTotalProfit: sql<number>`AVG(${schema.metricsSnapshots.totalProfit})`,
        avgMatchedProfit: sql<number>`AVG(${schema.metricsSnapshots.matchedProfit})`,
        avgUnmatchedProfit: sql<number>`AVG(${schema.metricsSnapshots.unmatchedProfit})`,
        avgInvestedMargin: sql<number>`AVG(${schema.metricsSnapshots.investedMargin})`,
        totalFundingFee: sql<number>`SUM(${schema.metricsSnapshots.fundingFee})`,
        totalFees: sql<number>`SUM(${schema.metricsSnapshots.totalFees})`,
        avgCurrentPrice: sql<number>`AVG(${schema.metricsSnapshots.currentPrice})`,
        maxOpenPositions: sql<number>`MAX(${schema.metricsSnapshots.openPositionsCount})`,
        totalClosedPositions: sql<number>`MAX(${schema.metricsSnapshots.closedPositionsCount})`,
        totalTrades: sql<number>`MAX(${schema.metricsSnapshots.totalTradesCount})`,
        snapshotsCount: sql<number>`COUNT(*)`,
      })
      .from(schema.metricsSnapshots)
      .where(eq(schema.metricsSnapshots.strategyId, strategyId))
      .groupBy(sql.raw(groupBy))
      .orderBy(sql`${sql.raw(groupBy)} DESC`)
      .limit(limit);

    return results.map((row) => ({
      period: row.period,
      avgTotalProfit: row.avgTotalProfit || 0,
      avgMatchedProfit: row.avgMatchedProfit || 0,
      avgUnmatchedProfit: row.avgUnmatchedProfit || 0,
      avgInvestedMargin: row.avgInvestedMargin || 0,
      totalFundingFee: row.totalFundingFee || 0,
      totalFees: row.totalFees || 0,
      avgCurrentPrice: row.avgCurrentPrice || 0,
      maxOpenPositions: row.maxOpenPositions || 0,
      totalClosedPositions: row.totalClosedPositions || 0,
      totalTrades: row.totalTrades || 0,
      snapshotsCount: row.snapshotsCount || 0,
    }));
  }
}

export default MetricsService.getInstance();
