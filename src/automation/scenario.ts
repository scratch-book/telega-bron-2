import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import { config } from '../config';
import { BookingRequest, TaskResult } from '../types';
import { logger } from '../services/logger';
import { getScreenshotPath, getErrorScreenshotPath } from '../services/storage';

const TIMEOUT = 30_000;

async function ensureAuth(context: BrowserContext, page: Page, taskId: string): Promise<void> {
  logger.info('Navigating to RealtyCalendar', { taskId });
  await page.goto(`${config.realtyCalendar.baseUrl}/dashboard`, {
    waitUntil: 'networkidle',
    timeout: TIMEOUT,
  });

  // Check if we're on the login page
  const url = page.url();
  if (url.includes('/login') || url.includes('/sign_in') || url.includes('/users/sign_in')) {
    logger.info('Not authenticated, performing login', { taskId });
    await performLogin(page, taskId);
    // Save auth state for future reuse
    await context.storageState({ path: config.storage.authStateFile });
    logger.info('Auth state saved', { taskId });
  } else {
    logger.info('Already authenticated', { taskId });
  }
}

async function performLogin(page: Page, taskId: string): Promise<void> {
  // Wait for login form
  await page.waitForSelector('input[type="email"], input[name="email"], input[name="user[email]"]', {
    timeout: TIMEOUT,
  });

  // Fill email
  const emailInput = page.locator('input[type="email"], input[name="email"], input[name="user[email]"]').first();
  await emailInput.fill(config.realtyCalendar.login);

  // Fill password
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[name="user[password]"]').first();
  await passwordInput.fill(config.realtyCalendar.password);

  // Click submit
  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT });

  const afterLoginUrl = page.url();
  if (afterLoginUrl.includes('/login') || afterLoginUrl.includes('/sign_in')) {
    throw new Error('Login failed — still on login page after submitting credentials');
  }

  logger.info('Login successful', { taskId, url: afterLoginUrl });
}

