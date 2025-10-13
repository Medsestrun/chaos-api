import BigNumber from 'bignumber.js';
import { eq } from 'drizzle-orm';
import type { OrderResponse, WsUserFill } from 'hyperliquid';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import memoryStorage from '../MemoryStorage';

type Order = typeof schema.orders.$inferSelect;

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
   * @returns массив целей с индексом грида, ценой и размером
   */
  findBuyTargets(currentPrice: number, limit = 1): Array<{ gridIndex: number; price: number; size: number }> {
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

    // Находим ближайших грида ниже текущей цены без открытых позиций и ордеров
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

    return buyTargets;
  }

  /**
   * Находит открытые позиции для продажи (без открытых SELL ордеров на эти позиции)
   * @param currentPrice - текущая цена
   * @param limit - максимальное количество целей для продажи
   * @returns массив целей с позицией и ценой закрытия
   */
  findSellTargets(currentPrice: number, limit = 1): Array<{ position: typeof schema.positions.$inferSelect; closePrice: number }> {
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

    return sellTargets;
  }

  /**
   * Сохраняет ордер в БД и обновляет память
   * TODO: Будет использоваться после раскомментирования кода в placeBuyOrder/placeSellOrder
   */
  async saveOrderToDB(type: 'OPEN' | 'CLOSE', order: Order): Promise<void> {
    try {
      if (type === 'OPEN') {
        const createdOrder = await db
          .insert(schema.orders)
          .values({
            id: order.id,
            size: order.size,
            side: order.side,
            //   positionId: positionId || null,
            positionId: null,
            status: 'OPENED',
            averagePrice: order.averagePrice,
            fee: 0,
            closedPnl: 0,
          })
          .returning();

        if (createdOrder[0]) {
          memoryStorage.addOrder(createdOrder[0] as Order);
          console.log(`Order ${order.id} opened`);
        }
      } else {
        await db
          .update(schema.orders)
          .set({
            status: 'FILLED',
            closedAt: new Date().toISOString(),
            fee: order.fee,
            closedPnl: order.closedPnl,
            averagePrice: order.averagePrice,
          })
          .where(eq(schema.orders.id, order.id));

        memoryStorage.updateBalance(order.closedPnl);
        memoryStorage.updateBalance(-Number(order.fee));

        await db
          .update(schema.strategies)
          .set({
            balance: memoryStorage.getBalance(),
          })
          .where(eq(schema.strategies.id, memoryStorage.getStrategy()?.id || ''));

        memoryStorage.removeOrder(order.id);
        console.log(`Order ${order.id} closed`);
      }
    } catch (error) {
      console.error('Error saving order to DB:', error);
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
