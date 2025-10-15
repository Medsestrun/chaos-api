import BigNumber from 'bignumber.js';
import { eq } from 'drizzle-orm';
import type { WsUserFill } from 'hyperliquid';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import { getOrderSizeForGrid } from '../common/utils';
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

  async handleInitialPositionsFill(serviceOrder: typeof schema.orders.$inferSelect, fill: WsUserFill): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      console.error('Strategy not found');
      return;
    }

    const initialPrice = serviceOrder.averagePrice;
    const grid = strategy.settings.grid;
    const startGridIndex = this.findGridUpperIndex(initialPrice);

    if (startGridIndex === -1 || startGridIndex >= grid.length) {
      console.error('Invalid grid index');
      return;
    }

    const totalSizeInEth = new BigNumber(fill.sz);

    let totalExpectedSizeInUsdt = new BigNumber(0);
    for (let i = startGridIndex; i < grid.length; i++) {
      const gridPrice = grid[i];
      if (gridPrice !== undefined) {
        const orderSizeUsdt = getOrderSizeForGrid(gridPrice);
        totalExpectedSizeInUsdt = totalExpectedSizeInUsdt.plus(orderSizeUsdt);
      }
    }

    console.log(`Total filled: ${fill.sz} ETH, Expected total: ${totalExpectedSizeInUsdt.toString()} USDT`);

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
        // Получаем целевой размер для этого грида в USDT
        const orderSizeUsdt = getOrderSizeForGrid(gridPrice);

        // Рассчитываем размер позиции пропорционально целевому размеру
        const sizeInEth = totalExpectedSizeInUsdt.isZero()
          ? totalSizeInEth.dividedBy(grid.length - startGridIndex)
          : new BigNumber(orderSizeUsdt).dividedBy(totalExpectedSizeInUsdt).multipliedBy(totalSizeInEth);

        const roundedSize = sizeInEth.decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();

        // Цена закрытия - следующий грид
        const closeGridPrice = i + 1 < grid.length ? grid[i + 1] : null;

        console.log(`Position for grid ${gridPrice}: ${roundedSize} ETH (target: ${orderSizeUsdt} USDT)`);

        positionsToCreate.push({
          strategyId: strategy.id,
          size: roundedSize,
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

    memoryStorage.removeOrder(fill.oid);

    memoryStorage.updateBalance(-Number(fill.fee));

    await db
      .update(schema.strategies)
      .set({
        balance: memoryStorage.getBalance(),
      })
      .where(eq(schema.strategies.id, strategy.id));

    await db
      .update(schema.orders)
      .set({
        status: 'FILLED',
        fee: Number(fill.fee),
        closedAt: new Date().toISOString(),
      })
      .where(eq(schema.orders.id, fill.oid));

    console.log(`Created ${createdPositions.length} positions, starting normal order sync`);
  }

  findGridUpperIndex(price: number): number {
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

  findFirstGridLower(price: number): number | null {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) return null;

    const grid = strategy.settings.grid;

    // Найти первый грид <= текущей цены (ближайший снизу или равный)
    for (let i = grid.length - 1; i >= 0; i--) {
      const gridPrice = grid[i];
      if (gridPrice !== undefined && price >= gridPrice) {
        return gridPrice;
      }
    }

    return null;
  }

  /**
   * Находит один грид для покупки (без открытой позиции и без открытого BUY ордера)
   * @param currentPrice - текущая цена
   * @returns объект с индексом грида, ценой и размером
   * @throws Error если не найден подходящий грид для покупки или выход за пределы грида
   */
  findBuyTargets(currentPrice: number): { gridIndex: number; price: number; size: number } | null {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      return null;
    }

    const grid = strategy.settings.grid;
    const currentGridIndex = this.findGridUpperIndex(currentPrice);
    const openPositions = memoryStorage.getOpenPositions();
    const openOrders = memoryStorage.getOpenOrders();

    // Создаем Map открытых позиций по индексу грида
    const positionsByGrid = new Map<number, (typeof openPositions)[0]>();
    for (const position of openPositions) {
      const gridIndex = grid.indexOf(position.gridOpenPrice);
      if (gridIndex !== -1) {
        positionsByGrid.set(gridIndex, position);
      }
    }

    // Создаем Set цен, на которые уже открыты BUY ордера
    const buyOrderPrices = new Set<number>();
    for (const order of openOrders) {
      if (order.side === 'BUY') {
        buyOrderPrices.add(order.averagePrice);
      }
    }

    // Сначала ищем грида ниже текущей цены (приоритетные)
    for (let i = currentGridIndex - 1; i >= 0; i--) {
      const gridPrice = grid[i];
      const hasPosition = positionsByGrid.has(i);
      const hasOpenOrder = gridPrice !== undefined && buyOrderPrices.has(gridPrice);

      if (!hasPosition && !hasOpenOrder && gridPrice !== undefined) {
        const orderSize = getOrderSizeForGrid(gridPrice);
        if (orderSize > 0) {
          return { gridIndex: i, price: gridPrice, size: orderSize };
        }
      }
    }

    // Проверяем, что не вышли за нижний предел грида
    if (currentGridIndex <= 0) {
      return null;
    }

    // Если не нашли ниже текущей цены, ищем любой свободный грид
    for (let i = 0; i < grid.length; i++) {
      const gridPrice = grid[i];
      const hasPosition = positionsByGrid.has(i);
      const hasOpenOrder = gridPrice !== undefined && buyOrderPrices.has(gridPrice);

      if (!hasPosition && !hasOpenOrder && gridPrice !== undefined) {
        const orderSize = getOrderSizeForGrid(gridPrice);
        if (orderSize > 0) {
          return { gridIndex: i, price: gridPrice, size: orderSize };
        }
      }
    }

    return null;
  }

  /**
   * Находит одну открытую позицию для продажи (без открытого SELL ордера на эту позицию)
   * @param currentPrice - текущая цена
   * @returns объект с позицией и ценой закрытия
   * @throws Error если не найдена подходящая позиция или выход за пределы грида
   */
  findSellTargets(currentPrice: number): { position: typeof schema.positions.$inferSelect; closePrice: number } | null {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      return null;
    }

    const grid = strategy.settings.grid;
    const currentGridIndex = this.findGridUpperIndex(currentPrice);
    const openPositions = memoryStorage.getOpenPositions();
    const openOrders = memoryStorage.getOpenOrders();

    // Создаем Map открытых позиций по индексу грида
    const positionsByGrid = new Map<number, (typeof openPositions)[0]>();
    for (const position of openPositions) {
      const gridIndex = grid.indexOf(position.gridOpenPrice);
      if (gridIndex !== -1) {
        positionsByGrid.set(gridIndex, position);
      }
    }

    // Создаем Set ID позиций, на которые уже открыты SELL ордера
    const positionsWithSellOrders = new Set<number>();
    for (const order of openOrders) {
      if (order.side === 'SELL' && order.positionId !== null) {
        positionsWithSellOrders.add(order.positionId);
      }
    }

    // Сначала ищем позиции ниже текущей цены (приоритетные)
    for (let i = currentGridIndex - 1; i >= 0; i--) {
      const position = positionsByGrid.get(i);
      if (position && !positionsWithSellOrders.has(position.id)) {
        const closeGridIndex = i + 1;

        // Проверяем, что мы не вышли за пределы грида
        if (closeGridIndex >= grid.length) {
          return null;
        }

        const closePrice = grid[closeGridIndex];
        if (closePrice === undefined) {
          return null;
        }

        return { position, closePrice };
      }
    }

    // Если не нашли ниже текущей цены, ищем любую доступную позицию
    for (const position of openPositions) {
      if (!positionsWithSellOrders.has(position.id)) {
        if (!position.gridClosePrice) {
          return null;
        }
        return {
          position,
          closePrice: position.gridClosePrice,
        };
      }
    }

    return null;
  }

  async saveOpenedOrderToDB(
    orderId: number,
    size: number,
    side: 'BUY' | 'SELL',
    price: number,
    orderType: 'REGULAR' | 'INITIAL_POSITIONS_BUY_UP' | 'FILL_EMPTY_POSITIONS' | 'ORDER_SIZE_INCREASE' = 'REGULAR',
    positionId: number | null = null,
  ): Promise<void> {
    try {
      const order = await db
        .insert(schema.orders)
        .values({
          id: orderId,
          size: size,
          side: side,
          positionId: positionId,
          status: 'OPENED',
          type: orderType,
          averagePrice: price,
          fee: 0,
          closedPnl: 0,
        })
        .returning();

      if (order[0]) {
        memoryStorage.addOrder(order[0] as typeof schema.orders.$inferSelect);
        console.log(`Order ${orderId} saved to DB (${side} at ${price})`);
      }
    } catch (error) {
      console.error('Error saving opened order to DB:', error);
    }
  }

  async handleBuyOrderFill(fill: WsUserFill): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      console.error('Strategy not found');
      return;
    }

    try {
      // Находим ордер в памяти, чтобы получить целевую цену грида
      const openOrders = memoryStorage.getOrders();
      const order = openOrders.find((o) => o.id === fill.oid);

      if (!order) {
        console.error('Order not found in memory:', fill.oid);
        return;
      }

      const grid = strategy.settings.grid;

      // Используем целевую цену грида из ордера (averagePrice), а не фактическую цену исполнения
      // Это важно, т.к. LIMIT ордер может исполниться по лучшей цене
      const gridPrice = this.findFirstGridLower(order.averagePrice);

      if (gridPrice === null) {
        console.error('Grid price not found for target price:', order.averagePrice);
        console.log('Available grids:', grid);
        return;
      }

      const gridIndex = grid.indexOf(gridPrice);
      const closeGridPrice = gridIndex !== -1 && gridIndex + 1 < grid.length ? grid[gridIndex + 1] : null;

      // Создаем позицию
      const createdPosition = await db
        .insert(schema.positions)
        .values({
          strategyId: strategy.id,
          size: Number(fill.sz),
          status: 'OPENED',
          gridOpenPrice: gridPrice, // целевой грид
          avgOpenPrice: Number(fill.px), // фактическая цена исполнения
          gridClosePrice: closeGridPrice !== undefined ? closeGridPrice : null,
        })
        .returning();

      if (!createdPosition[0]) {
        console.error('Failed to create position');
        return;
      }

      const position = createdPosition[0] as typeof schema.positions.$inferSelect;
      memoryStorage.addPosition(position);

      // Обновляем ордер - привязываем к позиции и обновляем статус
      // Перезаписываем averagePrice фактической ценой исполнения (для отчетности)
      await db
        .update(schema.orders)
        .set({
          status: 'FILLED',
          positionId: position.id,
          averagePrice: Number(fill.px), // фактическая цена исполнения
          fee: Number(fill.fee),
          closedAt: new Date().toISOString(),
        })
        .where(eq(schema.orders.id, fill.oid));

      // Обновляем баланс (вычитаем комиссию)
      memoryStorage.updateBalance(-Number(fill.fee));

      await db
        .update(schema.strategies)
        .set({
          balance: memoryStorage.getBalance(),
        })
        .where(eq(schema.strategies.id, strategy.id));

      // Удаляем ордер из памяти (т.к. он уже FILLED)
      memoryStorage.removeOrder(fill.oid);

      console.log(`BUY order ${fill.oid} filled: created position ${position.id} at ${gridPrice}, close at ${closeGridPrice}`);
    } catch (error) {
      console.error('Error handling BUY order fill:', error);
    }
  }

  async handleSellOrderFill(fill: WsUserFill): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      console.error('Strategy not found');
      return;
    }

    try {
      // Находим ордер в памяти, чтобы получить positionId
      const order = memoryStorage.getOrders().find((o) => o.id === fill.oid);

      if (!order || !order.positionId) {
        console.error('Order or position not found for SELL fill:', fill.oid);
        return;
      }

      // Находим позицию
      const position = memoryStorage.getPositions().find((p) => p.id === order.positionId);

      if (!position) {
        console.error('Position not found:', order.positionId);
        return;
      }

      // Рассчитываем PnL на основе фактических цен исполнения
      const closedPnl = (Number(fill.px) - position.avgOpenPrice) * Number(fill.sz);

      console.log(`SELL fill: target price ${order.averagePrice}, actual fill price ${fill.px}, PnL: ${closedPnl.toFixed(2)}`);

      // Закрываем позицию
      await db
        .update(schema.positions)
        .set({
          status: 'CLOSED',
        })
        .where(eq(schema.positions.id, position.id));

      // Обновляем ордер
      // Перезаписываем averagePrice фактической ценой исполнения (для отчетности)
      await db
        .update(schema.orders)
        .set({
          status: 'FILLED',
          averagePrice: Number(fill.px), // фактическая цена исполнения
          fee: Number(fill.fee),
          closedPnl: closedPnl,
          closedAt: new Date().toISOString(),
        })
        .where(eq(schema.orders.id, fill.oid));

      memoryStorage.updateBalance(closedPnl);
      memoryStorage.updateBalance(-Number(fill.fee));

      await db
        .update(schema.strategies)
        .set({
          balance: memoryStorage.getBalance(),
        })
        .where(eq(schema.strategies.id, strategy.id));

      // Удаляем позицию и ордер из памяти
      memoryStorage.removePosition(position.id);
      memoryStorage.removeOrder(fill.oid);

      console.log(`SELL order ${fill.oid} filled: closed position ${position.id}, PnL: ${closedPnl.toFixed(2)}`);
    } catch (error) {
      console.error('Error handling SELL order fill:', error);
    }
  }
}

export default StrategyService.getInstance();
