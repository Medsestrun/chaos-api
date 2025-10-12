# Grid Bot Strategy System

## Архитектура

Система состоит из нескольких компонентов:

### 1. **MemoryStorage** (`src/MemoryStorage.ts`)
Синглтон для хранения данных стратегии в памяти:
- Информация о стратегии
- Уровни размеров ордеров (orderSizeLevels)
- Позиции
- Ордера

### 2. **Strategy Loader** (`src/services/strategyLoader.ts`)
Загружает данные из базы данных в MemoryStorage:
- `loadEnabledStrategy()` - загружает первую включенную стратегию при старте
- `reloadStrategy(strategyId)` - перезагружает конкретную стратегию

### 3. **Hyperliquid Service** (`src/services/hyperliquidService.ts`)
Работает с биржей Hyperliquid:
- Подключается к WebSocket
- Получает текущую цену ETH-PERP
- Подписывается на filled события (заполнение ордеров)
- Выставляет **только 2 BUY и 2 SELL ордера** одновременно
- При filled событии автоматически обновляет ордера
- Синхронизирует ордера на основе текущей цены и открытых позиций

### 4. **Strategy Runner** (`src/services/strategyRunner.ts`)
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
   - Синхронизирует ордера (2 BUY + 2 SELL)

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
1. **Отменяет все текущие открытые ордера**
2. Определяет текущий индекс грида на основе цены
3. Находит **2 ближайших грида** ниже текущей цены без открытых позиций:
   - Выставляет **2 BUY ордера** на этих уровнях
4. Находит **2 ближайших открытых позиции**:
   - Выставляет **2 SELL ордера** на следующих уровнях грида
5. **Триггер:** Синхронизация автоматически запускается при:
   - Старте приложения
   - Включении стратегии
   - Заполнении любого ордера (filled event из WebSocket)

### Открытие начальных позиций (свежий старт):
При свежем старте (нет открытых позиций):
1. Находит первый грид ВЫШЕ текущей цены
2. Рассчитывает суммарный размер всех позиций для гридов ВЫШЕ текущей цены
3. Выставляет **1 MARKET BUY ордер** с суммарным размером
4. Эти позиции будут продаваться на гридах выше текущей цены
5. После заполнения ордера автоматически сработает `syncOrders` через filled event
6. Далее работает обычная логика 2+2 ордера

**Пример:**
- Текущая цена: 3500
- Гриды: [3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800]
- Первый грид выше: 3600 (индекс 6)
- Размеры: грид 6-7: 10 USDT, грид 7-9: 20 USDT
- **Действие:** Выставляет 1 MARKET BUY ордер с размером 50 USDT для позиций на гридах 3600, 3700, 3800

## API Endpoints

### POST /strategies
Создает новую стратегию:
```json
{
  "minPrice": 3000,
  "maxPrice": 4000,
  "numberOfGrids": 10,
  "margin": 1000,
  "orderSizeLevels": [
    {
      "levelStart": 0,
      "levelEnd": 5,
      "size": 10
    },
    {
      "levelStart": 5,
      "levelEnd": 10,
      "size": 20
    }
  ]
}
```

**Важно:** 
- `levelStart` и `levelEnd` - это **ЦЕНЫ** (диапазон цен для этого уровня размера)
- `levelEnd` не включается в диапазон **кроме последнего диапазона**
- Для гридов в диапазоне [3000, 4000) будет использоваться размер 10 USDT
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
- [ ] Реализовать отмену ордеров через Hyperliquid SDK
- [ ] Извлечь ID ордера из ответа биржи и сохранить в БД
- [ ] Реализовать сохранение новых позиций в БД при заполнении BUY ордера
- [ ] Реализовать закрытие позиций в БД при заполнении SELL ордера
- [ ] Обработать cancelled и filled статусы в handleOrderUpdates
- [ ] Реализовать обработку funding payments
- [ ] Добавить мониторинг PnL
- [ ] Добавить логирование всех операций в файл

