/**
 * Transport — the one real networking decision (netcode §7).
 *
 * The original hand-rolled reliable/unreliable UDP layer is mapped onto a web
 * transport behind this interface. M2.0 ships it on a single **WebSocket**: both
 * `sendReliable` and `sendUnreliable` write the same TCP socket. The split is
 * kept as a seam so the *unreliable* channel can later move to WebTransport
 * datagrams without touching `session.ts` — the design tolerates TCP because
 * nothing depends on ordering for correctness (position packets need only
 * freshness, and stale outbound positions are dropped upstream).
 *
 * The transport is a **dumb string pipe**: it knows nothing about message shape.
 * Encoding/decoding (protocol.ts) lives in `session.ts`, keeping the channel
 * seam independent of the wire format.
 */
export interface Transport {
  /** Ordered, guaranteed delivery — hello/welcome/enter/leave/death/kill. */
  sendReliable(data: string): void;
  /** Best-effort, freshness-over-completeness — position packets. */
  sendUnreliable(data: string): void;

  onMessage(cb: (data: string) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;

  close(): void;
}

/** WebSocket implementation for the browser client. Reliable and unreliable both
 *  ride the one socket for M2.0 (see the module header). Sends before the socket
 *  is OPEN are silently dropped — position packets are fire-and-forget, and the
 *  reliable handshake (`hello`) is only sent from the `onOpen` callback. */
export class WebSocketTransport implements Transport {
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
  }

  private send(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  sendReliable(data: string): void {
    this.send(data);
  }

  sendUnreliable(data: string): void {
    this.send(data);
  }

  onMessage(cb: (data: string) => void): void {
    this.ws.addEventListener("message", (e) => cb(String(e.data)));
  }

  onOpen(cb: () => void): void {
    this.ws.addEventListener("open", () => cb());
  }

  onClose(cb: () => void): void {
    this.ws.addEventListener("close", () => cb());
  }

  close(): void {
    this.ws.close();
  }
}
