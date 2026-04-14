import { chromium, Browser, BrowserContext, Page, Locator } from 'playwright';
import fs from 'fs';
import { config } from '../config';
import { BookingRequest, TaskResult } from '../types';
import { logger } from '../services/logger';
import { getScreenshotPath, getErrorScreenshotPath } from '../services/storage';

const TIMEOUT = 30_000;
const LOGIN_PATH_PATTERNS = ['/login', '/sign_in', '/users/sign_in', '/auth/sign-in'];

function isLoginUrl(url: string): boolean {
  return LOGIN_PATH_PATTERNS.some((pattern) => url.includes(pattern));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatRussianDate(date: string): string {
  const [day, month, year] = date.split('.').map(Number);
  const monthNames = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];

  return `${day} ${monthNames[month - 1]} ${year} г.`;
}

async function ensureAuth(context: BrowserContext, page: Page, taskId: string): Promise<void> {
  logger.info('Navigating to RealtyCalendar', { taskId });
  await page.goto(config.realtyCalendar.baseUrl, {
    waitUntil: 'networkidle',
    timeout: TIMEOUT,
  });

  const url = page.url();
  if (isLoginUrl(url)) {
    logger.info('Not authenticated, performing login', { taskId });
    await performLogin(page, taskId);
    await context.storageState({ path: config.storage.authStateFile });
    logger.info('Auth state saved', { taskId });
  } else {
    logger.info('Already authenticated', { taskId });
  }
}

async function performLogin(page: Page, taskId: string): Promise<void> {
  await page.waitForSelector('input[type="email"], input[name="email"], input[name="user[email]"]', {
    timeout: TIMEOUT,
  });

  const emailInput = page.locator('input[type="email"], input[name="email"], input[name="user[email]"]').first();
  await emailInput.fill(config.realtyCalendar.login);

  const passwordInput = page.locator('input[type="password"], input[name="password"], input[name="user[password]"]').first();
  await passwordInput.fill(config.realtyCalendar.password);

  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
  await page.waitForFunction(
    (patterns) => !patterns.some((pattern: string) => globalThis.location.href.includes(pattern)),
    LOGIN_PATH_PATTERNS,
    { timeout: TIMEOUT }
  );

  const afterLoginUrl = page.url();
  if (isLoginUrl(afterLoginUrl)) {
    throw new Error('Login failed - still on login page after submitting credentials');
  }

  logger.info('Login successful', { taskId, url: afterLoginUrl });
}

async function openPropertyCart(page: Page, objectId: string): Promise<void> {
  const safeName = escapeRegExp(objectId);
  const row = page.locator('th.no-move-table, tr, [role="row"]').filter({
    has: page.locator('a.object-title, a').filter({ hasText: new RegExp(safeName, 'i') }),
  }).first();

  if (await row.count() === 0) {
    throw new Error(`Object "${objectId}" not found in RealtyCalendar table`);
  }

  const mailIcon = row.locator(
    'span.object-icon:has-text("mail_outline"), span.material-icons:has-text("mail_outline")'
  ).first();

  if (await mailIcon.count() === 0) {
    throw new Error(`mail_outline icon was not found for object "${objectId}"`);
  }

  await mailIcon.click();
  logger.info('Clicked object mail icon', { objectId });
  await page.getByRole('button', { name: /Корзина/i }).click();
  logger.info('Clicked cart button', { objectId });
}

async function getCartModal(page: Page): Promise<Locator> {
  const modal = page.locator('.modal.show, [role="dialog"]').filter({ hasText: /Корзина/i }).last();
  await modal.waitFor({ state: 'visible', timeout: TIMEOUT });
  return modal;
}

async function setCartDate(modal: Locator, label: 'Заезд' | 'Выезд', value: string): Promise<void> {
  const row = modal.locator('div.d-flex.align-items-center.flex-shrink-0').filter({ hasText: label }).first();
  await row.waitFor({ state: 'visible', timeout: TIMEOUT });

  const input = row.locator('input.input-date, input[placeholder*="Не задано"]').first();
  const formattedValue = formatRussianDate(value);

  await input.evaluate(
    (element, nextValue) => {
      const inputElement = element as any;
      inputElement.removeAttribute('readonly');
      inputElement.value = nextValue;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
      inputElement.dispatchEvent(new Event('blur', { bubbles: true }));
    },
    formattedValue
  );

  logger.info('Updated cart date field', { label, value, formattedValue });
}

