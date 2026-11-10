export interface LongPressScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface LongPressController {
  start(): void;
  finish(): void;
  cancel(): void;
  dispose(): void;
}

const defaultScheduler: LongPressScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createLongPressController(options: {
  onShortPress: () => void;
  onLongPress: () => void;
  delayMs?: number;
  scheduler?: LongPressScheduler;
}): LongPressController {
  const scheduler = options.scheduler ?? defaultScheduler;
  const delayMs = options.delayMs ?? 450;
  let timer: unknown = null;
  let longPressTriggered = false;
  let cancelled = false;

  function clearTimer() {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  }

  return {
    start() {
      clearTimer();
      longPressTriggered = false;
      cancelled = false;
      timer = scheduler.schedule(() => {
        timer = null;
        if (cancelled) return;
        longPressTriggered = true;
        options.onLongPress();
      }, delayMs);
    },
    finish() {
      const shouldTriggerShortPress = !cancelled && !longPressTriggered;
      clearTimer();
      if (shouldTriggerShortPress) options.onShortPress();
      cancelled = false;
      longPressTriggered = false;
    },
    cancel() {
      cancelled = true;
      clearTimer();
    },
    dispose() {
      clearTimer();
    },
  };
}
