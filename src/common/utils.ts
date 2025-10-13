import BigNumber from 'bignumber.js';
import type { OrderResponse } from 'hyperliquid';

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
