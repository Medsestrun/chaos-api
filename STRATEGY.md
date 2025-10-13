# Grid Bot Strategy System

## Архитектура

Система состоит из нескольких компонентов:

### 1. **MemoryStorage** (`src/MemoryStorage.ts`)
Синглтон для хранения данных стратегии в памяти:
- Информация о стратегии
- Уровни размеров ордеров (orderSizeLevels)
- Позиции
- Ордера
- **Сервисные ордера** - специальные ордера для технических операций:
  - `INITIAL_POSITIONS_BUY_UP` - начальная закупка позиций для гридов выше текущей цены
  - `FILL_EMPTY_POSITIONS` - дозакупка недостающих позиций
  - `ORDER_SIZE_INCREASE` - увеличение размеров позиций

### 2. **Strategy Loader** (`src/services/strategyLoader.ts`)
Загружает данные из базы данных в MemoryStorage:
- `loadEnabledStrategy()` - загружает первую включенную стратегию при старте
- `reloadStrategy(strategyId)` - перезагружает конкретную стратегию

### 3. **Hyperliquid Service** (`src/services/hyperliquidService.ts`)
Работает с биржей Hyperliquid:
- Подключается к WebSocket
- Получает текущую цену ETH-PERP
- Подписывается на filled события (заполнение ордеров)
- Выставляет **N BUY и N SELL ордеров** одновременно (N задается в настройках стратегии, по умолчанию 2)
- При filled событии автоматически обновляет ордера
- Синхронизирует ордера на основе текущей цены и открытых позиций

### 4. **Strategy Service** (`src/services/strategyService.ts`)
Бизнес-логика стратегии:
- `findBuyTargets(currentPrice, limit)` - находит грида для покупки (без позиций и без открытых BUY ордеров, ниже текущей цены)
- `findSellTargets(currentPrice, limit)` - находит позиции для продажи (без открытых SELL ордеров на эти позиции)
- `handleInitialPositionsFill()` - обрабатывает заполнение начального ордера
- `findGridUpperIndex(price)` - находит первый грид выше заданной цены
- `getOrderSizeInEth()` - конвертирует размер из USDT в ETH
- `getOrderIdFromStatus(status)` - извлекает ID ордера из одного статуса
- `getAllOrderIdsFromResponse(orderData)` - извлекает все ID ордеров из ответа биржи
- `saveOrderToDB()` - сохраняет ордер в БД и обновляет память

### 5. **Strategy Runner** (`src/services/strategyRunner.ts`)
Управляет жизненным циклом стратегии:
- `start()` - запускает стратегию при старте приложения
- `enableStrategy(strategyId)` - включает конкретную стратегию
- `stop()` - останавливает текущую стратегию

## Логика работы

### При старте приложения:
1. Подключается к Hyperliquid WebSocket
2. Загружает первую включенную стратегию из БД (только открытые ордера)
3. Ждет получения текущей цены
4. **Если нет открытых позиций (свежий старт):**
   - Выставляет 1 MARKET ордер с суммарным размером всех недостающих позиций
   - После заполнения автоматически запустится синхронизация через filled event
5. **Если есть открытые позиции:**
   - Синхронизирует ордера (N BUY + N SELL, где N из настроек стратегии)

### При включении стратегии (PATCH /strategies/:id/toggle):
1. Обновляет статус `enabled` в БД
2. Если `enabled = true`:
   - Останавливает предыдущую стратегию (если была)
   - Подключается к бирже
   - Загружает данные стратегии
   - Открывает недостающие позиции
   - Синхронизирует ордера
3. Если `enabled = false`:
   - Останавливает стратегию

### Синхронизация ордеров:
1. **Отменяет все текущие открытые ордера** (опционально)
2. Определяет количество ордеров (параметр или 1 по умолчанию)
3. Находит **N ближайших грида** ниже текущей цены для покупки:
   - Проверяет: нет открытой позиции на этом гриде
   - Проверяет: нет открытого BUY ордера на этой цене
   - Выставляет **N BUY ордеров** на этих уровнях (через `strategyService.findBuyTargets()`)
