import { Telegraf, Context } from 'telegraf';
import fs from 'fs';
import { config } from '../config';
import { BookingRequest, TaskResult } from '../types';
import { createAndRunTask } from '../services/taskRunner';
import { logger } from '../services/logger';
import {
  validateDate,
  validateDateRange,
  validateGuests,
  validateDiscount,
} from './validation';

// Conversation states for step-by-step dialog
type ConversationStep =
  | 'idle'
  | 'awaiting_object'
  | 'awaiting_checkin'
  | 'awaiting_checkout'
  | 'awaiting_guests'
  | 'awaiting_discount'
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
      'Привет! Я бот для создания ссылок на бронирование со скидкой в RealtyCalendar.\n\n' +
      'Команды:\n' +
      '/discount — создать ссылку со скидкой (пошаговый диалог)\n' +
      '/cancel — отменить текущий диалог\n' +
      '/status — проверить статус'
    );
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    resetState(ctx.from!.id);
    await ctx.reply('Диалог отменен. Для начала нового — /discount');
  });

  // /status command
  bot.command('status', async (ctx) => {
    const state = getState(ctx.from!.id);
    if (state.step === 'idle') {
      await ctx.reply('Нет активного диалога. Начните с /discount');
    } else {
      await ctx.reply(`Текущий шаг: ${stepDescription(state.step)}`);
    }
  });

  // /discount command — start the step-by-step dialog
  bot.command('discount', async (ctx) => {
    const userId = ctx.from!.id;
    resetState(userId);

    const state = getState(userId);
    state.step = 'awaiting_object';
    await ctx.reply(
      'Создание ссылки со скидкой.\n\n' +
      'Шаг 1/5: Укажите объект (название или ID объекта в RealtyCalendar):'
    );
  });

  // Handle one-line /discount command with all parameters
  // Example: /discount apartment_3 12.07.2026 15.07.2026 2 10
  bot.hears(/^\/discount\s+(.+)$/i, async (ctx) => {
    const parts = ctx.match[1].trim().split(/\s+/);
    if (parts.length >= 5) {
      const [objectId, checkIn, checkOut, guestsStr, discountStr] = parts;

      // Validate all at once
      const checkInResult = validateDate(checkIn);
      if (!checkInResult.valid) {
        await ctx.reply(`Ошибка: ${checkInResult.error}`);
        return;
      }
      const checkOutResult = validateDate(checkOut);
      if (!checkOutResult.valid) {
        await ctx.reply(`Ошибка: ${checkOutResult.error}`);
        return;
      }
      const rangeResult = validateDateRange(checkIn, checkOut);
      if (!rangeResult.valid) {
        await ctx.reply(`Ошибка: ${rangeResult.error}`);
        return;
      }
      const guestsResult = validateGuests(guestsStr);
      if (!guestsResult.valid) {
        await ctx.reply(`Ошибка: ${guestsResult.error}`);
        return;
      }
      const discountResult = validateDiscount(discountStr);
      if (!discountResult.valid) {
        await ctx.reply(`Ошибка: ${discountResult.error}`);
        return;
      }

      const request: BookingRequest = {
        objectId,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guests: guestsResult.value!,
        discount: discountResult.value!,
      };

      await startTask(ctx, request);
    }
    // If less than 5 parts, the regular /discount handler will handle it
  });

  // Handle text messages for step-by-step dialog
  bot.on('text', async (ctx) => {
    const userId = ctx.from!.id;
    const state = getState(userId);
    const text = ctx.message.text.trim();

    switch (state.step) {
      case 'awaiting_object': {
        if (!text) {
          await ctx.reply('Пожалуйста, укажите название или ID объекта:');
          return;
        }
        state.data.objectId = text;
        state.step = 'awaiting_checkin';
        await ctx.reply('Шаг 2/5: Укажите дату заезда (ДД.ММ.ГГГГ):');
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
        await ctx.reply('Шаг 3/5: Укажите дату выезда (ДД.ММ.ГГГГ):');
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
        state.step = 'awaiting_guests';
        await ctx.reply('Шаг 4/5: Сколько гостей?');
        break;
      }

      case 'awaiting_guests': {
        const result = validateGuests(text);
        if (!result.valid) {
          await ctx.reply(`${result.error}\nПопробуйте снова:`);
          return;
        }
        state.data.guests = result.value;
        state.step = 'awaiting_discount';
        await ctx.reply('Шаг 5/5: Размер скидки (в процентах, 1–99):');
        break;
      }

      case 'awaiting_discount': {
        const result = validateDiscount(text);
        if (!result.valid) {
          await ctx.reply(`${result.error}\nПопробуйте снова:`);
          return;
        }
        state.data.discount = result.value;
        state.step = 'awaiting_confirm';

        const d = state.data;
        await ctx.reply(
          'Проверьте данные:\n\n' +
          `Объект: ${d.objectId}\n` +
          `Заезд: ${d.checkInDate}\n` +
          `Выезд: ${d.checkOutDate}\n` +
          `Гостей: ${d.guests}\n` +
          `Скидка: ${d.discount}%\n\n` +
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
            guests: state.data.guests!,
            discount: state.data.discount!,
          };
          resetState(userId);
          await startTask(ctx, request);
        } else if (answer === 'нет' || answer === 'no' || answer === 'н') {
          resetState(userId);
          await ctx.reply('Операция отменена. Для начала нового диалога — /discount');
        } else {
          await ctx.reply('Пожалуйста, ответьте "да" или "нет":');
        }
        break;
      }

      default: {
        await ctx.reply(
          'Не понимаю. Доступные команды:\n' +
          '/discount — создать ссылку со скидкой\n' +
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
    `Объект: ${request.objectId}\n` +
    `Даты: ${request.checkInDate} – ${request.checkOutDate}\n` +
    `Гостей: ${request.guests}\n` +
    `Скидка: ${request.discount}%`
  );

  try {
    await createAndRunTask(request, async (taskId, status, result) => {
      try {
        if (status === 'running') {
          await ctx.telegram.sendMessage(chatId, `⏳ Задача ${taskId}: выполняется...`);
        } else if (status === 'completed' && result?.success) {
          // Send success message
          let message =
            `✅ Задача ${taskId}: выполнено успешно!\n\n` +
            `Объект: ${request.objectId}\n` +
            `Даты: ${request.checkInDate} – ${request.checkOutDate}\n` +
            `Гостей: ${request.guests}\n` +
            `Скидка: ${request.discount}%\n\n` +
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

function stepDescription(step: ConversationStep): string {
  const descriptions: Record<ConversationStep, string> = {
    idle: 'нет активного диалога',
    awaiting_object: 'ожидание объекта',
    awaiting_checkin: 'ожидание даты заезда',
    awaiting_checkout: 'ожидание даты выезда',
    awaiting_guests: 'ожидание количества гостей',
    awaiting_discount: 'ожидание размера скидки',
    awaiting_confirm: 'ожидание подтверждения',
  };
  return descriptions[step];
}
