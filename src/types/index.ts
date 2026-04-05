export interface BookingRequest {
  objectId: string;
  checkInDate: string;   // DD.MM.YYYY
  checkOutDate: string;  // DD.MM.YYYY
  guests: number;
  discount: number;      // percent
  comment?: string;
  clientName?: string;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  bookingUrl?: string;
  screenshotPath?: string;
  errorMessage?: string;
  request: BookingRequest;
  startedAt: Date;
  completedAt: Date;
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error';

export interface TaskInfo {
  taskId: string;
  status: TaskStatus;
  request: BookingRequest;
  createdAt: Date;
  result?: TaskResult;
}