4. Находит **N ближайших открытых позиций** для продажи:
   - Проверяет: нет открытого SELL ордера на эту позицию
   - Выставляет **N SELL ордеров** на следующих уровнях грида (через `strategyService.findSellTargets()`)
5. **Триггер:** Синхронизация автоматически запускается при:
   - Старте приложения
   - Включении стратегии
   - Заполнении любого ордера (filled event из WebSocket)

### Открытие начальных позиций (свежий старт):
При свежем старте (нет открытых позиций):
1. Находит первый грид ВЫШЕ текущей цены
2. Рассчитывает суммарный размер всех позиций для гридов ВЫШЕ текущей цены
3. Выставляет **1 LIMIT BUY ордер** с суммарным размером (сервисный ордер типа `INITIAL_POSITIONS_BUY_UP`)
4. Сохраняет сервисный ордер в памяти с метаданными (начальная цена, количество позиций)
5. **При заполнении сервисного ордера** (`handleInitialPositionsFill`):
   - Получает данные о заполнении (цена, размер в ETH, комиссия)
   - Вычисляет количество недостающих позиций (`numberOfPositions`)
   - **Делит реальный размер купленной позиции на количество гридов:**
     - `sizePerPosition = totalSizeInEth / numberOfPositions`
     - Округляет до 4 знаков после запятой с помощью `BigNumber.js`
   - Создает позиции для каждого грида выше начальной цены
   - Для каждой позиции:
     - Размер = `sizePerPosition` (в ETH)
     - `gridOpenPrice` = текущий грид
     - `gridClosePrice` = следующий грид
   - Сохраняет все позиции в БД
   - Обновляет память
   - Удаляет сервисный ордер из памяти
   - Запускает обычную синхронизацию ордеров `syncOrders()`
6. Далее работает обычная логика 2+2 ордера

**Пример:**
- Текущая цена: 4107.25
- Гриды: [3000, 3100, ..., 5000] (70 гридов)
- Первый грид выше: 5000 (индекс 39)
- Недостающих позиций: 70 - 39 = 31 позиция
- Суммарный размер в USDT: 31 × 20 = 620 USDT
- **Действие:** Выставляет 1 LIMIT BUY ордер на 620 USDT
- **После заполнения:** Куплено, например, 0.1509 ETH
- **Размер одной позиции:** 0.1509 / 31 = 0.0048 ETH (округлено до 4 знаков)
- Создаются 31 позиция по 0.0048 ETH каждая для гридов 39-69

## API Endpoints

### POST /strategies
Создает новую стратегию:
```json
{
  "minPrice": 3000,
  "maxPrice": 5000,
  "numberOfGrids": 70,
  "numberOfOrders": 2,
  "margin": 1000,
  "orderSizeLevels": [
    {
      "levelStart": 3000,
      "levelEnd": 4000,
      "size": 30
    },
    {
      "levelStart": 4000,
      "levelEnd": 5000,
      "size": 20
    }
  ]
}
```

**Параметры:**
- `minPrice`, `maxPrice` - диапазон цен для грид-бота
- `numberOfGrids` - количество гридов (уровней цен)
- `numberOfOrders` - количество одновременно открытых BUY и SELL ордеров (1-10, по умолчанию 2)
- `margin` - маржа для стратегии в USDT
- `orderSizeLevels` - уровни размеров ордеров:
  - `levelStart`, `levelEnd` - это **ЦЕНЫ** (диапазон цен для этого уровня размера)
  - `levelEnd` не включается в диапазон **кроме последнего диапазона**
  - Для гридов в диапазоне [3000, 4000) будет использоваться размер 30 USDT
  - Для гридов в диапазоне [4000, 5000] будет использоваться размер 20 USDT (последний диапазон - включительно!)

**Ответ:**
```json
{
  "strategyId": "uuid"
}
```

### PATCH /strategies/:strategyId/toggle
Включает/выключает стратегию:
```json
{
  "enabled": true
}
```

