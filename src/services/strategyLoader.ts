import { eq } from 'drizzle-orm';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import memoryStorage from '../MemoryStorage';

type StrategySettings = {
  grid: number[];
  minPrice: number;
  maxPrice: number;
};

type Strategy = Omit<typeof schema.strategies.$inferSelect, 'settings'> & {
  settings: StrategySettings;
};

type OrderSizeLevel = typeof schema.orderSizeLevels.$inferSelect;
type Position = typeof schema.positions.$inferSelect;
type Order = typeof schema.orders.$inferSelect;

/**
 * Загружает стратегию и её данные в память
 * @param strategyId - ID конкретной стратегии, или null для загрузки первой включенной
 * @returns true если стратегия успешно загружена, false в противном случае
 */
export const loadStrategy = async (strategyId: string | null = null): Promise<boolean> => {
  try {
    // Выбираем стратегию в зависимости от параметра
    const strategies = strategyId
      ? await db.select().from(schema.strategies).where(eq(schema.strategies.id, strategyId)).limit(1)
      : await db.select().from(schema.strategies).where(eq(schema.strategies.enabled, true)).limit(1);

    if (strategies.length === 0 || !strategies[0]) {
      const message = strategyId ? `Strategy ${strategyId} not found` : 'No enabled strategy found';
      console.log(message);
      return false;
    }

    const strategy = strategies[0] as Strategy;
    console.log(`Loading strategy: ${strategy.id}`);

    // Загружаем уровни размеров ордеров
    // TODO: Нужно свериться с гипером
    const orderSizeLevels = await db.select().from(schema.orderSizeLevels).where(eq(schema.orderSizeLevels.strategyId, strategy.id));

    // Загружаем позиции
    const positions = await db.select().from(schema.positions).where(eq(schema.positions.strategyId, strategy.id));

    // Загружаем только открытые ордера
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.status, 'OPENED'));

    // Сохраняем в памяти
    memoryStorage.setStrategy(strategy);
    memoryStorage.setOrderSizeLevels(orderSizeLevels as OrderSizeLevel[]);
    memoryStorage.setPositions(positions as Position[]);
    memoryStorage.setOrders(orders as Order[]);

    console.log(`Strategy loaded: ${strategy.id}`);
    console.log(`  - Order size levels: ${orderSizeLevels.length}`);
    console.log(`  - Positions: ${positions.length}`);
    console.log(`  - Open Orders: ${orders.length}`);

    return true;
  } catch (error) {
    console.error('Error loading strategy:', error);
    return false;
  }
};
