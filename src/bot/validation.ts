/**
 * Validates date in DD.MM.YYYY format and checks it's in the future.
 */
export function validateDate(input: string): { valid: boolean; error?: string } {
  const match = input.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) {
    return { valid: false, error: 'Неверный формат даты. Используйте ДД.ММ.ГГГГ (например, 12.07.2026)' };
  }

  const [, day, month, year] = match;
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));

  if (
    date.getDate() !== parseInt(day) ||
    date.getMonth() !== parseInt(month) - 1 ||
    date.getFullYear() !== parseInt(year)
  ) {
    return { valid: false, error: 'Указана несуществующая дата' };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (date < today) {
    return { valid: false, error: 'Дата не может быть в прошлом' };
  }

  return { valid: true };
}

/**
 * Validates that check-out is after check-in.
 */
export function validateDateRange(checkIn: string, checkOut: string): { valid: boolean; error?: string } {
  const [dIn, mIn, yIn] = checkIn.split('.').map(Number);
  const [dOut, mOut, yOut] = checkOut.split('.').map(Number);
  const dateIn = new Date(yIn, mIn - 1, dIn);
  const dateOut = new Date(yOut, mOut - 1, dOut);

  if (dateOut <= dateIn) {
    return { valid: false, error: 'Дата выезда должна быть позже даты заезда' };
  }
  return { valid: true };
}

/**
 * Validates guests count.
 */
export function validateGuests(input: string): { valid: boolean; value?: number; error?: string } {
  const num = parseInt(input, 10);
  if (isNaN(num) || num < 1 || num > 50) {
    return { valid: false, error: 'Количество гостей должно быть от 1 до 50' };
  }
  return { valid: true, value: num };
}

/**
 * Validates discount percentage.
 */
export function validateDiscount(input: string): { valid: boolean; value?: number; error?: string } {
  const num = parseInt(input, 10);
  if (isNaN(num) || num < 1 || num > 99) {
    return { valid: false, error: 'Скидка должна быть от 1 до 99 процентов' };
  }
  return { valid: true, value: num };
}
