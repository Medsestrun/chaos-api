import { eq } from 'drizzle-orm';
import { Hyperliquid, type OrderResponse, type WsOrder, type WsUserFills, type WsUserFundings } from 'hyperliquid';
import { db } from '../common/db';
import * as schema from '../common/db/schema';
import { getOrderIdFromStatus, getOrderSizeForGrid, getOrderSizeInEth, roundPrice, roundSize } from '../common/utils';
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

      this.walletAddress = process.env.WALLET_ADDRESS || '';

      // Подписываемся на обновления цены
      this.sdk.subscriptions.subscribeToAllMids((data) => {
        if (data['ETH-PERP']) {
          this.currentPrice = Number(data['ETH-PERP']);
        }
      });

      if (this.walletAddress) {
        // Подписываемся на заполнение ордеров
        this.sdk.subscriptions.subscribeToUserFills(this.walletAddress, (fills) => {
          if (!fills.isSnapshot) {
            this.handleFills(fills);
          }
        });

        // Подписываемся на обновления ордеров
        this.sdk.subscriptions.subscribeToOrderUpdates(this.walletAddress, (updates) => {
          this.handleOrderUpdates(updates);
        });

        this.sdk.subscriptions.subscribeToUserFundings(this.walletAddress, (updates) => {
          this.handleUserFundings(updates);
        });
      }

      this.isConnected = true;
    } catch (error) {
      console.error('Error connecting to Hyperliquid:', error);
      throw error;
    }
  }

  private async handleUserFundings(data: WsUserFundings): Promise<void> {
    if (data.isSnapshot) return;

    console.log('Received user fundings:', data);

    memoryStorage.updateBalance(Number(data.fundings[0]?.usdc));

    await Promise.all([
      db.insert(schema.fundings).values(
        data.fundings.map((funding) => ({
          time: funding.time,
          size: Number(funding.szi),
          rate: Number(funding.fundingRate),
          fee: Number(funding.usdc),
        })),
      ),
      db.update(schema.strategies).set({
        balance: memoryStorage.getBalance(),
      }),
    ]);
  }

  private async handleFills(data: WsUserFills): Promise<void> {
    console.log('Received fills:', data.fills);

    if (data.fills.length > 1) {
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

      const order = memoryStorage.findOrder(oid);

      if (!order) {
        console.log(`Order ${oid} not found in memory, skipping fill processing`);
        continue;
      }

      if (order.status === 'FILLED') {
        console.log(`Order ${oid} already filled, skipping`);
        continue;
      }

      const totalSize = fills.reduce((sum, f) => sum + Number(f.sz), 0);
      const totalFee = fills.reduce((sum, f) => sum + Number(f.fee), 0);
      const avgPrice = fills.reduce((sum, f) => sum + Number(f.px) * Number(f.sz), 0) / totalSize;

      const aggregatedFill = {
        ...firstFill,
        sz: totalSize.toString(),
        fee: totalFee.toString(),
        px: avgPrice.toString(),
      };

      if (order.type === 'INITIAL_POSITIONS_BUY_UP') {
        console.log('Processing INITIAL_POSITIONS_BUY_UP fill:', order.type);

        await strategyService.handleInitialPositionsFill(order, aggregatedFill);

        continue;
      }

      if (firstFill.side === 'buy') {
        await strategyService.handleBuyOrderFill(aggregatedFill);
      } else {
        await strategyService.handleSellOrderFill(aggregatedFill);
      }
    }

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
  async cancelAllOrders(): Promise<void> {
    if (!this.sdk) {
      console.error('SDK not initialized');
      return;
    }

    const openOrders = memoryStorage.getOpenOrders();

    if (openOrders.length === 0) {
      console.log('No open orders to cancel');
      return;
    }

    for (const order of openOrders) {
      const response = await this.sdk.wsPayloads.cancelOrder({ coin: 'ETH-PERP', o: order.id });
      console.log('Cancel order response:', response);

      if (response?.status !== 'ok') {
        console.error('Failed to cancel orders:', response);
        return;
      }

      await db
        .update(schema.orders)
        .set({
          status: 'CANCELLED',
          closedAt: new Date().toISOString(),
        })
        .where(eq(schema.orders.id, order.id));

      memoryStorage.removeOrder(order.id);
    }

    console.log(`Successfully cancelled all open orders`);
  }

  /**
   * Проверяет открытые позиции и выставляет необходимые ордера
   * @param ensureMinimum - гарантировать минимум 1 BUY и 1 SELL ордер (для первого запуска)
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

    await this.cancelAllOrders();

    const buyTarget = strategyService.findBuyTargets(currentPrice);
    const sellTarget = strategyService.findSellTargets();

    if (buyTarget) {
      await this.placeBuyOrder(buyTarget.price, buyTarget.size);
    }

    if (sellTarget) {
      await this.placeSellOrder(sellTarget.closePrice, sellTarget.position.size, sellTarget.position.id);
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
    const currentGridIndex = strategyService.findGridUpperIndex(currentPrice); // Первый грид ВЫШЕ текущей цены
    const openPositions = memoryStorage.getOpenPositions();

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
        const orderSize = getOrderSizeForGrid(gridPrice);
        totalSizeInUsdt += orderSize;
      }
    }

    if (totalSizeInUsdt === 0) {
      console.log('Total size is 0, skipping initial opening');
      return;
    }

    console.log(`Placing BUY order for ${totalSizeInUsdt} USDT to open positions for ${grid.length - currentGridIndex} grids above`);

    try {
      const orderResponse = await this.placeBuyOrder(Math.floor(currentPrice), totalSizeInUsdt, 'INITIAL_POSITIONS_BUY_UP');

      if (orderResponse?.status !== 'ok' || !orderResponse?.response?.data?.statuses[0]) {
        throw new Error(`Failed to place buy service order: ${orderResponse?.status}`);
      }
    } catch (error) {
      console.error('Error placing initial positions buy order:', error);
      this.openInitialPositions();
    }
  }

  private async placeBuyOrder(
    price: number,
    sizeInUsdt: number,
    orderType: 'REGULAR' | 'INITIAL_POSITIONS_BUY_UP' | 'FILL_EMPTY_POSITIONS' | 'ORDER_SIZE_INCREASE' = 'REGULAR',
  ): Promise<OrderResponse | null> {
    if (!this.sdk) return null;

    try {
      const size = getOrderSizeInEth(price, sizeInUsdt);
      const roundedPrice = orderType === 'INITIAL_POSITIONS_BUY_UP' ? roundPrice(price + 100) : roundPrice(price);

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

      if (orderResponse?.status === 'ok') {
        const orderId = getOrderIdFromStatus(orderResponse?.response?.data?.statuses[0]);

        if (orderId) {
          // В базе все равно записываем фактическую цену ордера, а не повышеную (ее повышаем чтобы точно исполнился market order)
          await strategyService.saveOpenedOrderToDB(orderId, size, 'BUY', roundPrice(price), orderType);
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
      const roundedPrice = roundPrice(price);
      const roundedSize = roundSize(sizeInEth);

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

      if (orderResponse?.status === 'ok') {
        const orderId = getOrderIdFromStatus(orderResponse?.response?.data?.statuses[0]);
        if (orderId) {
          await strategyService.saveOpenedOrderToDB(orderId, roundedSize, 'SELL', roundedPrice, 'REGULAR', positionId);
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
