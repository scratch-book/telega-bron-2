# telega-bron

MVP Telegram-бот для автоматического создания ссылок на бронирование со скидкой в RealtyCalendar через браузерную автоматизацию (Playwright).

## Требования

- Node.js 18+
- npm

## Установка

```bash
npm install
npx playwright install chromium
```

## Настройка

1. Скопируйте `.env.example` в `.env`:

```bash
cp .env.example .env
```

2. Заполните `.env`:

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота (получить у @BotFather) |
| `ALLOWED_USER_IDS` | Telegram user ID менеджера (через запятую для нескольких) |
| `RC_LOGIN` | Email для входа в RealtyCalendar |
| `RC_PASSWORD` | Пароль от RealtyCalendar |
| `RC_BASE_URL` | URL RealtyCalendar (по умолчанию `https://realtycalendar.ru`) |
| `HEADLESS` | `true` — без окна браузера, `false` — с окном (для отладки) |

### Как узнать свой Telegram user ID

Напишите боту [@userinfobot](https://t.me/userinfobot) — он ответит вашим ID.

### Как создать Telegram-бота

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram.
2. Отправьте `/newbot`.
3. Следуйте инструкциям — получите токен вида `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.

## Запуск

### Режим разработки

```bash
npm run dev
```

### Продакшен

```bash
npm run build
npm start
```

## Использование

### Пошаговый диалог (рекомендуется)

1. Отправьте боту `/discount`
2. Бот последовательно спросит:
   - Объект (название / ID)
   - Дата заезда (ДД.ММ.ГГГГ)
   - Дата выезда (ДД.ММ.ГГГГ)
   - Количество гостей
   - Скидка в процентах
3. Подтвердите данные — бот запустит автоматизацию
4. Получите ссылку и скриншот

### Команда одной строкой

```
/discount apartment_3 12.07.2026 15.07.2026 2 10
```

Формат: `/discount <объект> <дата_заезда> <дата_выезда> <гости> <скидка_%>`

### Другие команды

- `/start` — приветствие и список команд
- `/cancel` — отменить текущий диалог
- `/status` — статус текущего диалога

## Структура проекта

```
src/
├── index.ts              # Точка входа
├── config/
│   └── index.ts          # Конфигурация из .env
├── types/
│   └── index.ts          # TypeScript-типы
├── bot/
│   ├── index.ts          # Telegram-бот (Telegraf)
│   └── validation.ts     # Валидация входных данных
├── automation/
│   └── scenario.ts       # Playwright-сценарий
└── services/
    ├── logger.ts          # Логирование (Winston)
    ├── storage.ts         # Хранение задач и скриншотов
    └── taskRunner.ts      # Запуск задач
storage/
├── screenshots/           # Скриншоты результатов
├── logs/                  # Логи (combined.log, error.log)
└── auth-state.json        # Сохранённая авторизация
```

## Логи

- `storage/logs/combined.log` — все логи
- `storage/logs/error.log` — только ошибки
- `storage/logs/tasks.json` — история задач

## Первичная авторизация в RealtyCalendar

При первом запуске бот автоматически выполнит вход по логину/паролю из `.env`. Состояние сессии сохраняется в `storage/auth-state.json` для повторного использования.

Если сессия истекла, бот повторит авторизацию автоматически.

## Ограничения MVP

1. **Нет API** — используется браузерная автоматизация, зависящая от интерфейса сайта.
2. **Один пользователь** — одновременно обрабатывается только одна задача.
3. **Изменения интерфейса** — при обновлении RealtyCalendar селекторы могут потребовать адаптации.
4. **Капча / 2FA** — если RealtyCalendar включит капчу или двухфакторную авторизацию, полная автоматизация будет невозможна без дополнительной доработки.
5. **Скорость** — зависит от скорости работы сайта и сети.
6. **Anti-bot защита** — при введении защиты от ботов потребуется адаптация.

## Формат входной команды

```
/discount <objectId> <checkIn DD.MM.YYYY> <checkOut DD.MM.YYYY> <guests> <discount%>
```

Пример: `/discount apartment_3 12.07.2026 15.07.2026 2 10`
