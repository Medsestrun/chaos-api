import memoryStorage from '../MemoryStorage';
import hyperliquidService from './hyperliquidService';
import { loadStrategy } from './strategyLoader';

class StrategyRunner {
  private static instance: StrategyRunner;
  private isRunning = false;

  private constructor() {}

  static getInstance(): StrategyRunner {
    if (!StrategyRunner.instance) {
      StrategyRunner.instance = new StrategyRunner();
    }
    return StrategyRunner.instance;
  }

  /**
   * Общая логика запуска стратегии
   * @param strategyId - ID конкретной стратегии, или null для загрузки первой включенной
   */
  private async startStrategy(strategyId: string | null = null): Promise<void> {
    const strategyLabel = strategyId || 'enabled strategy';
    console.log(`Starting ${strategyLabel}...`);

    // Загружаем стратегию
    const loaded = await loadStrategy(strategyId);
    if (!loaded) {
      const message = strategyId ? `Strategy ${strategyId} not found` : 'No enabled strategy to run';
      throw new Error(message);
    }

    // Подключаемся к бирже, если не подключены
    await hyperliquidService.connect();

    // Ждем получения текущей цены
    await this.waitForPrice();

    // Проверяем, есть ли открытые позиции
    const hasOpenPositions = memoryStorage.getOpenPositions().length > 0;

    if (!hasOpenPositions) {
      // Свежий старт: выставляем начальный ордер для накопления позиций
      console.log('Fresh start: placing initial order to accumulate positions');
      await hyperliquidService.openInitialPositions();
      // НЕ вызываем syncOrders - он сработает автоматически после заполнения начального ордера
    } else {
      // Есть позиции: работаем в обычном режиме с гарантией минимум 1 BUY и 1 SELL
      console.log('Positions exist: syncing orders with minimum guarantee');
      await hyperliquidService.syncOrders();
    }

    this.isRunning = true;
    console.log(`Strategy ${strategyLabel} started successfully`);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Strategy runner already running');
      return;
    }

    try {
      await this.startStrategy(null);
    } catch (error) {
      console.error('Error starting strategy runner:', error);
      throw error;
    }
  }

  async enableStrategy(strategyId: string): Promise<void> {
    // Если уже запущена другая стратегия, останавливаем
    if (this.isRunning) {
      await this.stop();
    }

    try {
      await this.startStrategy(strategyId);
    } catch (error) {
      console.error('Error enabling strategy:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('Strategy runner not running');
      return;
    }

    console.log('Stopping strategy runner...');

    // Можно добавить отмену всех открытых ордеров
    // await this.cancelAllOrders();

    this.isRunning = false;
    console.log('Strategy runner stopped');
  }

  private async waitForPrice(timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const price = hyperliquidService.getCurrentPrice();

        if (price > 0) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          reject(new Error('Timeout waiting for price'));
        }
      }, 1000);
    });
  }

  isStrategyRunning(): boolean {
    return this.isRunning;
  }
}

export default StrategyRunner.getInstance();
