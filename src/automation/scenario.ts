import { chromium, Browser, BrowserContext, Page, Locator } from 'playwright';
import fs from 'fs';
import { config } from '../config';
import { BookingRequest, PropertyAvailability, TaskResult } from '../types';
import { logger } from '../services/logger';
import {
  getScreenshotPath,
  getErrorScreenshotPath,
  getDebugScreenshotPath,
  getErrorHtmlPath,
} from '../services/storage';

const TIMEOUT = 30_000;
const LOGIN_PATH_PATTERNS = ['/login', '/sign_in', '/users/sign_in', '/auth/sign-in'];

function getAppOrigin(): string {
  return new URL(config.realtyCalendar.baseUrl).origin;
}

function getLoginUrl(): string {
  return `${getAppOrigin()}/auth/sign-in`;
}

function isLoginUrl(url: string): boolean {
  return LOGIN_PATH_PATTERNS.some((pattern) => url.includes(pattern));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDDMMYYYY(value: string): Date {
  const [d, m, y] = value.split('.').map(Number);
  return new Date(y, m - 1, d);
}

function formatDDMMYYYY(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getFullYear()}`;
}

function formatRussianDate(date: string): string {
  const [day, month, year] = date.split('.').map(Number);
  const monthNames = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  return `${day} ${monthNames[month - 1]} ${year} г`;
}

/** List of nights between checkIn (inclusive) and checkOut (exclusive) — one cell per night. */
function enumerateNights(checkIn: string, checkOut: string): Date[] {
  const start = parseDDMMYYYY(checkIn);
  const end = parseDDMMYYYY(checkOut);
  const nights: Date[] = [];
  const cursor = new Date(start);
  while (cursor < end) {
    nights.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return nights;
}

/**
 * A shahmatka cell is "free" iff its visible text contains a numeric price.
 * Accepts "3300", "3 300", "3\u00a0300", "3,300.00" — anything that parses as a number after stripping spaces/commas.
 */
export function isCellFree(text: string | null | undefined): boolean {
  if (!text) return false;
  const cleaned = text.replace(/[\s\u00a0]/g, '');
  if (!cleaned) return false;
  return /\d/.test(cleaned) && !isNaN(Number(cleaned.replace(/[^\d.,-]/g, '').replace(',', '.')));
}

async function saveDebugSnapshot(page: Page, taskId: string, step: string): Promise<void> {
  const path = getDebugScreenshotPath(taskId, step);
  await page.screenshot({ path, fullPage: true });
  logger.info('Saved debug screenshot', { taskId, step, path, url: page.url() });
}

async function ensureAuth(context: BrowserContext, page: Page, taskId: string): Promise<void> {
  const loginUrl = getLoginUrl();
  logger.info('Navigating to RealtyCalendar login page', { taskId, loginUrl });
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: TIMEOUT });
  logger.info('Login page opened', { taskId, url: page.url() });

  if (isLoginUrl(page.url())) {
    logger.info('Not authenticated, performing login', { taskId });
    await performLogin(page, taskId);
    await context.storageState({ path: config.storage.authStateFile });
    logger.info('Auth state saved', { taskId });
  } else {
    logger.info('Already authenticated', { taskId, url: page.url() });
  }
}

async function performLogin(page: Page, taskId: string): Promise<void> {
  await saveDebugSnapshot(page, taskId, 'login_page_before_form');

  const emailInput = page.getByRole('textbox', { name: /почта|телефон|email/i }).first();

  try {
    await emailInput.waitFor({ state: 'visible', timeout: TIMEOUT });
  } catch (err) {
    const errorHtmlPath = getErrorHtmlPath(taskId) + '_login_form.html';
    fs.writeFileSync(errorHtmlPath, await page.content(), 'utf-8');
    logger.error('Login form email input not found', { taskId, url: page.url(), errorHtmlPath });
    throw err;
  }

  await emailInput.fill(config.realtyCalendar.login);
  await page.getByRole('textbox', { name: /пароль|password/i }).first().fill(config.realtyCalendar.password);
  await page.getByRole('button', { name: /войти|sign in/i }).first().click();

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
  await page.waitForFunction(
    (patterns) =>
      !patterns.some((pattern: string) => ((globalThis as any).location?.href || '').includes(pattern)),
    LOGIN_PATH_PATTERNS,
    { timeout: TIMEOUT }
  );

  if (isLoginUrl(page.url())) {
    throw new Error('Login failed - still on login page after submitting credentials');
  }
  logger.info('Login successful', { taskId, url: page.url() });
}

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/**
 * Click the shahmatka's date range filter button and pick the check-in date.
 * The site opens a month picker that covers the shahmatka — we must click the
 * target month to close it and scroll the grid to that month.
 */
async function navigateShahmatkaToDate(page: Page, date: Date, taskId: string): Promise<void> {
  const formatted = formatRussianDate(formatDDMMYYYY(date));
  const targetMonthName = MONTH_NAMES[date.getMonth()];
  const targetYear = date.getFullYear();
  const filterBtn = page.locator('button[data-test-name="filter-date-range"]').first();

  try {
    await filterBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await filterBtn.click();
    logger.info('Opened date range filter popover', {
      taskId,
      targetDate: formatDDMMYYYY(date),
      targetMonthName,
      targetYear,
    });

    // If month picker opened (covers the shahmatka), navigate year arrows
    // until the target year is shown, then click the target month.
    const monthBtn = page.getByRole('button', { name: new RegExp(`^\\s*${targetMonthName}\\s*$`, 'i') }).first();
    let monthPickerVisible = false;
    try {
      await monthBtn.waitFor({ state: 'visible', timeout: 3000 });
      monthPickerVisible = true;
    } catch {
      logger.info('Month picker not visible, will try day label directly', { taskId });
    }

    if (monthPickerVisible) {
      // Try to align year by reading the currently displayed year and stepping arrows.
      for (let i = 0; i < 12; i++) {
        const yearText = await page
          .locator('text=/^\\s*\\d{4}\\s*$/')
          .first()
          .textContent()
          .catch(() => null);
        const shownYear = yearText ? parseInt(yearText.trim(), 10) : NaN;
        if (!Number.isFinite(shownYear) || shownYear === targetYear) break;
        const arrowName = shownYear < targetYear ? /^›$|next|впер/i : /^‹$|prev|назад/i;
        const arrow = page.getByRole('button', { name: arrowName }).first();
        if (await arrow.count() === 0) break;
        await arrow.click().catch(() => {});
        await page.waitForTimeout(150);
      }

      await monthBtn.click();
      logger.info('Clicked target month in picker', { taskId, targetMonthName });
      await page.waitForTimeout(300);
    }

    // Some layouts still show a day-picker popover after month selection.
    // Try to pick the exact day; if not found, month selection alone is enough.
    try {
      const label = page.getByLabel(formatted).first();
      await label.waitFor({ state: 'visible', timeout: 3000 });
      await label.click();
      logger.info('Picked target date in filter popover', { taskId, formatted });
    } catch {
      logger.info('Day label not shown — month click was sufficient', { taskId });
    }

    // Popover may stay open — close via Escape. Ignore errors.
    try { await page.keyboard.press('Escape'); } catch { /* noop */ }
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
  } catch (err: any) {
    logger.warn('Could not navigate shahmatka via date filter, proceeding with current view', {
      taskId,
      error: err?.message,
    });
  }
}

/**
 * Scans the shahmatka and returns availability per property for the requested nights.
 * Property is `available` iff every requested night's cell contains a numeric price.
 */
async function scanAvailability(
  page: Page,
  nights: Date[],
  taskId: string
): Promise<PropertyAvailability[]> {
  const targetDays = nights.map((d) => d.getDate());

  // Shahmatka DOM structure (discovered via diagnostics):
  //   thead.thead-days > tr > th > div.day-block > label.day-item > span.day-number
  //   tbody.main-table-tbody > tr > td(name) + td > div.cell-row > div.cell-block > div.price
  // Header .day-number spans and body .cell-block divs are in the same positional order.

  type ScanResult = {
    error: string | null;
    properties: Array<{ name: string; cellsByDay: Array<{ day: number; spanIdx: number; text: string; className: string; allText: string; coveredBy: string; cellDivChildInfo: string }> }>;
    debug?: any;
  };

  const raw: ScanResult = await page.evaluate((arg: { targetDays: number[] }): ScanResult => {
    const doc: any = (globalThis as any).document;
    const tableBlock = doc?.querySelector('#table-block');
    if (!tableBlock) {
      return { error: 'table-block not found', properties: [] };
    }

    // 1) Flat list of ALL .day-number spans from thead (each th may contain many)
    const headerDaySpans: any[] = Array.from(
      tableBlock.querySelectorAll('thead .day-number')
    );
    const dayEntries: Array<{ spanIdx: number; day: number }> = [];
    headerDaySpans.forEach((span: any, idx: number) => {
      const n = parseInt((span.textContent || '').trim(), 10);
      if (!isNaN(n)) dayEntries.push({ spanIdx: idx, day: n });
    });

    // 2) Split into month sections (day number decrease = new month boundary)
    const sections: Array<Array<{ spanIdx: number; day: number }>> = [];
    let curSection: Array<{ spanIdx: number; day: number }> = [];
    for (const entry of dayEntries) {
      if (curSection.length > 0 && entry.day < curSection[curSection.length - 1].day) {
        sections.push(curSection);
        curSection = [];
      }
      curSection.push(entry);
    }
    if (curSection.length > 0) sections.push(curSection);

    // 3) Find the section for the TARGET month.
    //    Grid shows [prev-month-tail, target-month, next-month-head].
    //    The prev-month tail starts mid-month (firstDay > 1),
    //    the target month starts from day 1 and is the longest full-month section.
    //    Among sections containing all target days, prefer ones starting with day 1 (full months).
    //    Among those, pick the longest (full target month, not short next-month head).
    const matchingSections = sections.filter((s) =>
      arg.targetDays.every((d: number) => s.some((e) => e.day === d))
    );
    // Sort: prefer firstDay===1, then by size descending
    matchingSections.sort((a, b) => {
      const aFull = a[0]?.day === 1 ? 1 : 0;
      const bFull = b[0]?.day === 1 ? 1 : 0;
      if (aFull !== bFull) return bFull - aFull; // day-1 sections first
      return b.length - a.length; // longer sections first
    });
    let targetSection = matchingSections[0];
    if (!targetSection && sections.length > 0) {
      // No section has all target days — pick the one with most matches
      targetSection = sections.reduce((best, s) => {
        const cnt = arg.targetDays.filter((d: number) => s.some((e) => e.day === d)).length;
        const bestCnt = arg.targetDays.filter((d: number) => best.some((e) => e.day === d)).length;
        return cnt > bestCnt ? s : best;
      });
    }

    // 4) Build day → spanIdx from the target section only (avoids cross-month collisions)
    const dayToSpanIdx = new Map<number, number>();
    if (targetSection) {
      for (const entry of targetSection) {
        if (!dayToSpanIdx.has(entry.day)) dayToSpanIdx.set(entry.day, entry.spanIdx);
      }
    }

    // 5) Scan body rows.
    //    DOM structure: div.cell-row contains:
    //      - div.cell × 60 (CSS grid columns, one per day — NOT bookings)
    //      - div.cell-block × 48 (content blocks: prices / events)
    //    Only the FIRST cell of a booking gets class "type-event"; subsequent cells
    //    remain "type-empty" even though visually covered by a booking bar.
    //    We detect multi-cell bookings by checking the width of child elements
    //    inside type-event cell-blocks (the booking bar extends beyond the cell).
    const rows: any[] = Array.from(tableBlock.querySelectorAll('tbody tr'));
    const properties: ScanResult['properties'] = [];

    for (const row of rows) {
      const firstCell: any = row.querySelector('td, th');
      if (!firstCell) continue;
      let nameText = (firstCell.textContent || '').trim().replace(/\s+/g, ' ');
      nameText = nameText.replace(/mail_outline$/, '').trim();
      if (!nameText) continue;

      const cellBlocks: any[] = Array.from(row.querySelectorAll('.cell-block'));

      // Build set of booked cell-block indices.
      // 1) Direct: cell-blocks with type-event / type-booked are booked.
      // 2) Span: if a type-event cell's child element is wider than the cell,
      //    it's a booking bar spanning multiple days — mark subsequent indices.
      const bookedIndices = new Set<number>();

      for (let i = 0; i < cellBlocks.length; i++) {
        const cls = (cellBlocks[i].className || '') as string;
        if (!cls.includes('type-event') && !cls.includes('type-booked')) continue;
        bookedIndices.add(i);

        const cellWidth = cellBlocks[i].getBoundingClientRect().width || cellBlocks[i].offsetWidth;
        if (cellWidth <= 0) continue;

        // Check all descendants for elements wider than the cell (booking bars)
        const descendants: any[] = Array.from(cellBlocks[i].querySelectorAll('*'));
        for (const desc of descendants) {
          // Use the largest of: rendered width, scrollWidth, parsed CSS width
          const descRect = desc.getBoundingClientRect();
          let maxW = Math.max(descRect.width, desc.scrollWidth || 0);
          const styleW = desc.style?.width || '';
          if (styleW.endsWith('px')) {
            maxW = Math.max(maxW, parseFloat(styleW) || 0);
          } else if (styleW.endsWith('%')) {
            maxW = Math.max(maxW, (parseFloat(styleW) || 0) / 100 * cellWidth);
          }

          if (maxW > cellWidth * 1.5) {
            const span = Math.round(maxW / cellWidth);
            for (let j = 1; j < span && (i + j) < cellBlocks.length; j++) {
              bookedIndices.add(i + j);
            }
            break;
          }
        }
      }

      // Also check: .cell grid divs may contain booking elements.
      // The .cell divs (60, one per day) are siblings of .cell-block divs.
      // If a .cell div at position N has children, that day may have a booking.
      const cellRow = row.querySelector('.cell-row');
      const cellGridDivs: any[] = [];
      if (cellRow) {
        for (const child of Array.from(cellRow.children) as any[]) {
          const cls = (child.className || '') as string;
          // Match exactly "cell" class, not "cell-block" or "cell-row"
          if (cls.split(/\s+/).includes('cell')) {
            cellGridDivs.push(child);
          }
        }
      }

      const cellsByDay = arg.targetDays.map((day: number) => {
        const spanIdx = dayToSpanIdx.get(day);
        if (spanIdx === undefined) return { day, spanIdx: -1, text: '', className: 'day-not-in-header', allText: '', coveredBy: '', cellDivChildInfo: '' };

        if (spanIdx >= cellBlocks.length) {
          return { day, spanIdx, text: '', className: `idx-${spanIdx}-of-${cellBlocks.length}`, allText: '', coveredBy: '', cellDivChildInfo: '' };
        }

        const block = cellBlocks[spanIdx];
        const className = (block?.className || '').substring(0, 200);
        const priceEl = block?.querySelector('.price');
        const text = priceEl ? (priceEl.textContent || '').trim() : '';
        const allText = (block?.textContent || '').trim().substring(0, 100);

        // Detection method 1: bookedIndices (type-event + span detection)
        let coveredBy = '';
        if (bookedIndices.has(spanIdx)) {
          coveredBy = 'event-span';
        }

        // Detection method 2: check .cell grid div at this index for children
        // (booking bars might be rendered inside .cell containers)
        let cellDivChildInfo = '';
        if (spanIdx < cellGridDivs.length) {
          const cd = cellGridDivs[spanIdx];
          if (cd.children.length > 0) {
            const firstChildCls = (cd.children[0]?.className || '').substring(0, 80);
            const firstChildHtml = cd.innerHTML.substring(0, 200);
            cellDivChildInfo = `${cd.children.length}ch:${firstChildCls}|${firstChildHtml}`;
          }
        }

        return { day, spanIdx, text, className, allText, coveredBy, cellDivChildInfo };
      });

      properties.push({ name: nameText, cellsByDay });
    }

    // Diagnostic: cell-blocks around target for first row
    const diagCells: Array<{ idx: number; cls: string; txt: string; innerHTML: string }> = [];
    if (rows[0] && targetSection) {
      const firstRowBlocks: any[] = Array.from(rows[0].querySelectorAll('.cell-block'));
      const sampleIdx = dayToSpanIdx.get(arg.targetDays[0]) ?? 0;
      for (let i = Math.max(0, sampleIdx - 3); i <= Math.min(firstRowBlocks.length - 1, sampleIdx + 5); i++) {
        const b = firstRowBlocks[i];
        diagCells.push({
          idx: i,
          cls: (b?.className || '').substring(0, 100),
          txt: (b?.textContent || '').trim().substring(0, 50),
          innerHTML: (b?.innerHTML || '').substring(0, 200),
        });
      }
    }

    // Diagnostic: .cell grid divs around target for first row
    const diagCellDivs: Array<{ idx: number; childCount: number; innerHTML: string }> = [];
    if (rows[0]) {
      const cr = rows[0].querySelector('.cell-row');
      if (cr) {
        const gridCells: any[] = [];
        for (const child of Array.from(cr.children) as any[]) {
          const cls = (child.className || '') as string;
          if (cls.split(/\s+/).includes('cell')) gridCells.push(child);
        }
        const sampleIdx = dayToSpanIdx.get(arg.targetDays[0]) ?? 0;
        for (let i = Math.max(0, sampleIdx - 2); i <= Math.min(gridCells.length - 1, sampleIdx + 4); i++) {
          const cd = gridCells[i];
          diagCellDivs.push({
            idx: i,
            childCount: cd.children.length,
            innerHTML: cd.innerHTML.substring(0, 300),
          });
        }
      }
    }

    // Diagnostic: type-event cell-blocks in first row
    const diagEventCells: Array<{ idx: number; innerHTML: string; childWidths: string }> = [];
    if (rows[0]) {
      const firstRowBlocks: any[] = Array.from(rows[0].querySelectorAll('.cell-block'));
      for (let i = 0; i < firstRowBlocks.length; i++) {
        const cls = (firstRowBlocks[i].className || '') as string;
        if (!cls.includes('type-event')) continue;
        const cellW = firstRowBlocks[i].getBoundingClientRect().width;
        const childWidths = Array.from(firstRowBlocks[i].querySelectorAll('*'))
          .map((el: any) => {
            const r = el.getBoundingClientRect();
            return `${(el.className || '').substring(0, 30)}:${Math.round(r.width)}px`;
          })
          .join(', ');
        diagEventCells.push({
          idx: i,
          innerHTML: firstRowBlocks[i].innerHTML.substring(0, 400),
          childWidths: `cellW=${Math.round(cellW)},children=[${childWidths}]`,
        });
      }
    }

    return {
      error: null,
      properties,
      debug: {
        headerDayCount: dayEntries.length,
        chosenSection: targetSection
          ? {
              days: `${targetSection[0]?.day}..${targetSection[targetSection.length - 1]?.day}`,
              startSpanIdx: targetSection[0]?.spanIdx,
              size: targetSection.length,
            }
          : null,
        targetDaySpanIndices: arg.targetDays.map((d: number) => ({
          day: d,
          spanIdx: dayToSpanIdx.get(d) ?? -1,
        })),
        bodyRowCount: rows.length,
        firstRowCellBlocks: rows[0] ? rows[0].querySelectorAll('.cell-block').length : 0,
        diagCellsAroundTarget: diagCells,
        diagCellDivsAroundTarget: diagCellDivs,
        diagEventCells,
      },
    };
  }, { targetDays });

  if (raw.error) {
    throw new Error(`Availability scan failed: ${raw.error}`);
  }

  logger.info('Shahmatka scan result', { taskId, targetDays, debug: raw.debug });

  const results: PropertyAvailability[] = raw.properties.map((p) => {
    const cells = p.cellsByDay.map((c, i) => {
      const dateStr = formatDDMMYYYY(nights[i]);
      // A cell is free only if it has class "type-empty" AND contains a numeric price.
      // Occupied cells (type-booked, type-reserved, etc.) may also show a price but are NOT free.
      const hasEmptyType = (c.className || '').includes('type-empty');
      const hasPrice = isCellFree(c.text);
      const coveredByBooking = !!c.coveredBy;
      // Free = has type-empty class, has numeric price, AND is NOT covered by a booking overlay
      const free = hasEmptyType && hasPrice && !coveredByBooking;
      logger.info('Cell detail', {
        taskId,
        property: p.name,
        day: c.day,
        spanIdx: c.spanIdx,
        className: c.className,
        priceText: c.text,
        allText: c.allText,
        hasEmptyType,
        hasPrice,
        coveredBy: c.coveredBy || 'none',
        cellDivChildInfo: c.cellDivChildInfo || 'empty',
        free,
      });
      return { date: dateStr, text: c.text, free };
    });
    const unavailableReason = cells.find((c) => !c.free);
    const available = !unavailableReason;
    logger.info('Property availability', {
      taskId,
      property: p.name,
      cells: p.cellsByDay,
      available,
    });
    return { name: p.name, available, cells };
  });

  return results;
}

async function saveShahmatkaErrorSnapshot(page: Page, taskId: string, step: string): Promise<void> {
  try {
    const screenshot = getDebugScreenshotPath(taskId, step);
    await page.screenshot({ path: screenshot, fullPage: true });
    const htmlPath = getErrorHtmlPath(taskId) + `_${step}.html`;
    const tableHtml = await page.locator('#table-block').innerHTML().catch(() => '');
    fs.writeFileSync(htmlPath, tableHtml || (await page.content()), 'utf-8');
    logger.error('Saved shahmatka debug artifacts', { taskId, step, screenshot, htmlPath });
  } catch (err: any) {
    logger.warn('Failed to save shahmatka snapshot', { taskId, step, error: err?.message });
  }
}

/** Click the mail_outline icon on a single property row to toggle it into the cart. */
async function togglePropertyInCart(page: Page, objectName: string, taskId: string): Promise<void> {
  const tableBlock = page.locator('#table-block');
  const safeName = escapeRegExp(objectName);

  const row = tableBlock.locator('tr').filter({
    hasText: new RegExp(safeName, 'i'),
  }).first();

  try {
    await row.waitFor({ state: 'visible', timeout: TIMEOUT });
  } catch {
    throw new Error(`Object "${objectName}" not found in table after ${TIMEOUT}ms`);
  }

  await row.locator('[data-test-name="row-cart-toggle"]').first().click();
  logger.info('Toggled property into cart', { taskId, objectName });
}

/** Open the header Cart button. */
async function openCart(page: Page, taskId: string): Promise<void> {
  await page.locator('[data-test-name="header-cart"]').click();
  logger.info('Opened cart', { taskId });
}

async function getCartModal(page: Page): Promise<Locator> {
  const modal = page.locator('.modal.show, [role="dialog"]').filter({ hasText: /Корзина/i }).last();
  await modal.waitFor({ state: 'visible', timeout: TIMEOUT });
  return modal;
}

async function setCartDate(modal: Locator, index: 0 | 1, value: string): Promise<void> {
  const formattedValue = formatRussianDate(value);
  await modal.getByRole('button', { name: 'date_range' }).nth(index).click();
  await modal.page().getByLabel(formattedValue).first().click();
  logger.info('Picked cart date', { index, value, formattedValue });
}

async function extractBookingUrl(page: Page): Promise<{ linkModal: Locator; bookingUrl: string | null }> {
  const linkModal = page.locator('.modal.show, [role="dialog"]').filter({ hasText: /Ссылка/i }).last();
  await linkModal.waitFor({ state: 'visible', timeout: TIMEOUT });
  logger.info('Link modal opened');

  const candidates = linkModal.locator('input[readonly], input[type="text"], input, textarea');
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const tag = await el.evaluate((node) => node.tagName.toLowerCase());
    const value = tag === 'textarea'
      ? await el.evaluate((node) => (node as any).value)
      : await el.inputValue();
    if (typeof value === 'string' && value.startsWith('http')) {
      logger.info('Booking URL extracted from input', { tag });
      return { linkModal, bookingUrl: value };
    }
  }

  const copyButton = linkModal.getByRole('button', { name: /content_copy\s*Скопировать|Скопировать/i }).first();
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
    return { linkModal, bookingUrl: await hrefLink.getAttribute('href') };
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

    browser = await chromium.launch({ headless: config.playwright.headless });

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
    await saveDebugSnapshot(page, taskId, 'after_auth');

    logger.info('Waiting for object table to load', { taskId });
    await page.locator('#table-block').waitFor({ state: 'visible', timeout: TIMEOUT });
    await saveDebugSnapshot(page, taskId, 'table_ready');

    // --- Availability discovery ---
    const nights = enumerateNights(request.checkInDate, request.checkOutDate);
    if (nights.length === 0) {
      throw new Error('Checkout date must be after check-in date');
    }
    logger.info('Enumerated nights for availability scan', {
      taskId,
      nights: nights.map(formatDDMMYYYY),
    });

    await navigateShahmatkaToDate(page, nights[0], taskId);
    await saveDebugSnapshot(page, taskId, 'shahmatka_navigated');

    let availability: PropertyAvailability[];
    try {
      availability = await scanAvailability(page, nights, taskId);
    } catch (err) {
      await saveShahmatkaErrorSnapshot(page, taskId, 'availability_scan_failed');
      throw err;
    }

    const free = availability.filter((a) => a.available);
    logger.info('Availability scan completed', {
      taskId,
      totalProperties: availability.length,
      freeCount: free.length,
      freeNames: free.map((a) => a.name),
    });

    // --- Decide target properties ---
    const requestedName = (request.objectId ?? '').trim();
    let targetNames: string[];

    if (requestedName) {
      const match = free.find((a) =>
        a.name.toLowerCase().includes(requestedName.toLowerCase())
      );
      if (!match) {
        await saveShahmatkaErrorSnapshot(page, taskId, 'requested_not_free');
        throw new Error(
          `Объект "${requestedName}" недоступен на указанные даты. ` +
          `Свободные варианты: ${free.map((a) => a.name).join(', ') || 'нет'}`
        );
      }
      targetNames = [match.name];
    } else if (free.length === 0) {
      await saveShahmatkaErrorSnapshot(page, taskId, 'no_free_properties');
      throw new Error('Нет свободных квартир на указанные даты.');
    } else {
      targetNames = free.map((a) => a.name);
      logger.info('Free properties selected', { taskId, targetNames });
    }

    // --- Add all target properties to cart ---
    for (const name of targetNames) {
      await togglePropertyInCart(page, name, taskId);
    }
    await saveDebugSnapshot(page, taskId, 'properties_toggled');

    await openCart(page, taskId);
    await saveDebugSnapshot(page, taskId, 'cart_opened');

    const cartModal = await getCartModal(page);
    await saveDebugSnapshot(page, taskId, 'cart_modal_visible');

    logger.info('Setting cart dates', {
      taskId,
      checkInDate: request.checkInDate,
      checkOutDate: request.checkOutDate,
    });
    await setCartDate(cartModal, 0, request.checkInDate);
    await setCartDate(cartModal, 1, request.checkOutDate);
    await saveDebugSnapshot(page, taskId, 'dates_set');

    await cartModal.getByRole('button', { name: /Получить ссылку/i }).click();
    logger.info('Clicked get link button in cart modal', { taskId });
    await saveDebugSnapshot(page, taskId, 'link_requested');

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
      request: { ...request, objectId: targetNames.join(', ') },
      availableProperties: targetNames,
      startedAt,
      completedAt: new Date(),
    };

    logger.info('Booking scenario completed successfully', { taskId, bookingUrl, targetNames });
    return result;
  } catch (error: any) {
    logger.error('Booking scenario failed', { taskId, error: error.message, stack: error.stack });

    let errorScreenshot: string | undefined;
    try {
      if (browser) {
        const contexts = browser.contexts();
        if (contexts.length > 0) {
          const pages = contexts[0].pages();
          if (pages.length > 0) {
            errorScreenshot = getErrorScreenshotPath(taskId);
            await pages[0].screenshot({ path: errorScreenshot, fullPage: true });
            const errorHtmlPath = getErrorHtmlPath(taskId);
            fs.writeFileSync(errorHtmlPath, await pages[0].content(), 'utf-8');
            logger.error('Saved error artifacts', {
              taskId, errorScreenshot, errorHtmlPath, url: pages[0].url(),
            });
          }
        }
      }
    } catch {
      // Ignore
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