async function extractBookingUrl(page: Page): Promise<{ linkModal: Locator; bookingUrl: string | null }> {
  const linkModal = page.locator('.modal.show, [role="dialog"]').filter({ hasText: /Ссылка/i }).last();
  await linkModal.waitFor({ state: 'visible', timeout: TIMEOUT });
  logger.info('Link modal opened');

  const directValueInput = linkModal.locator(
    'input[readonly][value*="http"], input[type="text"][value*="http"], textarea'
  ).first();

  if (await directValueInput.count() > 0) {
    const tagName = await directValueInput.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === 'textarea') {
      const value = await directValueInput.evaluate((el) => (el as any).value);
      if (value) {
        logger.info('Booking URL extracted from textarea');
        return { linkModal, bookingUrl: value };
      }
    } else {
      const value = await directValueInput.inputValue();
      if (value) {
        logger.info('Booking URL extracted from text input');
        return { linkModal, bookingUrl: value };
      }
    }
  }

  const copyButton = linkModal.getByRole('button', { name: /Скопировать/i }).first();
  if (await copyButton.count() > 0) {
    await copyButton.click();
    logger.info('Clicked copy button in link modal');

    try {
      const clipboardValue = await page.evaluate(async () => {
        const nav = navigator as any;
        return nav.clipboard?.readText ? await nav.clipboard.readText() : '';
      });
      if (clipboardValue) {
        logger.info('Booking URL extracted from clipboard');
        return { linkModal, bookingUrl: clipboardValue };
      }
    } catch {
      logger.warn('Clipboard API unavailable while extracting booking URL');
    }
  }

  const hrefLink = linkModal.locator('a[href*="http"]').first();
  if (await hrefLink.count() > 0) {
    logger.info('Booking URL extracted from anchor href');
    return {
      linkModal,
      bookingUrl: await hrefLink.getAttribute('href'),
    };
  }

  return { linkModal, bookingUrl: null };
}

export async function runBookingScenario(
  taskId: string,
  request: BookingRequest
): Promise<TaskResult> {
  const startedAt = new Date();
  let browser: Browser | null = null;

  try {
    logger.info('Starting booking scenario', { taskId, request });

    browser = await chromium.launch({
      headless: config.playwright.headless,
    });

    const contextOptions: any = {
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
    };

    if (fs.existsSync(config.storage.authStateFile)) {
      contextOptions.storageState = config.storage.authStateFile;
      logger.info('Using saved auth state', { taskId });
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    await ensureAuth(context, page, taskId);

    logger.info('Opening RealtyCalendar main page', { taskId, objectId: request.objectId });
    await page.goto(config.realtyCalendar.baseUrl, {
      waitUntil: 'networkidle',
      timeout: TIMEOUT,
    });

    logger.info('Opening property cart', { taskId, objectId: request.objectId });
    await openPropertyCart(page, request.objectId);
    logger.info('Property cart flow opened', { taskId, objectId: request.objectId });

    const cartModal = await getCartModal(page);
    logger.info('Cart modal visible', { taskId });

    logger.info('Setting cart dates', {
      taskId,
      checkInDate: request.checkInDate,
      checkOutDate: request.checkOutDate,
    });
    await setCartDate(cartModal, 'Заезд', request.checkInDate);
    await setCartDate(cartModal, 'Выезд', request.checkOutDate);

    logger.info('Setting markup', { taskId, markup: request.discount });
    const markupInput = cartModal.locator(
      'input.form-control.form-control-sm.min-width-60.max-width-80, input[id]'
    ).first();
    await markupInput.fill(String(request.discount));
    logger.info('Markup field updated', { taskId, markup: request.discount });

    await cartModal.getByRole('button', { name: /^Добавить$/i }).click();
    logger.info('Clicked add button in cart modal', { taskId });
    await cartModal.getByRole('button', { name: /Получить ссылку/i }).click();
    logger.info('Clicked get link button in cart modal', { taskId });

    logger.info('Extracting booking URL', { taskId });
    await page.waitForTimeout(1000);
    const { linkModal, bookingUrl } = await extractBookingUrl(page);

    if (!bookingUrl) {
      const errorScreenshot = getErrorScreenshotPath(taskId);
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(
        'Could not extract booking URL from the basket link modal. ' +
        'The page structure may have changed. Check error screenshot.'
      );
    }

    const closeBtn = linkModal.locator('button.btn-close[data-bs-dismiss="modal"], button.btn-close').first();
    if (await closeBtn.count() > 0) {
      await closeBtn.click();
      logger.info('Closed link modal', { taskId });
    }

    const screenshotPath = getScreenshotPath(taskId);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger.info('Screenshot saved', { taskId, screenshotPath });

    await context.close();

    const result: TaskResult = {
      taskId,
      success: true,
      bookingUrl,
      screenshotPath,
      request,
      startedAt,
      completedAt: new Date(),
    };

    logger.info('Booking scenario completed successfully', { taskId, bookingUrl });
    return result;
  } catch (error: any) {
    logger.error('Booking scenario failed', {
      taskId,
      error: error.message,
      stack: error.stack,
    });

    let errorScreenshot: string | undefined;
    try {
      if (browser) {
        const contexts = browser.contexts();
        if (contexts.length > 0) {
          const pages = contexts[0].pages();
          if (pages.length > 0) {
            errorScreenshot = getErrorScreenshotPath(taskId);
            await pages[0].screenshot({ path: errorScreenshot, fullPage: true });
          }
        }
      }
    } catch {
      // Ignore screenshot errors during error handling
    }

    return {
      taskId,
      success: false,
      errorMessage: error.message,
      screenshotPath: errorScreenshot,
      request,
      startedAt,
      completedAt: new Date(),
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
