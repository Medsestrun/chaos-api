import BigNumber from 'bignumber.js';
import { eq } from 'drizzle-orm';
import type { OrderResponse, WsUserFill } from 'hyperliquid';
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
    const startGridIndex = this.findGridUpperIndex(initialPrice);

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

  /**
   * Округляет цену до 1 знака после запятой
   */
  roundPrice(price: number): number {
    return new BigNumber(price).decimalPlaces(1, BigNumber.ROUND_DOWN).toNumber();
  }

  /**
   * Округляет размер до 4 знаков после запятой
   */
  roundSize(size: number): number {
    return new BigNumber(size).decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();
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

  findFirstGridLower(price: number): number | null {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) return null;

    const grid = strategy.settings.grid;

    // Найти первый грид ниже текущей цены
    for (let i = grid.length - 1; i >= 0; i--) {
      const gridPrice = grid[i];
      if (gridPrice !== undefined && price > gridPrice) {
        return gridPrice;
      }
    }

    return null;
  }

  /**
   * Находит грида для покупки (без открытых позиций и без открытых BUY ордеров, ниже текущей цены)
   * @param currentPrice - текущая цена
   * @param limit - максимальное количество целей для покупки
   * @param ensureMinimum - гарантировать минимум 1 цель, даже если далеко от текущей цены
   * @returns массив целей с индексом грида, ценой и размером
   */
  findBuyTargets(currentPrice: number, limit = 1, ensureMinimum = false): Array<{ gridIndex: number; price: number; size: number }> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) return [];

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
    const buyTargets: Array<{ gridIndex: number; price: number; size: number }> = [];
    for (let i = currentGridIndex - 1; i >= 0 && buyTargets.length < limit; i--) {
      const gridPrice = grid[i];
      const hasPosition = positionsByGrid.has(i);
      const hasOpenOrder = gridPrice !== undefined && buyOrderPrices.has(gridPrice);

      if (!hasPosition && !hasOpenOrder && gridPrice !== undefined) {
        const orderSize = memoryStorage.getOrderSizeForGrid(gridPrice);
        if (orderSize > 0) {
          buyTargets.push({ gridIndex: i, price: gridPrice, size: orderSize });
        }
      }
    }

    // Если не нашли достаточно целей и нужно гарантировать минимум - ищем любой свободный грид
    if (ensureMinimum && buyTargets.length === 0) {
      for (let i = 0; i < grid.length; i++) {
        const gridPrice = grid[i];
        const hasPosition = positionsByGrid.has(i);
        const hasOpenOrder = gridPrice !== undefined && buyOrderPrices.has(gridPrice);

        if (!hasPosition && !hasOpenOrder && gridPrice !== undefined) {
          const orderSize = memoryStorage.getOrderSizeForGrid(gridPrice);
          if (orderSize > 0) {
            buyTargets.push({ gridIndex: i, price: gridPrice, size: orderSize });
            break; // Нужен хотя бы один
          }
        }
      }
    }

    return buyTargets;
  }

  /**
   * Находит открытые позиции для продажи (без открытых SELL ордеров на эти позиции)
   * @param currentPrice - текущая цена
   * @param limit - максимальное количество целей для продажи
   * @param ensureMinimum - гарантировать минимум 1 цель, даже если далеко от текущей цены
   * @returns массив целей с позицией и ценой закрытия
   */
  findSellTargets(
    currentPrice: number,
    limit = 1,
    ensureMinimum = false,
  ): Array<{ position: typeof schema.positions.$inferSelect; closePrice: number }> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) return [];

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

    // Находим ближайших открытых позиции для продажи без открытых SELL ордеров
    const sellTargets: Array<{ position: (typeof openPositions)[0]; closePrice: number }> = [];

    // Сначала ищем позиции ниже текущей цены (приоритетные)
    for (let i = currentGridIndex - 1; i >= 0 && sellTargets.length < limit; i--) {
      const position = positionsByGrid.get(i);
      if (position && !positionsWithSellOrders.has(position.id)) {
        const closeGridIndex = i + 1;
        if (closeGridIndex < grid.length) {
          const closePrice = grid[closeGridIndex];
          if (closePrice !== undefined) {
            sellTargets.push({ position, closePrice });
          }
        }
      }
    }

    // Если не нашли достаточно целей и нужно гарантировать минимум - ищем любые позиции
    if (ensureMinimum && sellTargets.length === 0) {
      for (const position of openPositions) {
        if (!positionsWithSellOrders.has(position.id) && position.gridClosePrice) {
          sellTargets.push({
            position,
            closePrice: position.gridClosePrice,
          });
          break; // Нужна хотя бы одна
        }
      }
    }

    return sellTargets;
  }

  /**
   * Сохраняет открытый ордер в БД при выставлении
   */
  async saveOpenedOrderToDB(
    orderId: number,
    size: number,
    side: 'BUY' | 'SELL',
    price: number,
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

  /**
   * Обрабатывает заполнение BUY ордера
   * Создает позицию в БД и привязывает к ней ордер
   */
  async handleBuyOrderFill(fill: WsUserFill): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy) {
      console.error('Strategy not found');
      return;
    }

    try {
      // Находим ордер в памяти, чтобы получить целевую цену грида
      const order = memoryStorage.getOrders().find((o) => o.id === fill.oid);

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
        return;
      }

      const gridIndex = grid.indexOf(gridPrice);
      const closeGridPrice = gridIndex !== -1 && gridIndex + 1 < grid.length ? grid[gridIndex + 1] : null;

      console.log(`BUY fill: target grid ${gridPrice}, actual fill price ${fill.px}`);

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

  /**
   * Обрабатывает заполнение SELL ордера
   * Закрывает позицию в БД
   */
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

      // Обновляем баланс (добавляем PnL, вычитаем комиссию)
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

  /**
   * Извлекает ID ордера из одного статуса
   * @param status - элемент из массива statuses
   * @returns ID ордера или null
   * @example
   * const orderResponse = await sdk.placeOrder(...);
   * for (const status of orderResponse.response.data.statuses) {
   *   const orderId = strategyService.getOrderIdFromStatus(status);
   *   if (orderId) {
   *     console.log('Order ID:', orderId);
   *   }
   * }
   */
  getOrderIdFromStatus(status: OrderResponse['response']['data']['statuses'][0]): number | null {
    return status?.filled?.oid || status?.resting?.oid || null;
  }

  /**
   * Извлекает все ID ордеров из ответа биржи
   * @param orderData - данные ответа от биржи
   * @returns массив ID ордеров
   */
  getAllOrderIdsFromResponse(orderData: OrderResponse['response']['data']): number[] {
    if (!orderData?.statuses) return [];

    const orderIds: number[] = [];
    for (const status of orderData.statuses) {
      const orderId = this.getOrderIdFromStatus(status);
      if (orderId !== null) {
        orderIds.push(orderId);
      }
    }

    return orderIds;
  }
}

export default StrategyService.getInstance();
