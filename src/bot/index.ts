import { Telegraf, Context } from 'telegraf';
import fs from 'fs';
import { config } from '../config';
import { BookingRequest, TaskResult } from '../types';
import { createAndRunTask, createAndRunDemoTask } from '../services/taskRunner';
import { logger } from '../services/logger';
import {
  validateDate,
  validateDateRange,
} from './validation';

// Conversation states for step-by-step dialog
type ConversationStep =
  | 'idle'
  | 'awaiting_object'
  | 'awaiting_checkin'
  | 'awaiting_checkout'
  | 'awaiting_confirm';

interface ConversationState {
  step: ConversationStep;
  data: Partial<BookingRequest>;
}

const conversations = new Map<number, ConversationState>();

function getState(userId: number): ConversationState {
  if (!conversations.has(userId)) {
    conversations.set(userId, { step: 'idle', data: {} });
  }
  return conversations.get(userId)!;
}

function resetState(userId: number): void {
  conversations.set(userId, { step: 'idle', data: {} });
}

function isAuthorized(userId: number): boolean {
  return config.telegram.allowedUserIds.includes(userId);
}

export function createBot(): Telegraf {
  const bot = new Telegraf(config.telegram.botToken);

  // Middleware: check authorization
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorized(userId)) {
      logger.warn('Unauthorized access attempt', { userId, username: ctx.from?.username });
      await ctx.reply('Доступ запрещен. Обратитесь к администратору.');
      return;
    }
    return next();
  });

  // /start command
  bot.start(async (ctx) => {
    resetState(ctx.from!.id);
    await ctx.reply(
      'Привет! Я бот для создания ссылок на бронирование в RealtyCalendar.\n\n' +
      'Команды:\n' +
      '/book — создать ссылку на бронирование (пошаговый диалог)\n' +
      '/demo — демонстрация работы бота\n' +
      '/cancel — отменить текущий диалог\n' +
      '/status — проверить статус'
    );
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    resetState(ctx.from!.id);
    await ctx.reply('Диалог отменен. Для начала нового — /book');
  });

  // /status command
  bot.command('status', async (ctx) => {
    const state = getState(ctx.from!.id);
    if (state.step === 'idle') {
      await ctx.reply('Нет активного диалога. Начните с /book');
    } else {
      await ctx.reply(`Текущий шаг: ${stepDescription(state.step)}`);
    }
  });

  // /demo command — run demo scenario with fake booking page
  bot.command('demo', async (ctx) => {
    resetState(ctx.from!.id);
    const request: BookingRequest = {
      objectId: 'Apartment 3',
      checkInDate: '12.07.2026',
      checkOutDate: '15.07.2026',
    };
    await startDemoTask(ctx, request);
  });

  // /book command — one-line mode with args OR start step-by-step dialog
  // One-line example: /book Кучуры 8 20.04.2026 24.04.2026
  // Object name may contain spaces; last two tokens = dates.
  bot.hears(/^\/book(?:\s+(.+))?$/i, async (ctx) => {
    const userId = ctx.from!.id;
    const argsText = (ctx.match[1] ?? '').trim();

    if (argsText) {
      // Multi-object form: /book (obj date date) (obj date date) ...
      // Single-object form (no parens) also supported.
      const groupRegex = /\(([^()]+)\)/g;
      const groups: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = groupRegex.exec(argsText)) !== null) {
        groups.push(m[1].trim());
      }
      const rawEntries = groups.length > 0 ? groups : [argsText];

      if (rawEntries.length > 18) {
        await ctx.reply(`Ошибка: не более 18 объектов за раз (получено ${rawEntries.length}).`);
        return;
      }

      const requests: BookingRequest[] = [];
      for (let i = 0; i < rawEntries.length; i++) {
        const label = rawEntries.length > 1 ? `#${i + 1} ` : '';
        const parts = rawEntries[i].split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          await ctx.reply(`Ошибка ${label}: ожидаю "[<объект>] <заезд> <выезд>"`);
          return;
        }

        const checkOut = parts[parts.length - 1];
        const checkIn = parts[parts.length - 2];
        // 2 tokens => no objectId (auto-discover); more tokens => prefix is name.
        const objectIdRaw = parts.slice(0, parts.length - 2).join(' ').trim();
        const objectId = /^(-|авто|auto)$/i.test(objectIdRaw) ? '' : objectIdRaw;

        const checkInResult = validateDate(checkIn);
        if (!checkInResult.valid) {
          await ctx.reply(`Ошибка ${label}(заезд): ${checkInResult.error}`);
          return;
        }
        const checkOutResult = validateDate(checkOut);
        if (!checkOutResult.valid) {
          await ctx.reply(`Ошибка ${label}(выезд): ${checkOutResult.error}`);
          return;
        }
        const rangeResult = validateDateRange(checkIn, checkOut);
        if (!rangeResult.valid) {
          await ctx.reply(`Ошибка ${label}: ${rangeResult.error}`);
          return;
        }

        requests.push({
          objectId,
          checkInDate: checkIn,
          checkOutDate: checkOut,
        });
      }

      resetState(userId);
      if (requests.length > 1) {
        await ctx.reply(`Принято ${requests.length} заявок. Выполняю по очереди...`);
      }
      // Run in background so the bot handler doesn't hit Telegraf's 90s timeout
      void (async () => {
        for (let i = 0; i < requests.length; i++) {
          try {
            if (requests.length > 1) {
              const label = requests[i].objectId || '(авто-поиск)';
              await ctx.reply(`▶ ${i + 1}/${requests.length}: ${label}`);
            }
            await startTask(ctx, requests[i]);
          } catch (err: any) {
            logger.error('Batch task failed', { index: i + 1, error: err?.message });
            try { await ctx.reply(`❌ ${i + 1}/${requests.length}: ${err?.message ?? err}`); } catch {}
          }
        }
      })();
      return;
    }

    resetState(userId);
    const state = getState(userId);
    state.step = 'awaiting_object';
    await ctx.reply(
      'Создание ссылки на бронирование.\n\n' +
      'Шаг 1/3: Укажите объект (название или ID в RealtyCalendar). ' +
      'Введите "-" или "авто", чтобы автоматически найти свободные квартиры по датам.'
    );
  });

  // Handle text messages for step-by-step dialog
  bot.on('text', async (ctx) => {
    const userId = ctx.from!.id;
    const state = getState(userId);
    const text = ctx.message.text.trim();

    switch (state.step) {
      case 'awaiting_object': {
        if (!text) {
          await ctx.reply('Пожалуйста, укажите название или ID объекта (или "-" для авто-поиска):');
          return;
        }
        state.data.objectId = /^(-|авто|auto)$/i.test(text) ? '' : text;
        state.step = 'awaiting_checkin';
        await ctx.reply('Шаг 2/3: Укажите дату заезда (ДД.ММ.ГГГГ):');
        break;
      }

      case 'awaiting_checkin': {
        const result = validateDate(text);
        if (!result.valid) {
          await ctx.reply(`${result.error}\nПопробуйте снова:`);
          return;
        }
        state.data.checkInDate = text;
        state.step = 'awaiting_checkout';
        await ctx.reply('Шаг 3/3: Укажите дату выезда (ДД.ММ.ГГГГ):');
        break;
      }

      case 'awaiting_checkout': {
        const dateResult = validateDate(text);
        if (!dateResult.valid) {
          await ctx.reply(`${dateResult.error}\nПопробуйте снова:`);
          return;
        }
        const rangeResult = validateDateRange(state.data.checkInDate!, text);
        if (!rangeResult.valid) {
          await ctx.reply(`${rangeResult.error}\nПопробуйте снова:`);
          return;
        }
        state.data.checkOutDate = text;
        state.step = 'awaiting_confirm';

        const d = state.data;
        await ctx.reply(
          'Проверьте данные:\n\n' +
          `Объект: ${d.objectId || '(авто-поиск свободной квартиры)'}\n` +
          `Заезд: ${d.checkInDate}\n` +
          `Выезд: ${d.checkOutDate}\n\n` +
          'Всё верно? Отправьте "да" для подтверждения или "нет" для отмены.'
        );
        break;
      }

      case 'awaiting_confirm': {
        const answer = text.toLowerCase();
        if (answer === 'да' || answer === 'yes' || answer === 'д') {
          const request: BookingRequest = {
            objectId: state.data.objectId!,
            checkInDate: state.data.checkInDate!,
            checkOutDate: state.data.checkOutDate!,
          };
          resetState(userId);
          await startTask(ctx, request);
        } else if (answer === 'нет' || answer === 'no' || answer === 'н') {
          resetState(userId);
          await ctx.reply('Операция отменена. Для начала нового диалога — /book');
        } else {
          await ctx.reply('Пожалуйста, ответьте "да" или "нет":');
        }
        break;
      }

      default: {
        await ctx.reply(
          'Не понимаю. Доступные команды:\n' +
          '/book — создать ссылку на бронирование\n' +
          '/cancel — отменить диалог\n' +
          '/status — статус'
        );
      }
    }
  });

  return bot;
}

