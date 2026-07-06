/**
 * SSE client utility that wraps EventSource with automatic reconnection.
 * Connects to /api/v1/notifications/stream (requires Authorization header via
 * URL param because EventSource does not support custom headers).
 */
export type SseEventHandler = (event: MessageEvent) => void;
export type SseErrorHandler = (err: Event) => void;

export interface SseSubscription {
  close(): void;
}

const MAX_RETRY_DELAY_MS = 30_000;

export function createSseClient(
  streamUrl: string,
  onMessage: SseEventHandler,
  onError?: SseErrorHandler,
): SseSubscription {
  let es: EventSource | null = null;
  let retryDelay = 1_000;
  let closed = false;

  function connect(): void {
    if (closed) return;
    es = new EventSource(streamUrl, { withCredentials: false });
    es.onmessage = (event) => {
      retryDelay = 1_000; // reset on success
      onMessage(event);
    };
    es.onerror = (err) => {
      onError?.(err);
      es?.close();
      if (!closed) {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    };
  }

  connect();

  return {
    close(): void {
      closed = true;
      es?.close();
    },
  };
}
