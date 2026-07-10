/** Socket-layer pure helpers: reconnect backoff + session persistence keys. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  connect,
  disconnect,
  loadSessionToken,
  sessionKey,
  TERMINAL_CLOSE,
} from '../src/socket';
import { useStore } from '../src/store';

describe('backoffDelay', () => {
  it('doubles from 250ms and caps at 5s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });
});

describe('session token persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keys are per room code, case-normalized', () => {
    expect(sessionKey('abcde')).toBe('hp:session:ABCDE');
    expect(sessionKey('ABCDE')).toBe(sessionKey('abcde'));
  });

  it('loads what was stored for the room', () => {
    localStorage.setItem(sessionKey('QWXYZ'), 'token-1');
    expect(loadSessionToken('qwxyz')).toBe('token-1');
    expect(loadSessionToken('OTHER')).toBeNull();
  });
});

// A tiny WebSocket stand-in: records instances and lets the test drive the
// open/close lifecycle the socket layer reacts to.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  fireClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

describe('reconnect vs terminal close', () => {
  const realWs = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    // biome-ignore lint/suspicious/noExplicitAny: swapping the global for a test double
    globalThis.WebSocket = MockWebSocket as any;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    disconnect(); // resets the module singletons (desired/ws/fatal) between tests
    globalThis.WebSocket = realWs;
  });

  it('maps every server dead-end code, leaves network blips alone', () => {
    expect(TERMINAL_CLOSE[4001]).toBe('error.sessionReplaced');
    expect(TERMINAL_CLOSE[4004]).toBe('error.roomNotFound');
    expect(TERMINAL_CLOSE[4000]).toBe('error.roomClosed');
    expect(TERMINAL_CLOSE[1006]).toBeUndefined(); // abnormal network close still retries
  });

  it('stops reconnecting and surfaces the reason on a terminal close (4001)', () => {
    connect('ABCDE');
    const sock = MockWebSocket.instances.at(-1);
    if (!sock) throw new Error('no socket opened');
    sock.fireOpen();
    sock.fireClose(4001); // "session replaced" — another tab took the seat

    expect(useStore.getState().server.fatal).toBe('error.sessionReplaced');
    const opened = MockWebSocket.instances.length;
    vi.advanceTimersByTime(10_000);
    expect(MockWebSocket.instances.length).toBe(opened); // never retried
  });

  it('reconnects after a non-terminal close (1006) and clears no dead-end', () => {
    connect('ABCDE');
    const sock = MockWebSocket.instances.at(-1);
    if (!sock) throw new Error('no socket opened');
    sock.fireOpen();
    const opened = MockWebSocket.instances.length;
    sock.fireClose(1006);

    expect(useStore.getState().server.fatal).toBeNull();
    vi.advanceTimersByTime(backoffDelay(1));
    expect(MockWebSocket.instances.length).toBe(opened + 1); // reconnected
  });
});
