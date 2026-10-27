// OCPP-J 1.6 framing: every WebSocket text frame is a JSON array.
//   CALL       [2, uniqueId, action, payload]
//   CALLRESULT [3, uniqueId, payload]
//   CALLERROR  [4, uniqueId, errorCode, errorDescription, errorDetails]
import { randomUUID } from "node:crypto";

export const CALL = 2;
export const CALLRESULT = 3;
export const CALLERROR = 4;

const colour = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

export function logFrame(direction, who, frame) {
  const arrow = direction === "out" ? colour(36, "→") : colour(33, "←");
  console.log(`${new Date().toISOString().slice(11, 19)} ${who} ${arrow} ${JSON.stringify(frame)}`);
}

// Wraps a WebSocket with call/response matching, timeouts and handlers for incoming CALLs.
export class OcppConnection {
  constructor(ws, { name, timeoutMs = 30_000 } = {}) {
    this.ws = ws;
    this.name = name;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.handlers = new Map();
    ws.on("message", (data) => this.#receive(data.toString()));
    ws.on("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("Connection closed"));
      }
      this.pending.clear();
    });
  }

  // Register a handler for a CALL from the other side. Return the response payload,
  // or throw an OcppError to send a CALLERROR.
  on(action, handler) {
    this.handlers.set(action, handler);
    return this;
  }

  call(action, payload = {}) {
    const id = randomUUID();
    const frame = [CALL, id, action, payload];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${action} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, action });
      this.#send(frame);
    });
  }

  #send(frame) {
    logFrame("out", this.name, frame);
    this.ws.send(JSON.stringify(frame));
  }

  async #receive(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      console.error(`${this.name}: ignoring a frame that is not JSON: ${text}`);
      return;
    }
    logFrame("in", this.name, frame);
    const [type, id] = frame;

    if (type === CALLRESULT || type === CALLERROR) {
      const call = this.pending.get(id);
      if (!call) return; // A late reply to a call that already timed out.
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (type === CALLRESULT) call.resolve(frame[2]);
      else call.reject(new OcppError(frame[2], frame[3], frame[4]));
      return;
    }

    if (type !== CALL) return;
    const [, , action, payload] = frame;
    const handler = this.handlers.get(action);
    if (!handler) {
      this.#send([CALLERROR, id, "NotImplemented", `${action} is not supported`, {}]);
      return;
    }
    try {
      this.#send([CALLRESULT, id, (await handler(payload)) ?? {}]);
    } catch (err) {
      const e = err instanceof OcppError ? err : new OcppError("InternalError", err.message);
      this.#send([CALLERROR, id, e.code, e.message, e.details ?? {}]);
    }
  }
}

export class OcppError extends Error {
  constructor(code, description = "", details = {}) {
    super(description || code);
    this.code = code;
    this.details = details;
  }
}
