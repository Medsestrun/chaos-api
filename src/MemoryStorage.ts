import type * as schema from './common/db/schema';

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

class MemoryStorage {
  private static instance: MemoryStorage;

  private strategy: Strategy | null = null;
  private orderSizeLevels: OrderSizeLevel[] = [];
  private positions: Map<number, Position> = new Map();
  private orders: Map<number, Order> = new Map();
  private gridBuyModifiers: Map<number, number> = new Map();
  private gridSellModifiers: Map<number, number> = new Map();

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
  updateBalance(balance: number): void {
    if (!this.strategy) return;

    this.strategy.balance = this.strategy.balance + balance;
  }

  getBalance(): number {
    if (!this.strategy) return 0;
    return this.strategy.balance;
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

  getOpenPositionsSortedByClosePrice(): Position[] {
    return this.getOpenPositions().sort((a, b) => a.gridClosePrice - b.gridClosePrice);
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

  removePosition(id: number): void {
    this.positions.delete(id);
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
    return this.getOrders().filter((o) => o.status === 'OPENED' || o.status === 'PARTIALLY_FILLED');
  }

  removeOrder(id: number): void {
    this.orders.delete(id);
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

  findOrder(id: number): Order | undefined {
    return this.orders.get(id);
  }

  setGridBuyModifier(gridIndex: number, modifier: number): void {
    this.gridBuyModifiers.set(gridIndex, modifier);
  }

  getAllGridBuyModifiers(): Map<number, number> {
    return this.gridBuyModifiers;
  }

  getGridBuyModifier(gridIndex: number): number {
    return this.gridBuyModifiers.get(gridIndex) || 0;
  }

  setGridSellModifier(gridIndex: number, modifier: number): void {
    this.gridSellModifiers.set(gridIndex, modifier);
  }

  getAllGridSellModifiers(): Map<number, number> {
    return this.gridSellModifiers;
  }

  getGridSellModifier(gridIndex: number): number {
    return this.gridSellModifiers.get(gridIndex) || 0;
  }

  clearAllModifiers(): void {
    this.gridBuyModifiers.clear();
    this.gridSellModifiers.clear();
  }

  clear(): void {
    this.strategy = null;
    this.orderSizeLevels = [];
    this.positions.clear();
    this.orders.clear();
    this.gridBuyModifiers.clear();
    this.gridSellModifiers.clear();
  }
}

export default MemoryStorage.getInstance();
