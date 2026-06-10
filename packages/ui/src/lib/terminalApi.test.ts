import { describe, expect, test } from 'bun:test';
import { TerminalTransportManager } from './terminalApi';

const CONTROL_TAG_JSON = 0x01;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type ControlFrame = {
  t: string;
  s?: string;
  r?: number;
  v?: number;
  [key: string]: unknown;
};

const decodeControlFrame = (raw: unknown): ControlFrame | null => {
  let bytes: Uint8Array | null = null;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  }
  if (!bytes || bytes.length < 2 || bytes[0] !== CONTROL_TAG_JSON) {
    return null;
  }
  return JSON.parse(textDecoder.decode(bytes.subarray(1))) as ControlFrame;
};

const encodeControlFrame = (payload: ControlFrame): Uint8Array => {
  const jsonBytes = textEncoder.encode(JSON.stringify(payload));
  const bytes = new Uint8Array(jsonBytes.length + 1);
  bytes[0] = CONTROL_TAG_JSON;
  bytes.set(jsonBytes, 1);
  return bytes;
};

class FakeWebSocket {
  static readonly CONNECTING = WS_CONNECTING;
  static readonly OPEN = WS_OPEN;
  static readonly CLOSING = WS_CLOSING;
  static readonly CLOSED = WS_CLOSED;

  static instances: FakeWebSocket[] = [];

  readyState = WS_CONNECTING;
  binaryType = 'arraybuffer';
  url: string;
  sent: unknown[] = [];

  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    if (this.readyState !== WS_OPEN) {
      throw new Error('FakeWebSocket: send while not OPEN');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WS_CLOSED) {
      return;
    }
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  triggerControl(payload: ControlFrame): void {
    this.onmessage?.({ data: encodeControlFrame(payload).buffer });
  }

  bindFrames(): ControlFrame[] {
    return this.sent
      .map((raw) => decodeControlFrame(raw))
      .filter((frame): frame is ControlFrame => frame !== null && frame.t === 'b');
  }
}

const withFakeWebSocket = (run: () => void): void => {
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
  try {
    run();
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
};

describe('TerminalTransportManager bind timing', () => {
  test('flushes the bind frame exactly once when the socket opens after subscribe (cold connect)', () => {
    withFakeWebSocket(() => {
      const manager = new TerminalTransportManager();
      manager.configure('ws://test/api/terminal/ws');

      const socket = FakeWebSocket.instances[0];
      expect(socket instanceof FakeWebSocket).toBe(true);
      expect(socket.readyState).toBe(WS_CONNECTING);

      const unsubscribe = manager.subscribe('session-cold', () => {}, () => {});
      expect(socket.bindFrames().length).toBe(0);

      socket.triggerOpen();
      const afterOpen = socket.bindFrames();
      expect(afterOpen.length).toBe(1);
      expect(afterOpen[0].t).toBe('b');
      expect(afterOpen[0].s).toBe('session-cold');
      expect(afterOpen[0].v).toBe(2);

      socket.triggerControl({ t: 'ok', v: 2 });
      expect(socket.bindFrames().length).toBe(1);

      unsubscribe();
    });
  });

  test('rebinds the active subscription session on reconnect (fresh socket)', () => {
    withFakeWebSocket(() => {
      const manager = new TerminalTransportManager();
      manager.configure('ws://test/api/terminal/ws');

      const firstSocket = FakeWebSocket.instances[0];
      const unsubscribe = manager.subscribe('session-live', () => {}, () => {});
      firstSocket.triggerOpen();
      firstSocket.triggerControl({ t: 'bok', s: 'session-live', v: 2 });
      expect(firstSocket.bindFrames().length).toBe(1);

      firstSocket.close();

      manager.prime();
      const secondSocket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      expect(secondSocket === firstSocket).toBe(false);

      secondSocket.triggerOpen();
      const rebind = secondSocket.bindFrames();
      expect(rebind.length).toBe(1);
      expect(rebind[0].s).toBe('session-live');

      unsubscribe();
    });
  });
});
