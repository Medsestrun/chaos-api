import { inArray } from 'drizzle-orm';
import { Hyperliquid, type OrderResponse, type WsOrder, type WsUserFills } from 'hyperliquid';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import memoryStorage from '../MemoryStorage';
import strategyService from './strategyService';

type Order = typeof schema.orders.$inferSelect;

class HyperliquidService {
  private static instance: HyperliquidService;
  private sdk: Hyperliquid | null = null;
  private isConnected = false;
  private currentPrice = 0;
  private walletAddress = '';

  private constructor() {}

  static getInstance(): HyperliquidService {
    if (!HyperliquidService.instance) {
      HyperliquidService.instance = new HyperliquidService();
    }
    return HyperliquidService.instance;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      console.log('Already connected to Hyperliquid');
      return;
    }

    try {
      this.sdk = new Hyperliquid({
        enableWs: true,
        privateKey: process.env.PRIVATE_KEY,
      });

      await this.sdk.connect();
      console.log('Connected to Hyperliquid WebSocket');

      this.walletAddress = process.env.WALLET_ADDRESS || '';

      // Подписываемся на обновления цены
      this.sdk.subscriptions.subscribeToAllMids((data) => {
        if (data['ETH-PERP']) {
          this.currentPrice = Number(data['ETH-PERP']);
        }
      });

      // Подписываемся на заполнение ордеров
      if (this.walletAddress) {
        this.sdk.subscriptions.subscribeToUserFills(this.walletAddress, (fills) => {
          this.handleFills(fills);
        });

        // Подписываемся на обновления ордеров
        this.sdk.subscriptions.subscribeToOrderUpdates(this.walletAddress, (updates) => {
          this.handleOrderUpdates(updates);
        });
      }

      this.isConnected = true;
    } catch (error) {
      console.error('Error connecting to Hyperliquid:', error);
      throw error;
    }
  }

  /**
   * Обрабатывает заполненные ордера
   */
  private async handleFills(data: WsUserFills): Promise<void> {
    console.log('Received fills:', data.fills);
    const fill = data.fills[0];
    if (!fill) return;

    const serviceOrder = memoryStorage.findServiceOrder(fill.oid);

    if (data.fills.length > 1 && !data.isSnapshot) {
      console.log('Received multiple fills:', data.fills);
    }

    if (serviceOrder) {
      console.log('Processing service order fill:', serviceOrder.type);

      if (serviceOrder.type === 'INITIAL_POSITIONS_BUY_UP') {
        await strategyService.handleInitialPositionsFill(serviceOrder, fill);
      }

      return;
    }

    // После заполнения ордера - обновляем ордера
    // await this.syncOrders();
  }

  /**
   * Обрабатывает обновления ордеров
   */
  private async handleOrderUpdates(updates: WsOrder[]): Promise<void> {
    console.log('Received order updates:', updates);

    // Обновляем информацию об ордерах в памяти
    // TODO: Обработать cancelled, filled статусы
  }

  getCurrentPrice(): number {
    return this.currentPrice;
  }

  /**
   * Отменяет все открытые ордера
   */
  private async cancelAllOrders(): Promise<void> {
    const openOrders = memoryStorage.getOpenOrders();
    if (openOrders.length === 0) return;

    console.log(`Cancelling ${openOrders.length} open orders`);

    await this.sdk?.wsPayloads.cancelAllOrders();

    // TODO: Некоторые могут быть частично заполнены, нужно обработать этот случай

    await db
      .update(schema.orders)
      .set({ status: 'CANCELLED' })
      .where(
        inArray(
          schema.orders.id,
          openOrders.map((order) => order.id),
        ),
      );

    // Очищаем открытые ордера в памяти
    memoryStorage.setOrders([]);

    console.log('All orders cancelled');
  }

  /**
   * Проверяет открытые позиции и выставляет необходимые ордера
   * Выставляет только 2 BUY и 2 SELL ордера
   */
  async syncOrders(): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy || !this.isConnected || !this.sdk) {
      console.log('Strategy not loaded or not connected');
      return;
    }

    const currentPrice = this.getCurrentPrice();
    if (currentPrice === 0) {
      console.log('Current price not available yet');
      return;
    }

    console.log(`Syncing orders at price: ${currentPrice}`);

    // Отменяем все текущие ордера
    await this.cancelAllOrders();

    const grid = strategy.settings.grid;
    const currentGridIndex = strategyService.findGridIndex(currentPrice);
    const openPositions = memoryStorage.getOpenPositions();

    console.log(`Current grid index: ${currentGridIndex}, Open positions: ${openPositions.length}`);

    // Создаем Map открытых позиций по цене грида
    const positionsByGrid = new Map<number, (typeof openPositions)[0]>();
    for (const position of openPositions) {
      const gridIndex = grid.indexOf(position.gridOpenPrice);
      if (gridIndex !== -1) {
        positionsByGrid.set(gridIndex, position);
      }
    }

    // Находим 2 ближайших грида ниже текущей цены без открытых позиций
    const buyTargets: Array<{ gridIndex: number; price: number; size: number }> = [];
    for (let i = currentGridIndex - 1; i >= 0 && buyTargets.length < 2; i--) {
      const gridPrice = grid[i];
      const hasPosition = positionsByGrid.has(i);

      if (!hasPosition && gridPrice !== undefined) {
        const orderSize = memoryStorage.getOrderSizeForGrid(i);
        if (orderSize > 0) {
          buyTargets.push({ gridIndex: i, price: gridPrice, size: orderSize });
        }
      }
    }

    // Выставляем BUY ордера
    console.log(`Placing ${buyTargets.length} BUY orders`);
    for (const target of buyTargets) {
      await this.placeBuyOrder(target.price, target.size);
    }

    // Находим 2 ближайших открытых позиции для продажи
    const sellTargets: Array<{ position: (typeof openPositions)[0]; closePrice: number }> = [];
    for (let i = currentGridIndex - 1; i >= 0 && sellTargets.length < 2; i--) {
      const position = positionsByGrid.get(i);
      if (position) {
        const closeGridIndex = i + 1;
        if (closeGridIndex < grid.length) {
          const closePrice = grid[closeGridIndex];
          if (closePrice !== undefined) {
            sellTargets.push({ position, closePrice });
          }
        }
      }
    }

    // Выставляем SELL ордера
    console.log(`Placing ${sellTargets.length} SELL orders`);
    for (const target of sellTargets) {
      await this.placeSellOrder(target.closePrice, target.position.size, target.position.id);
    }
  }

  /**
   * Открывает все недостающие позиции при свежем старте
   * Покупает позиции для продажи на всех гридах ВЫШЕ текущей цены
   * Выставляет MARKET ордер с суммарным размером всех недостающих позиций
   */
  async openInitialPositions(): Promise<void> {
    const strategy = memoryStorage.getStrategy();
    if (!strategy || !this.isConnected || !this.sdk) {
      console.log('Strategy not loaded or not connected');
      return;
    }

    const currentPrice = this.getCurrentPrice();
    if (currentPrice === 0) {
      console.log('Current price not available yet');
      return;
    }

    const grid = strategy.settings.grid;
    const currentGridIndex = strategyService.findGridIndex(currentPrice); // Первый грид ВЫШЕ текущей цены
    const openPositions = memoryStorage.getOpenPositions();

    console.log(`Current price: ${currentPrice}, Next grid up index: ${currentGridIndex}, Open positions: ${openPositions.length}`);

    // Если уже есть открытые позиции, не делаем ничего
    if (openPositions.length > 0) {
      console.log('Positions already exist, skipping initial opening');
      return;
    }

    // Если нет гридов выше текущей цены или индекс некорректен
    if (currentGridIndex === -1 || currentGridIndex >= grid.length) {
      console.log('No grids above current price, skipping initial opening');
      return;
    }

    // Рассчитываем суммарный размер всех позиций для гридов ВЫШЕ текущей цены
    let totalSizeInUsdt = 0;
    for (let i = currentGridIndex; i < grid.length; i++) {
      const gridPrice = grid[i];
      if (gridPrice !== undefined) {
        const orderSize = memoryStorage.getOrderSizeForGrid(gridPrice);
        totalSizeInUsdt += orderSize;
      }
    }

    if (totalSizeInUsdt === 0) {
      console.log('Total size is 0, skipping initial opening');
      return;
    }

    console.log(`Placing MARKET BUY order for ${totalSizeInUsdt} USDT to open positions for ${grid.length - currentGridIndex} grids above`);

    const orderResponse = await this.placeBuyOrder(Math.floor(currentPrice) + 100, totalSizeInUsdt);

    if (orderResponse?.status !== 'ok') {
      console.log('Failed to place buy service order:', orderResponse?.status);
      return;
    }

    const filledInfo = orderResponse?.response?.data?.statuses[0]?.filled;
    memoryStorage.addServiceOrder({
      id: filledInfo?.oid || 0,
      type: 'INITIAL_POSITIONS_BUY_UP',
      side: 'BUY',
      meta: {
        initialPrice: currentPrice,
        numberOfPositions: grid.length - currentGridIndex,
      },
    });
  }

  private async placeBuyOrder(price: number, sizeInUsdt: number): Promise<OrderResponse | null> {
    if (!this.sdk) return null;

    try {
      const size = strategyService.getOrderSizeInEth(price, sizeInUsdt);

      console.log(`Placing LIMIT BUY order: price=${price}, size=${size} ETH`);

      const orderResponse = await this.sdk.wsPayloads.placeOrder({
        coin: 'ETH-PERP',
        is_buy: true,
        sz: size,
        limit_px: price.toString(),
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: false,
      });

      console.log('Buy order response:', JSON.stringify(orderResponse));

      // TODO: Извлечь ID ордера из ответа и сохранить в БД
      // const orderId = orderResponse.data?.orderId;
      // if (orderId) {
      //   await this.saveOrderToDB(orderId, size, 'BUY', price);
      // }
      return orderResponse as OrderResponse;
    } catch (error) {
      console.error('Error placing buy order:', error);
      return null;
    }
  }

  private async placeSellOrder(price: number, sizeInEth: number, positionId: number): Promise<OrderResponse | null> {
    if (!this.sdk) return null;

    try {
      console.log(`Placing SELL order: price=${price}, size=${sizeInEth} ETH, positionId=${positionId}`);

      const orderResponse = await this.sdk.wsPayloads.placeOrder({
        coin: 'ETH-PERP',
        is_buy: false,
        sz: sizeInEth,
        limit_px: price.toString(),
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: false,
      });

      console.log('Sell order response:', JSON.stringify(orderResponse));

      // TODO: Извлечь ID ордера из ответа и сохранить в БД
      // const orderId = orderResponse.data?.orderId;
      // if (orderId) {
      //   await this.saveOrderToDB(orderId, sizeInEth, 'SELL', price, positionId);
      // }

      return orderResponse as OrderResponse;
    } catch (error) {
      console.error('Error placing sell order:', error);
      return null;
    }
  }

  /**
   * Сохраняет ордер в БД и обновляет память
   * TODO: Будет использоваться после раскомментирования кода в placeBuyOrder/placeSellOrder
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async saveOrderToDB(orderId: number, size: number, side: 'BUY' | 'SELL', price: number, positionId?: number): Promise<void> {
    try {
      const order = await db
        .insert(schema.orders)
        .values({
          id: orderId,
          size,
          side,
          positionId: positionId || null,
          status: 'OPENED',
          averagePrice: price,
          fee: 0,
          closedPnl: 0,
        })
        .returning();

      if (order[0]) {
        memoryStorage.addOrder(order[0] as Order);
        console.log(`Order ${orderId} saved to DB and memory`);
      }
    } catch (error) {
      console.error('Error saving order to DB:', error);
    }
  }

  async disconnect(): Promise<void> {
    if (this.sdk) {
      // Hyperliquid SDK doesn't have explicit disconnect method
      this.sdk = null;
      this.isConnected = false;
      console.log('Disconnected from Hyperliquid');
    }
  }
}

export default HyperliquidService.getInstance();
