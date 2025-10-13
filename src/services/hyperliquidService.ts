import { inArray } from 'drizzle-orm';
import { Hyperliquid, type OrderResponse, type WsOrder, type WsUserFills } from 'hyperliquid';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import memoryStorage from '../MemoryStorage';
import strategyService from './strategyService';

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

    if (data.fills.length > 1 && !data.isSnapshot) {
      console.log('Received multiple fills:', data.fills);
    }

    // Группируем fills по oid (один ордер может иметь несколько fills)
    const fillsByOrder = new Map<number, typeof data.fills>();
    for (const fill of data.fills) {
      const existing = fillsByOrder.get(fill.oid) || [];
      existing.push(fill);
      fillsByOrder.set(fill.oid, existing);
    }

    // Обрабатываем каждый уникальный ордер
    for (const [oid, fills] of fillsByOrder.entries()) {
      // Берем первый fill для получения основной информации
      const firstFill = fills[0];
      if (!firstFill) continue;

      // Проверяем, является ли это сервисным ордером
      const serviceOrder = memoryStorage.findServiceOrder(oid);

      if (serviceOrder) {
        console.log('Processing service order fill:', serviceOrder.type);

        if (serviceOrder.type === 'INITIAL_POSITIONS_BUY_UP') {
          // Для сервисного ордера суммируем все fills
          const totalSize = fills.reduce((sum, f) => sum + Number(f.sz), 0);
          const totalFee = fills.reduce((sum, f) => sum + Number(f.fee), 0);
          const avgPrice = fills.reduce((sum, f) => sum + Number(f.px) * Number(f.sz), 0) / totalSize;

          const aggregatedFill = {
            ...firstFill,
            sz: totalSize.toString(),
            fee: totalFee.toString(),
            px: avgPrice.toString(),
          };

          await strategyService.handleInitialPositionsFill(serviceOrder, aggregatedFill);
        }

        continue;
      }

      // Проверяем, не обработали ли мы уже этот ордер
      const existingOrder = memoryStorage.getOrders().find((o) => o.id === oid);
      if (!existingOrder) {
        console.log(`Order ${oid} not found in memory, skipping fill processing`);
        continue;
      }

      if (existingOrder.status === 'FILLED') {
        console.log(`Order ${oid} already filled, skipping`);
        continue;
      }

      // Суммируем все fills для этого ордера
      const totalSize = fills.reduce((sum, f) => sum + Number(f.sz), 0);
      const totalFee = fills.reduce((sum, f) => sum + Number(f.fee), 0);
      const avgPrice = fills.reduce((sum, f) => sum + Number(f.px) * Number(f.sz), 0) / totalSize;

      const aggregatedFill = {
        ...firstFill,
        sz: totalSize.toString(),
        fee: totalFee.toString(),
        px: avgPrice.toString(),
      };

      // Обрабатываем обычные ордера
      if (firstFill.side === 'B') {
        // BUY ордер - создаем позицию
        await strategyService.handleBuyOrderFill(aggregatedFill);
      } else if (firstFill.side === 'A') {
        // SELL ордер - закрываем позицию
        await strategyService.handleSellOrderFill(aggregatedFill);
      }
    }

    // После обработки всех заполнений - синхронизируем ордера
    await this.syncOrders();
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
    if (!this.sdk) {
      console.error('SDK not initialized');
      return;
    }

    const openOrders = memoryStorage.getOpenOrders();
    if (openOrders.length === 0) {
      console.log('No open orders to cancel');
      return;
    }

    console.log(`Cancelling ${openOrders.length} open orders for ETH-PERP`);

    try {
      const response = await this.sdk.wsPayloads.cancelAllOrders();
      console.log('Cancel orders response:', response);

      // Проверяем статус ответа
      if (response?.status !== 'ok') {
        console.error('Failed to cancel orders:', response);
        return;
      }

      // Обновляем статус в БД
      await db
        .update(schema.orders)
        .set({
          status: 'CANCELLED',
          closedAt: new Date().toISOString(),
        })
        .where(
          inArray(
            schema.orders.id,
            openOrders.map((order) => order.id),
          ),
        );

      // Очищаем открытые ордера в памяти
      memoryStorage.setOrders([]);

      console.log(`Successfully cancelled ${openOrders.length} orders`);
    } catch (error) {
      console.error('Error cancelling orders:', error);
      // Не обновляем БД и память, если отмена не удалась
    }
  }

  /**
   * Проверяет открытые позиции и выставляет необходимые ордера
   * @param ensureMinimum - гарантировать минимум 1 BUY и 1 SELL ордер (для первого запуска)
   */
  async syncOrders(ensureMinimum = false): Promise<void> {
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

    // Отменяем все текущие ордера
    await this.cancelAllOrders();

    const openPositions = memoryStorage.getOpenPositions();
    console.log(`Open positions: ${openPositions.length}${ensureMinimum ? ' (ensuring minimum orders)' : ''}`);

    // Находим грида для покупки
    // При первом запуске гарантируем минимум 1 BUY ордер, даже если грид далеко
    const buyTargets = strategyService.findBuyTargets(currentPrice, 1, ensureMinimum);

    const orderRequests = [];

    // Выставляем BUY ордера
    for (const target of buyTargets) {
      orderRequests.push(this.placeBuyOrder(target.price, target.size));
    }

    // Находим открытые позиции для продажи
    // При первом запуске гарантируем минимум 1 SELL ордер, даже если позиция далеко
    const sellTargets = strategyService.findSellTargets(currentPrice, 1, ensureMinimum);

    // Выставляем SELL ордера
    for (const target of sellTargets) {
      orderRequests.push(this.placeSellOrder(target.closePrice, target.position.size, target.position.id));
    }

    // Логируем, что будем выставлять
    console.log(`Placing orders: ${buyTargets.length} BUY + ${sellTargets.length} SELL`);

    await Promise.all(orderRequests);
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
    const currentGridIndex = strategyService.findGridUpperIndex(currentPrice); // Первый грид ВЫШЕ текущей цены
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

    try {
      const orderResponse = await this.placeBuyOrder(Math.floor(currentPrice) + 100, totalSizeInUsdt, true);

      if (orderResponse?.status !== 'ok' || !orderResponse?.response?.data?.statuses[0]) {
        throw new Error(`Failed to place buy service order: ${orderResponse?.status}`);
      }

      const orderId = strategyService.getOrderIdFromStatus(orderResponse?.response?.data?.statuses[0]);
      memoryStorage.addServiceOrder({
        id: orderId || 0,
        type: 'INITIAL_POSITIONS_BUY_UP',
        side: 'BUY',
        meta: {
          initialPrice: currentPrice,
          numberOfPositions: grid.length - currentGridIndex,
        },
      });
    } catch (error) {
      console.error('Error placing initial positions buy order:', error);
      this.openInitialPositions();
    }
  }

  private async placeBuyOrder(price: number, sizeInUsdt: number, isServiceOrder = false): Promise<OrderResponse | null> {
    if (!this.sdk) return null;

    try {
      const size = strategyService.getOrderSizeInEth(price, sizeInUsdt);

      // Округляем price до 1 знака, size уже округлен в getOrderSizeInEth до 4 знаков
      const roundedPrice = strategyService.roundPrice(price);

      console.log(`Placing LIMIT BUY order: price=${roundedPrice}, size=${size} ETH`);

      const orderResponse = await this.sdk.wsPayloads.placeOrder({
        coin: 'ETH-PERP',
        is_buy: true,
        sz: size,
        limit_px: roundedPrice.toString(),
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: false,
      });

      console.log('Buy order response:', JSON.stringify(orderResponse));

      // Сохраняем ордер в БД, если это не сервисный ордер
      if (!isServiceOrder && orderResponse?.status === 'ok') {
        const orderId = strategyService.getOrderIdFromStatus(orderResponse?.response?.data?.statuses[0]);
        if (orderId) {
          await strategyService.saveOpenedOrderToDB(orderId, size, 'BUY', roundedPrice);
        }
      }

      return orderResponse as OrderResponse;
    } catch (error) {
      console.error('Error placing buy order:', error);
      throw error;
    }
  }

  private async placeSellOrder(price: number, sizeInEth: number, positionId: number): Promise<OrderResponse | null> {
    if (!this.sdk) return null;

    try {
      // Округляем price до 1 знака, size до 4 знаков
      const roundedPrice = strategyService.roundPrice(price);
      const roundedSize = strategyService.roundSize(sizeInEth);

      console.log(`Placing SELL order: price=${roundedPrice}, size=${roundedSize} ETH, positionId=${positionId}`);

      const orderResponse = await this.sdk.wsPayloads.placeOrder({
        coin: 'ETH-PERP',
        is_buy: false,
        sz: roundedSize,
        limit_px: roundedPrice.toString(),
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: false,
      });

      console.log('Sell order response:', JSON.stringify(orderResponse));

      // Сохраняем ордер в БД
      if (orderResponse?.status === 'ok') {
        const orderId = strategyService.getOrderIdFromStatus(orderResponse?.response?.data?.statuses[0]);
        if (orderId) {
          await strategyService.saveOpenedOrderToDB(orderId, roundedSize, 'SELL', roundedPrice, positionId);
        }
      }

      return orderResponse as OrderResponse;
    } catch (error) {
      console.error('Error placing sell order:', error);
      throw error;
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
