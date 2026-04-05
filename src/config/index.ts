import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: requireEnv('ALLOWED_USER_IDS')
      .split(',')
      .map((id) => parseInt(id.trim(), 10)),
  },
  realtyCalendar: {
    login: requireEnv('RC_LOGIN'),
    password: requireEnv('RC_PASSWORD'),
    baseUrl: process.env.RC_BASE_URL || 'https://realtycalendar.ru',
  },
  playwright: {
    headless: process.env.HEADLESS !== 'false',
  },
  storage: {
    screenshotsDir: path.resolve(process.env.SCREENSHOTS_DIR || './storage/screenshots'),
    logsDir: path.resolve(process.env.LOGS_DIR || './storage/logs'),
    authStateFile: path.resolve('./storage/auth-state.json'),
  },
};