async function startTask(ctx: Context, request: BookingRequest): Promise<void> {
  const chatId = ctx.chat!.id;

  await ctx.reply(
    `Задача принята. Запускаю автоматизацию...\n\n` +
    `Объект: ${request.objectId || '(авто-поиск)'}\n` +
    `Даты: ${request.checkInDate} – ${request.checkOutDate}`
  );

  try {
    await createAndRunTask(request, async (taskId, status, result) => {
      try {
        if (status === 'running') {
          await ctx.telegram.sendMessage(chatId, `⏳ Задача ${taskId}: выполняется...`);
        } else if (status === 'completed' && result?.success) {
          const properties = result.availableProperties && result.availableProperties.length > 0
            ? result.availableProperties.join(', ')
            : result.request.objectId || request.objectId;
          let message =
            `✅ Задача ${taskId}: выполнено!\n\n` +
            `Объект: ${properties}\n` +
            `Даты: ${request.checkInDate} – ${request.checkOutDate}\n\n` +
            `Ссылка: ${result.bookingUrl}`;

          await ctx.telegram.sendMessage(chatId, message);

          // Send screenshot
          if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
            await ctx.telegram.sendPhoto(chatId, {
              source: fs.createReadStream(result.screenshotPath),
            });
          }
        } else if (status === 'error' && result) {
          let message =
            `❌ Задача ${taskId}: ошибка\n\n` +
            `Описание: ${result.errorMessage}`;

          await ctx.telegram.sendMessage(chatId, message);

          // Send error screenshot if available
          if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
            await ctx.telegram.sendPhoto(chatId, {
              source: fs.createReadStream(result.screenshotPath),
            });
          }
        }
      } catch (sendError: any) {
        logger.error('Failed to send status update to Telegram', {
          taskId,
          error: sendError.message,
        });
      }
    });
  } catch (error: any) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
}