export async function runBookingScenario(
  taskId: string,
  request: BookingRequest
): Promise<TaskResult> {
  const startedAt = new Date();
  let browser: Browser | null = null;

  try {
    logger.info('Starting booking scenario', { taskId, request });

    // Launch browser
    const launchOptions: any = {
      headless: config.playwright.headless,
    };

    browser = await chromium.launch(launchOptions);

    // Use saved auth state if available
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

    // Step 1: Authenticate
    await ensureAuth(context, page, taskId);

    // Step 2: Navigate to properties / objects list
    logger.info('Looking for property', { taskId, objectId: request.objectId });
    await page.goto(`${config.realtyCalendar.baseUrl}/dashboard`, {
      waitUntil: 'networkidle',
      timeout: TIMEOUT,
    });

    // Step 3: Find and click the target property
    // Try to find property by text content matching objectId
    const propertyLink = page.locator(`a, div, span`)
      .filter({ hasText: new RegExp(request.objectId, 'i') })
      .first();

    const propertyExists = await propertyLink.count();
    if (propertyExists === 0) {
      throw new Error(`Property "${request.objectId}" not found on dashboard`);
    }
    await propertyLink.click();
    await page.waitForLoadState('networkidle');

    logger.info('Property page opened', { taskId });

    // Step 4: Navigate to booking creation / calendar
    // Look for "Create booking" or similar button
    const createBookingBtn = page.locator(
      'a:has-text("Создать бронь"), a:has-text("Новое бронирование"), ' +
      'button:has-text("Создать бронь"), button:has-text("Новое бронирование"), ' +
      'a:has-text("Создать ссылку"), button:has-text("Создать ссылку"), ' +
      '[data-action="create-booking"], [href*="booking/new"], [href*="bookings/new"]'
    ).first();

    const createBtnExists = await createBookingBtn.count();
    if (createBtnExists > 0) {
      await createBookingBtn.click();
      await page.waitForLoadState('networkidle');
    }

    // Step 5: Fill in booking details
    logger.info('Filling booking form', { taskId });

    // Fill check-in date
    const checkInInput = page.locator(
      'input[name*="check_in"], input[name*="checkin"], input[name*="start_date"], ' +
      'input[name*="date_from"], input[placeholder*="заезд"], input[placeholder*="Заезд"]'
    ).first();
    if (await checkInInput.count() > 0) {
      await checkInInput.fill(request.checkInDate);
    }

    // Fill check-out date
    const checkOutInput = page.locator(
      'input[name*="check_out"], input[name*="checkout"], input[name*="end_date"], ' +
      'input[name*="date_to"], input[placeholder*="выезд"], input[placeholder*="Выезд"]'
    ).first();
    if (await checkOutInput.count() > 0) {
      await checkOutInput.fill(request.checkOutDate);
    }

    // Fill guests count
    const guestsInput = page.locator(
      'input[name*="guest"], input[name*="adults"], input[name*="people"], ' +
      'input[placeholder*="гост"], input[placeholder*="Гост"]'
    ).first();
    if (await guestsInput.count() > 0) {
      await guestsInput.fill(String(request.guests));
    }

    // Step 6: Set discount
    logger.info('Setting discount', { taskId, discount: request.discount });
    const discountInput = page.locator(
      'input[name*="discount"], input[name*="sale"], input[name*="скидк"], ' +
      'input[placeholder*="скидк"], input[placeholder*="Скидк"]'
    ).first();
    if (await discountInput.count() > 0) {
      await discountInput.fill(String(request.discount));
    }

    // Fill client name if provided
    if (request.clientName) {
      const nameInput = page.locator(
        'input[name*="name"], input[name*="client"], input[name*="guest_name"], ' +
        'input[placeholder*="имя"], input[placeholder*="Имя"]'
      ).first();
      if (await nameInput.count() > 0) {
        await nameInput.fill(request.clientName);
      }
    }

    // Fill comment if provided
    if (request.comment) {
      const commentInput = page.locator(
        'textarea[name*="comment"], textarea[name*="note"], ' +
        'textarea[placeholder*="комментар"], textarea[placeholder*="Комментар"]'
      ).first();
      if (await commentInput.count() > 0) {
        await commentInput.fill(request.comment);
      }
    }

    // Step 7: Generate booking link
    logger.info('Generating booking link', { taskId });
    const generateBtn = page.locator(
      'button:has-text("Создать ссылку"), button:has-text("Получить ссылку"), ' +
      'button:has-text("Сгенерировать"), button:has-text("Сохранить"), ' +
      'a:has-text("Создать ссылку"), a:has-text("Получить ссылку"), ' +
      'button[type="submit"]'
    ).first();

    if (await generateBtn.count() > 0) {
      await generateBtn.click();
      await page.waitForLoadState('networkidle');
    }

    // Step 8: Extract the booking link
    logger.info('Extracting booking URL', { taskId });

    // Wait a moment for the link to appear
    await page.waitForTimeout(2000);

    // Try multiple strategies to find the generated link
    let bookingUrl: string | null = null;

    // Strategy 1: Look for a link in a success/result area
    const linkElement = page.locator(
      'input[readonly][value*="http"], input[type="text"][value*="http"], ' +
      'a[href*="booking"], a[href*="reserve"], ' +
      '.booking-link, .result-link, [data-booking-url], ' +
      'input[value*="realtycalendar"]'
    ).first();

    if (await linkElement.count() > 0) {
      const tagName = await linkElement.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === 'a') {
        bookingUrl = await linkElement.getAttribute('href');
      } else {
        bookingUrl = await linkElement.inputValue();
      }
    }

    // Strategy 2: Look for any visible text that looks like a URL
    if (!bookingUrl) {
      const allText = await page.locator('body').innerText();
      const urlMatch = allText.match(/https?:\/\/[^\s]+(?:booking|reserve|bron|pay)[^\s]*/i);
      if (urlMatch) {
        bookingUrl = urlMatch[0];
      }
    }

    // Strategy 3: Check clipboard if a "copy" button was clicked
    if (!bookingUrl) {
      const copyBtn = page.locator(
        'button:has-text("Копировать"), button:has-text("Скопировать"), ' +
        'button[data-action="copy"], .copy-btn, .copy-button'
      ).first();
      if (await copyBtn.count() > 0) {
        await copyBtn.click();
        try {
          bookingUrl = await page.evaluate(() => (navigator as any).clipboard.readText());
        } catch {
          // Clipboard API may not be available
        }
      }
    }

    if (!bookingUrl) {
      // Take screenshot even if link not found — might help debug
      const errorScreenshot = getErrorScreenshotPath(taskId);
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(
        'Could not extract booking URL from the page. ' +
        'The page structure may have changed. Check error screenshot.'
      );
    }

    // Step 9: Take success screenshot
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

    // Try to take error screenshot
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
