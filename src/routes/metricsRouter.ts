import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import metricsService from '../services/metricsService';

const PeriodQuerySchema = z.object({
  period: z.enum(['hour', 'day', 'week', 'month']).optional().default('day'),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Number.parseInt(val, 10) : 30)),
});

const app = new Hono();

app.get('/:strategyId/aggregated', zValidator('query', PeriodQuerySchema), async (c) => {
  const strategyId = c.req.param('strategyId');
  const { period, limit } = c.req.valid('query');

  try {
    const aggregated = await metricsService.getAggregatedMetrics(strategyId, period, limit);
    return c.json({
      strategyId,
      period,
      limit,
      count: aggregated.length,
      data: aggregated,
    });
  } catch (error) {
    return c.json(
      {
        error: 'Failed to get aggregated metrics',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500,
    );
  }
});

export default app;
