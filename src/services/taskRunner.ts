import { v4 as uuidv4 } from 'uuid';
import { BookingRequest, TaskInfo, TaskResult } from '../types';
import { runBookingScenario } from '../automation/scenario';
import { saveTask } from './storage';
import { logger } from './logger';

// Simple mutex: only one automation task at a time
let isRunning = false;

export async function createAndRunTask(
  request: BookingRequest,
  onStatusUpdate: (taskId: string, status: string, result?: TaskResult) => void
): Promise<void> {
  if (isRunning) {
    throw new Error('Another task is already running. Please wait for it to finish.');
  }

  const taskId = uuidv4().slice(0, 8);

  const taskInfo: TaskInfo = {
    taskId,
    status: 'pending',
    request,
    createdAt: new Date(),
  };

  saveTask(taskInfo);
  logger.info('Task created', { taskId, request });
  onStatusUpdate(taskId, 'pending');

  // Run the automation
  isRunning = true;
  taskInfo.status = 'running';
  saveTask(taskInfo);
  onStatusUpdate(taskId, 'running');

  try {
    const result = await runBookingScenario(taskId, request);
    taskInfo.status = result.success ? 'completed' : 'error';
    taskInfo.result = result;
    saveTask(taskInfo);
    onStatusUpdate(taskId, taskInfo.status, result);
  } catch (error: any) {
    logger.error('Task runner caught unexpected error', { taskId, error: error.message });
    const result: TaskResult = {
      taskId,
      success: false,
      errorMessage: error.message,
      request,
      startedAt: taskInfo.createdAt,
      completedAt: new Date(),
    };
    taskInfo.status = 'error';
    taskInfo.result = result;
    saveTask(taskInfo);
    onStatusUpdate(taskId, 'error', result);
  } finally {
    isRunning = false;
  }
}