**Ответ:**
```json
{
  "strategyId": "uuid",
  "enabled": true
}
```

### GET /
Проверка статуса API:
```json
{
  "message": "Chaos API is running",
  "strategyRunning": true
}
```

## Настройка окружения

Создайте `.env` файл с необходимыми переменными:
```env
PRIVATE_KEY=your_hyperliquid_private_key
WALLET_ADDRESS=your_wallet_address
PORT=3040
DB_FILE_NAME=./mydb.sqlite
```

**Важно:** `WALLET_ADDRESS` необходим для подписки на события заполнения ордеров и обновления ордеров.

## Запуск

```bash
# Разработка с hot reload
bun run dev

# Production
bun run start
```

## База данных

### Миграции

```bash
# Создать миграцию
bun run create-migration

# Применить миграции
bun run migrate

# Открыть Drizzle Studio
bun run studio
```

### Схема таблиц

**strategies** - стратегии грид-бота
- `id` (text, PK)
- `enabled` (boolean)
- `settings` (json) - grid, minPrice, maxPrice
- `margin` (real)
- `balance` (real)
- `deleted` (boolean)
- `createdAt` (text)
- `startedAt` (text)
- `description` (text)

**order_size_levels** - уровни размеров ордеров
- `id` (integer, PK)
- `strategyId` (text, FK → strategies.id)
- `levelStart` (integer)
- `levelEnd` (integer)
- `size` (real)

**positions** - открытые/закрытые позиции
- `id` (integer, PK)
- `strategyId` (text, FK → strategies.id)
- `size` (real)
- `status` ('OPENED' | 'CLOSED')
- `gridOpenPrice` (real)
- `gridClosePrice` (real)

**orders** - ордера на бирже
- `id` (integer, PK)
- `positionId` (integer, FK → positions.id)
- `size` (real)
- `side` ('BUY' | 'SELL')
- `status` ('OPENED' | 'CANCELLED' | 'FILLED' | 'PARTIALLY_FILLED')
- `averagePrice` (real)
- `fee` (real)
- `closedPnl` (real)
- `createdAt` (text)
- `closedAt` (text)

## TODO

- [x] Загрузка только открытых ордеров в память
- [x] Выставление только 2 BUY и 2 SELL ордеров
- [x] Подписка на filled события из WebSocket
- [x] Автоматическая синхронизация при заполнении ордера
- [x] При свежем старте выставляется 1 MARKET ордер с суммарным размером всех позиций
- [x] Рефакторинг: единая функция loadStrategy(strategyId | null)
- [x] Рефакторинг: единая функция startStrategy в StrategyRunner
- [x] Сохранение сервисных ордеров в памяти
- [x] Обработка заполнения сервисного ордера INITIAL_POSITIONS_BUY_UP
- [x] Создание позиций в БД при заполнении начального ордера
- [x] Диапазоны orderSizeLevels работают по ценам (levelEnd включается для последнего)
- [x] Рефакторинг: вынесены findBuyTargets и findSellTargets в StrategyService
- [x] Добавлен параметр numberOfOrders для настройки количества одновременных ордеров
- [x] Используется реальный размер купленной позиции при создании позиций (делится поровну)
- [x] findBuyTargets проверяет открытые BUY ордера (не выставляет дубликаты)
- [x] findSellTargets проверяет открытые SELL ордера (не выставляет дубликаты)
- [x] Добавлены функции getOrderIdFromStatus и getAllOrderIdsFromResponse для извлечения ID ордеров
- [x] Перенесена функция saveOrderToDB в StrategyService
- [ ] Реализовать отмену ордеров через Hyperliquid SDK
- [ ] Извлечь ID ордера из ответа биржи и сохранить в БД (использовать getAllOrderIdsFromResponse)
- [ ] Реализовать закрытие позиций в БД при заполнении SELL ордера
- [ ] Обработать cancelled и filled статусы в handleOrderUpdates
- [ ] Реализовать обработку funding payments
- [ ] Добавить мониторинг PnL
- [ ] Добавить логирование всех операций в файл

