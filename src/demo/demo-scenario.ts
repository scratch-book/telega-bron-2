import { chromium } from 'playwright';
import { BookingRequest, TaskResult } from '../types';
import { logger } from '../services/logger';
import { getScreenshotPath, getErrorScreenshotPath } from '../services/storage';
import { config } from '../config';

const DEMO_PAGE_URL = 'https://scratch-book.github.io/telega-bron-demo/';

export async function runDemoScenario(
  taskId: string,
  request: BookingRequest
): Promise<TaskResult> {
  const startedAt = new Date();
  let browser = null;

  try {
    logger.info('Using public demo page', { taskId, url: DEMO_PAGE_URL });

    // Launch browser (visible for demo effect)
    browser = await chromium.launch({
      headless: config.playwright.headless,
      slowMo: 400, // slow down for visual demo effect
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'ru-RU',
    });
    const page = await context.newPage();

    // Step 1: Open demo page
    logger.info('[Demo] Opening demo page', { taskId });
    await page.goto(DEMO_PAGE_URL, { waitUntil: 'networkidle' });

    // Step 2: Login
    logger.info('[Demo] Logging in', { taskId });
    await page.fill('input#loginEmail', 'manager@realtycalendar.ru');
    await page.fill('input#loginPassword', 'demo12345');
    await page.click('#loginBtn');
    await page.waitForSelector('#dashboard', { state: 'visible' });

    // Step 3: Select property
    logger.info('[Demo] Selecting property', { taskId, objectId: request.objectId });
    const propertyLink = page.locator('.object-link').filter({
      hasText: new RegExp(request.objectId, 'i'),
    }).first();

    if (await propertyLink.count() === 0) {
      // Fallback: click first property
      await page.locator('.object-link').first().click();
    } else {
      await propertyLink.click();
    }
    await page.waitForSelector('#bookingForm', { state: 'visible' });

    // Step 4: Fill booking form
    logger.info('[Demo] Filling booking form', { taskId });
    await page.fill('#checkIn', request.checkInDate);
    await page.fill('#checkOut', request.checkOutDate);
    await page.fill('#guests', String(request.guests));
    await page.fill('#discount', String(request.discount));

    if (request.comment) {
      await page.fill('#comment', request.comment);
    }

    // Step 5: Generate link
    logger.info('[Demo] Generating booking link', { taskId });
    await page.click('#generateBtn');
    await page.waitForSelector('#resultBlock.show', { state: 'visible' });

    // Step 6: Extract the booking link
    const bookingUrl = await page.locator('#bookingLink').innerText();

    // Step 7: Take screenshot
    const screenshotPath = getScreenshotPath(taskId);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger.info('[Demo] Screenshot saved', { taskId, screenshotPath });

    await context.close();

    return {
      taskId,
      success: true,
      bookingUrl,
      screenshotPath,
      request,
      startedAt,
      completedAt: new Date(),
    };
  } catch (error: any) {
    logger.error('[Demo] Scenario failed', { taskId, error: error.message });

    let errorScreenshot: string | undefined;
    try {
      if (browser) {
        const pages = browser.contexts()[0]?.pages();
        if (pages?.length) {
          errorScreenshot = getErrorScreenshotPath(taskId);
          await pages[0].screenshot({ path: errorScreenshot, fullPage: true });
        }
      }
    } catch { /* ignore */ }

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
    if (browser) await browser.close();
  }
}