async function startDemoTask(ctx: Context, request: BookingRequest): Promise<void> {
  const chatId = ctx.chat!.id;

  await ctx.reply(
    '🎬 Запускаю демонстрацию...\n\n' +
    'Бот откроет тестовую страницу бронирования, заполнит форму, ' +
    'создаст ссылку и отправит результат.\n\n' +
    `Объект: ${request.objectId}\n` +
    `Даты: ${request.checkInDate} – ${request.checkOutDate}`
  );

  try {
    await createAndRunDemoTask(request, async (taskId, status, result) => {
      try {
        if (status === 'running') {
          await ctx.telegram.sendMessage(chatId, `⏳ Демо ${taskId}: автоматизация работает...`);
        } else if (status === 'completed' && result?.success) {
          let message =
            `✅ Демо ${taskId}: выполнено!\n\n` +
            `Объект: ${request.objectId}\n` +
            `Даты: ${request.checkInDate} – ${request.checkOutDate}\n\n` +
            `Ссылка: ${result.bookingUrl}\n\n` +
            '💡 Это демонстрация. В рабочем режиме (/book) бот делает то же самое на реальном сайте RealtyCalendar.';

          await ctx.telegram.sendMessage(chatId, message);

          if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
            await ctx.telegram.sendPhoto(chatId, {
              source: fs.createReadStream(result.screenshotPath),
            });
          }
        } else if (status === 'error' && result) {
          await ctx.telegram.sendMessage(chatId, `❌ Демо ошибка: ${result.errorMessage}`);
          if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
            await ctx.telegram.sendPhoto(chatId, {
              source: fs.createReadStream(result.screenshotPath),
            });
          }
        }
      } catch (sendError: any) {
        logger.error('Failed to send demo status to Telegram', { taskId, error: sendError.message });
      }
    });
  } catch (error: any) {
    await ctx.reply(`❌ Ошибка демо: ${error.message}`);
  }
}

function stepDescription(step: ConversationStep): string {
  const descriptions: Record<ConversationStep, string> = {
    idle: 'нет активного диалога',
    awaiting_object: 'ожидание объекта',
    awaiting_checkin: 'ожидание даты заезда',
    awaiting_checkout: 'ожидание даты выезда',
    awaiting_confirm: 'ожидание подтверждения',
  };
  return descriptions[step];
}
