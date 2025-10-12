type StrategySettings = {
  grid: number[];
  minPrice: number;
  maxPrice: number;
};

type Strategy = {
  id: string;
  enabled: boolean;
  settings: StrategySettings;
  margin: number;
  balance: number;
  startedAt: string | null;
};

type OrderSizeLevel = {
  id: number;
  strategyId: string;
  levelStart: number;
  levelEnd: number;
  size: number;
};

type Position = {
  id: number;
  size: number;
  strategyId: string;
  status: 'OPENED' | 'CLOSED';
  gridOpenPrice: number;
  gridClosePrice: number | null;
};

type Order = {
  id: number;
  size: number;
  side: 'BUY' | 'SELL';
  positionId: number | null;
  status: 'OPENED' | 'CANCELLED' | 'FILLED' | 'PARTIALLY_FILLED';
  averagePrice: number;
  fee: number;
  closedPnl: number;
  createdAt: string;
  closedAt: string | null;
};

class MemoryStorage {
  private static instance: MemoryStorage;

  private strategy: Strategy | null = null;
  private orderSizeLevels: OrderSizeLevel[] = [];
  private positions: Map<number, Position> = new Map();
  private orders: Map<number, Order> = new Map();

  private constructor() {}

  static getInstance(): MemoryStorage {
    if (!MemoryStorage.instance) {
      MemoryStorage.instance = new MemoryStorage();
    }
    return MemoryStorage.instance;
  }

  setStrategy(strategy: Strategy): void {
    this.strategy = strategy;
  }

  getStrategy(): Strategy | null {
    return this.strategy;
  }

  setOrderSizeLevels(levels: OrderSizeLevel[]): void {
    this.orderSizeLevels = levels;
  }

  getOrderSizeLevels(): OrderSizeLevel[] {
    return this.orderSizeLevels;
  }

  /**
   * Получает размер ордера для грида по его ЦЕНЕ
   * @param gridPrice - цена грида
   * @returns размер ордера в USDT
   */
  getOrderSizeForGrid(gridPrice: number): number {
    // Находим подходящий диапазон
    const levelIndex = this.orderSizeLevels.findIndex((l, index) => {
      const isLastLevel = index === this.orderSizeLevels.length - 1;
      // Для последнего диапазона включаем levelEnd (<=), для остальных нет (<)
      return isLastLevel ? gridPrice >= l.levelStart && gridPrice <= l.levelEnd : gridPrice >= l.levelStart && gridPrice < l.levelEnd;
    });

    if (levelIndex === -1) {
      console.log(
        `No level found for grid price ${gridPrice}. Available levels:`,
        this.orderSizeLevels.map((l, i) => {
          const isLast = i === this.orderSizeLevels.length - 1;
          return isLast ? `[${l.levelStart}-${l.levelEnd}]: ${l.size}` : `[${l.levelStart}-${l.levelEnd}): ${l.size}`;
        }),
      );
      return 0;
    }

    return this.orderSizeLevels[levelIndex]?.size || 0;
  }

  setPositions(positions: Position[]): void {
    this.positions.clear();
    for (const position of positions) {
      this.positions.set(position.id, position);
    }
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getOpenPositions(): Position[] {
    return this.getPositions().filter((p) => p.status === 'OPENED');
  }

  addPosition(position: Position): void {
    this.positions.set(position.id, position);
  }

  updatePosition(id: number, updates: Partial<Position>): void {
    const position = this.positions.get(id);
    if (position) {
      this.positions.set(id, { ...position, ...updates });
    }
  }

  setOrders(orders: Order[]): void {
    this.orders.clear();
    for (const order of orders) {
      this.orders.set(order.id, order);
    }
  }

  getOrders(): Order[] {
    return Array.from(this.orders.values());
  }

  getOpenOrders(): Order[] {
    return this.getOrders().filter((o) => o.status === 'OPENED');
  }

  addOrder(order: Order): void {
    this.orders.set(order.id, order);
  }

  updateOrder(id: number, updates: Partial<Order>): void {
    const order = this.orders.get(id);
    if (order) {
      this.orders.set(id, { ...order, ...updates });
    }
  }

  clear(): void {
    this.strategy = null;
    this.orderSizeLevels = [];
    this.positions.clear();
    this.orders.clear();
  }
}

export default MemoryStorage.getInstance();
