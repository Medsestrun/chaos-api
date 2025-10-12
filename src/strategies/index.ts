import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import strategyRunner from '../services/strategyRunner';

const StrategySchema = z.object({
  minPrice: z.number().min(0, 'Required'),
  maxPrice: z.number().min(0, 'Required'),
  numberOfGrids: z.number().min(0, 'Required'),
  margin: z.number().min(0, 'Required'),
  orderSizeLevels: z.array(
    z.object({
      levelStart: z.number().min(0, 'Required'),
      levelEnd: z.number().min(0, 'Required'),
      size: z.number().min(0, 'Required'),
    }),
  ),
});

const ToggleEnabledSchema = z.object({
  enabled: z.boolean(),
});

const CalculateGridSchema = z.object({
  minPrice: z.number().min(0, 'Required'),
  maxPrice: z.number().min(0, 'Required'),
  numberOfGrids: z.number().min(0, 'Required'),
});

type Grid = z.infer<typeof CalculateGridSchema>;

const app = new Hono();

const calculateGrid = (config: Grid): number[] => {
  const { minPrice, maxPrice, numberOfGrids } = config;

  if (numberOfGrids === 1) {
    return [Math.floor((minPrice + maxPrice) / 2)];
  }

  const stepSize = (maxPrice - minPrice) / (numberOfGrids - 1);

  const grids: number[] = [];
  for (let i = 0; i < numberOfGrids; i++) {
    const price = Math.floor(minPrice + stepSize * i);
    grids.push(price);
  }

  return grids;
};

app.post('/', zValidator('json', StrategySchema), async (c) => {
  const payload = c.req.valid('json');

  const grid = calculateGrid({
    minPrice: payload.minPrice,
    maxPrice: payload.maxPrice,
    numberOfGrids: payload.numberOfGrids,
  });

  const strategyId = crypto.randomUUID();

  await db.insert(schema.strategies).values({
    id: strategyId,
    settings: {
      grid: grid,
      minPrice: payload.minPrice,
      maxPrice: payload.maxPrice,
    },
    margin: payload.margin,
    balance: payload.margin,
    enabled: false,
  });

  if (payload.orderSizeLevels.length > 0) {
    await db.insert(schema.orderSizeLevels).values(
      payload.orderSizeLevels.map((level) => ({
        strategyId: strategyId,
        levelStart: level.levelStart,
        levelEnd: level.levelEnd,
        size: level.size,
      })),
    );
  }

  return c.json({ strategyId });
});

app.patch('/:strategyId/toggle', zValidator('json', ToggleEnabledSchema), async (c) => {
  const strategyId = c.req.param('strategyId');
  const { enabled } = c.req.valid('json');

  const result = await db.update(schema.strategies).set({ enabled }).where(eq(schema.strategies.id, strategyId)).returning();

  if (!result[0]) {
    return c.json({ error: 'Strategy not found' }, 404);
  }

  if (enabled) {
    try {
      await strategyRunner.enableStrategy(strategyId);
    } catch (error) {
      console.error('Error enabling strategy:', error);
      return c.json(
        {
          error: 'Failed to enable strategy',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        500,
      );
    }
  } else {
    await strategyRunner.stop();
  }

  return c.json({
    strategyId: result[0].id,
    enabled: result[0].enabled,
  });
});

export default app;
