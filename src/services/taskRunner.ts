import { v4 as uuidv4 } from 'uuid';
import { BookingRequest, TaskInfo, TaskResult } from '../types';
import { runBookingScenario } from '../automation/scenario';
import { runDemoScenario } from '../demo/demo-scenario';
import { saveTask } from './storage';
import { logger } from './logger';

export async function createAndRunTask(
  request: BookingRequest,
  onStatusUpdate: (taskId: string, status: string, result?: TaskResult) => void
): Promise<void> {
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
  }
}

export async function createAndRunDemoTask(
  request: BookingRequest,
  onStatusUpdate: (taskId: string, status: string, result?: TaskResult) => void
): Promise<void> {
  const taskId = 'demo-' + uuidv4().slice(0, 6);

  logger.info('Demo task created', { taskId, request });
  onStatusUpdate(taskId, 'pending');

  onStatusUpdate(taskId, 'running');

  try {
    const result = await runDemoScenario(taskId, request);
    onStatusUpdate(taskId, result.success ? 'completed' : 'error', result);
  } catch (error: any) {
    logger.error('Demo task failed', { taskId, error: error.message });
    const result: TaskResult = {
      taskId,
      success: false,
      errorMessage: error.message,
      request,
      startedAt: new Date(),
      completedAt: new Date(),
    };
    onStatusUpdate(taskId, 'error', result);
  }
}
