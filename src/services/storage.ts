import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { TaskInfo, TaskResult } from '../types';
import { logger } from './logger';

// Ensure directories exist
fs.mkdirSync(config.storage.screenshotsDir, { recursive: true });
fs.mkdirSync(config.storage.logsDir, { recursive: true });

const tasksFile = path.join(config.storage.logsDir, 'tasks.json');

function readTasks(): TaskInfo[] {
  try {
    if (fs.existsSync(tasksFile)) {
      return JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    }
  } catch (err) {
    logger.error('Failed to read tasks file', { error: err });
  }
  return [];
}

function writeTasks(tasks: TaskInfo[]): void {
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
}

export function saveTask(task: TaskInfo): void {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.taskId === task.taskId);
  if (idx >= 0) {
    tasks[idx] = task;
  } else {
    tasks.push(task);
  }
  writeTasks(tasks);
}

export function getTask(taskId: string): TaskInfo | undefined {
  return readTasks().find((t) => t.taskId === taskId);
}

export function getScreenshotPath(taskId: string): string {
  return path.join(config.storage.screenshotsDir, `${taskId}.png`);
}

export function getErrorScreenshotPath(taskId: string): string {
  return path.join(config.storage.screenshotsDir, `${taskId}_error.png`);
}

export function getDebugScreenshotPath(taskId: string, step: string): string {
  const safeStep = step.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(config.storage.screenshotsDir, `${taskId}_${safeStep}.png`);
}

export function getErrorHtmlPath(taskId: string): string {
  return path.join(config.storage.logsDir, `${taskId}_error.html`);
}
