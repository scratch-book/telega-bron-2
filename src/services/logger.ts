import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

// Ensure logs directory exists
fs.mkdirSync(config.storage.logsDir, { recursive: true });

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'telega-bron' },
  transports: [
    new winston.transports.File({
      filename: path.join(config.storage.logsDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(config.storage.logsDir, 'combined.log'),
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, taskId, ...rest }) => {
          const tid = taskId ? ` [${taskId}]` : '';
          const extra = Object.keys(rest).length > 1 ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} ${level}${tid}: ${message}${extra}`;
        })
      ),
    }),
  ],
});
