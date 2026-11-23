/** Browsers cannot cancel a pending getUserMedia request. Keep it serialized until it settles. */
export class CameraStartup {
  private static pending: AbortController | undefined;
  private controller: AbortController | undefined;

  async run(start: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (CameraStartup.pending) return false;
    const controller = new AbortController();
    CameraStartup.pending = controller;
    this.controller = controller;
    try {
      await start(controller.signal);
      return true;
    } finally {
      this.controller = undefined;
      CameraStartup.pending = undefined;
    }
  }

  cancel(): void {
    this.controller?.abort();
  }
}

/** Check immediately after acquiring a resource, before handing ownership to the camera dialog. */
export function keepCameraResource<T>(resource: T, signal: AbortSignal, dispose: (resource: T) => void): boolean {
  if (!signal.aborted) return true;
  dispose(resource);
  return false;
}
