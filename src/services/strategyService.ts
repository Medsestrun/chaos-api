import BigNumber from 'bignumber.js';
import { eq } from 'drizzle-orm';
import type { WsUserFill } from 'hyperliquid';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import memoryStorage from '../MemoryStorage';

class StrategyService {
  private static instance: StrategyService;

  private constructor() {}

  static getInstance(): StrategyService {
    if (!StrategyService.instance) {
      StrategyService.instance = new StrategyService();
    }
    return StrategyService.instance;
  }

  /**
   * Обрабатывает заполнение сервисного ордера INITIAL_POSITIONS_BUY_UP
   * Создает позиции для всех гридов выше начальной цены
   */
  async handleInitialPositionsFill(
    serviceOrder: { id: number; side: 'BUY' | 'SELL'; meta: Record<string, unknown>; type: string },
    fill: WsUserFill,
  ): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      console.error('Strategy not found');
      return;
    }

    console.log('Handling initial positions fill:', {
      fillPrice: fill.px,
      fillSize: fill.sz,
      fee: fill.fee,
      meta: serviceOrder.meta,
    });

    const initialPrice = Number(serviceOrder.meta.initialPrice);
    const grid = strategy.settings.grid;

    // Находим первый грид выше начальной цены
    const startGridIndex = this.findGridIndex(initialPrice);

    if (startGridIndex === -1 || startGridIndex >= grid.length) {
      console.error('Invalid grid index');
      return;
    }

    // Количество позиций для создания
    const numberOfPositions = grid.length - startGridIndex;

    // Общий размер купленной позиции в ETH
    const totalSizeInEth = new BigNumber(fill.sz);

    // Размер одной позиции = общий размер / количество позиций
    const sizePerPosition = totalSizeInEth.dividedBy(numberOfPositions).decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();

    console.log(`Total size: ${fill.sz} ETH, Positions: ${numberOfPositions}, Size per position: ${sizePerPosition} ETH`);

    // Создаем позиции для каждого грида выше начальной цены
    const positionsToCreate: Array<{
      strategyId: string;
      size: number;
      status: 'OPENED';
      gridOpenPrice: number;
      avgOpenPrice: number;
      gridClosePrice: number | null;
    }> = [];

    for (let i = startGridIndex; i < grid.length; i++) {
      const gridPrice = grid[i];
      if (gridPrice !== undefined) {
        // Цена закрытия - следующий грид
        const closeGridPrice = i + 1 < grid.length ? grid[i + 1] : null;

        positionsToCreate.push({
          strategyId: strategy.id,
          size: sizePerPosition,
          status: 'OPENED',
          gridOpenPrice: gridPrice,
          avgOpenPrice: Number(fill.px),
          gridClosePrice: closeGridPrice !== undefined ? closeGridPrice : null,
        });
      }
    }

    if (positionsToCreate.length === 0) {
      console.error('No positions to create');
      return;
    }

    const createdPositions = await db.insert(schema.positions).values(positionsToCreate).returning();

    for (const position of createdPositions) {
      memoryStorage.addPosition(position as typeof schema.positions.$inferSelect);
    }

    memoryStorage.removeServiceOrder(fill.oid);

    console.log(`Created ${createdPositions.length} positions, starting normal order sync`);

    memoryStorage.updateBalance(-Number(fill.fee));

    await db
      .update(schema.strategies)
      .set({
        balance: memoryStorage.getBalance(),
      })
      .where(eq(schema.strategies.id, strategy.id));

    // Запускаем обычную синхронизацию ордеров
    // await this.syncOrders();
  }

  findGridIndex(price: number): number {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) return -1;

    const grid = strategy.settings.grid;

    // Найти первый грид выше текущей цены
    for (let i = 0; i < grid.length; i++) {
      const gridPrice = grid[i];
      if (gridPrice !== undefined && price < gridPrice) {
        return i;
      }
    }

    // Если цена выше всех гридов
    return grid.length;
  }

  /**
   * Вычисляет размер ордера в ETH для заданной цены в USDT
   */
  getOrderSizeInEth(ethPrice: number, orderSizeInUsdt: number): number {
    const usdtAmount = new BigNumber(orderSizeInUsdt);
    const price = new BigNumber(ethPrice);
    const orderSize = usdtAmount.dividedBy(price);
    return orderSize.decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();
  }
}

export default StrategyService.getInstance();
