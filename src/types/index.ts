export interface BookingRequest {
  objectId?: string;     // optional: empty/undefined => auto-discover free property
  checkInDate: string;   // DD.MM.YYYY
  checkOutDate: string;  // DD.MM.YYYY
  guests: number;
  discount: number;      // percent
  comment?: string;
  clientName?: string;
}

export interface PropertyAvailabilityCell {
  date: string;  // DD.MM.YYYY
  text: string;
  free: boolean;
}

export interface PropertyAvailability {
  name: string;
  available: boolean;
  cells: PropertyAvailabilityCell[];
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  bookingUrl?: string;
  screenshotPath?: string;
  errorMessage?: string;
  /** When more than one free property matches the dates, scenario returns the list instead of booking. */
  availableProperties?: string[];
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
