import BigNumber from 'bignumber.js';
import type { OrderResponse } from 'hyperliquid';
import memoryStorage from '../MemoryStorage';

/**
 * Округляет цену до 1 знака после запятой
 */
export function roundPrice(price: number): number {
  return new BigNumber(price).decimalPlaces(1, BigNumber.ROUND_DOWN).toNumber();
}

/**
 * Округляет размер до 4 знаков после запятой
 */
export function roundSize(size: number): number {
  return new BigNumber(size).decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();
}

/**
 * Вычисляет размер ордера в ETH для заданной цены в USDT
 */
export function getOrderSizeInEth(ethPrice: number, orderSizeInUsdt: number): number {
  const usdtAmount = new BigNumber(orderSizeInUsdt);
  const price = new BigNumber(ethPrice);
  const orderSize = usdtAmount.dividedBy(price);
  return orderSize.decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();
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
export function getOrderIdFromStatus(status: OrderResponse['response']['data']['statuses'][0]): number | null {
  return status?.filled?.oid || status?.resting?.oid || null;
}

/**
 * Извлекает все ID ордеров из ответа биржи
 * @param orderData - данные ответа от биржи
 * @returns массив ID ордеров
 */
export function getAllOrderIdsFromResponse(orderData: OrderResponse['response']['data']): number[] {
  if (!orderData?.statuses) return [];

  const orderIds: number[] = [];
  for (const status of orderData.statuses) {
    const orderId = getOrderIdFromStatus(status);
    if (orderId !== null) {
      orderIds.push(orderId);
    }
  }

  return orderIds;
}

/**
 * Получает размер ордера для грида по его ЦЕНЕ
 * @param gridPrice - цена грида
 * @returns размер ордера в USDT
 */
export function getOrderSizeForGrid(gridPrice: number): number {
  // Находим подходящий диапазон
  const levelIndex = memoryStorage.getOrderSizeLevels().findIndex((l, index) => {
    const isLastLevel = index === memoryStorage.getOrderSizeLevels().length - 1;
    // Для последнего диапазона включаем levelEnd (<=), для остальных нет (<)
    return isLastLevel ? gridPrice >= l.levelStart && gridPrice <= l.levelEnd : gridPrice >= l.levelStart && gridPrice < l.levelEnd;
  });

  if (levelIndex === -1) {
    console.log(
      `No level found for grid price ${gridPrice}. Available levels:`,
      memoryStorage.getOrderSizeLevels().map((l, i) => {
        const isLast = i === memoryStorage.getOrderSizeLevels().length - 1;
        return isLast ? `[${l.levelStart}-${l.levelEnd}]: ${l.size}` : `[${l.levelStart}-${l.levelEnd}): ${l.size}`;
      }),
    );
    return 0;
  }

  return memoryStorage.getOrderSizeLevels()[levelIndex]?.size || 0;
}

export function getModifier(arr: Array<number>): number {
  const len = arr.length;
  if (len === 0) return 0; // Первый ордер без смещения
  if (len >= 5) return 1.5;
  return 1 + len * 0.1;
}

export function adjustPriceByGrid(price: number | string, grid: Array<number>, modifier: number, direction: 'buy' | 'sell'): BigNumber {
  const base = new BigNumber(price);

  if (grid.length < 2) return base;

  const diff = new BigNumber(grid[1] ?? 0).minus(grid[0] ?? 0).abs();
  // Используем модификатор как процент: делим на 100 чтобы modifier=1 давал 1% смещения
  const amplifiedDiff = diff.times(modifier).dividedBy(100);
  return direction === 'sell' ? base.plus(amplifiedDiff) : base.minus(amplifiedDiff);
}
