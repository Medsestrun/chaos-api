import BigNumber from 'bignumber.js';
import { Hyperliquid } from 'hyperliquid';

/**
 * Calculates order size in ETH for a fixed USDT value of orderSizeInUsdt
 * @param ethPrice - Current ETH price in USDT
 * @returns Order size in ETH that equals orderSizeInUsdt USDT, rounded to 0.0001 precision
 */
const getOrderSizeInEth = (ethPrice: number, orderSizeInUsdt = 10.5): number => {
  const usdtAmount = new BigNumber(orderSizeInUsdt);
  const price = new BigNumber(ethPrice);
  const orderSize = usdtAmount.dividedBy(price);
  return orderSize.decimalPlaces(4, BigNumber.ROUND_DOWN).toNumber();
};

async function start() {
  const sdk = new Hyperliquid({
    enableWs: true,
    privateKey: process.env.PRIVATE_KEY,
  });

  try {
    await sdk.connect();
    console.log('Connected to WebSocket');

    // Subscribe to get latest prices for all coins
    //   sdk.subscriptions.subscribeToAllMids(data => {
    //     console.log('Received trades data:', data['ETH-PERP']);
    //   });

    const orderResponse = await sdk.wsPayloads.placeOrders([
      {
        coin: 'ETH-PERP',
        is_buy: true,
        sz: 0.0024,
        limit_px: '4340',
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: false,
        // cloid: getRandomCloid(),
      },
    ]);

    console.log('Order response:', JSON.stringify(orderResponse));

    // Get updates anytime the user gets new fills
    sdk.subscriptions.subscribeToUserFills('0x15f4B8BC157702D93180f722c740f2032D500Fd3', (data) => {
      console.log('Received user fills data:', data);
    });

    sdk.subscriptions.subscribeToUserFundings('0x15f4B8BC157702D93180f722c740f2032D500Fd3', (data) => {
      console.log('Received user fundings data:', data);
    });

    sdk.subscriptions.subscribeToOrderUpdates('0x15f4B8BC157702D93180f722c740f2032D500Fd3', (data) => {
      console.log('Received order updates data:', data);
    });

    // Keep the script running
    await new Promise(() => {});
  } catch (error) {
    console.error('Error:', error);
  }
}

start().catch(console.error);
