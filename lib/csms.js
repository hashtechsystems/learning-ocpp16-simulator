// A minimal in-memory CSMS (Central System) for OCPP 1.6-J, for learning only.
// It accepts any charge point, knows a few test idTags, and records transactions.
import { WebSocketServer } from "ws";
import { OcppConnection } from "./ocpp.js";

const TAGS = { "TAG-GOOD": "Accepted", "TAG-BLOCKED": "Blocked", "TAG-EXPIRED": "Expired" };

export class Csms {
  constructor({ port = 9000, heartbeatInterval = 300 } = {}) {
    this.port = port;
    this.heartbeatInterval = heartbeatInterval;
    this.chargePoints = new Map(); // id -> { conn, status, bootedAt }
    this.transactions = new Map(); // transactionId -> { chargePointId, idTag, meterStart, meterStop, ... }
    this.nextTransactionId = 1;
  }

  start() {
    this.wss = new WebSocketServer({
      port: this.port,
      // OCPP-J requires the server to pick the ocpp1.6 subprotocol; refuse clients that don't offer it.
      handleProtocols: (protocols) => (protocols.has("ocpp1.6") ? "ocpp1.6" : false),
    });
    this.wss.on("connection", (ws, req) => this.#accept(ws, req));
    return new Promise((resolve) => this.wss.once("listening", resolve));
  }

  stop() {
    for (const ws of this.wss.clients) ws.terminate();
    return new Promise((resolve) => this.wss.close(resolve));
  }

  // Send a command to a connected charge point, e.g. call("CP-1", "RemoteStartTransaction", { idTag: "TAG-GOOD" }).
  call(chargePointId, action, payload) {
    const cp = this.chargePoints.get(chargePointId);
    if (!cp) throw new Error(`${chargePointId} is not connected`);
    return cp.conn.call(action, payload);
  }

  #accept(ws, req) {
    const id = decodeURIComponent(req.url.split("/").filter(Boolean).pop() ?? "");
    console.log(`CSMS: ${id} connected`);
    const conn = new OcppConnection(ws, { name: `CSMS↔${id}` });
    const cp = { conn, status: "Unknown", bootedAt: null };
    this.chargePoints.set(id, cp);
    ws.on("close", () => {
      if (this.chargePoints.get(id) === cp) this.chargePoints.delete(id);
      console.log(`CSMS: ${id} disconnected`);
    });

    const idTagInfo = (idTag) => ({ status: TAGS[idTag] ?? "Invalid" });

    conn
      .on("BootNotification", () => {
        cp.bootedAt = new Date().toISOString();
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: this.heartbeatInterval };
      })
      .on("Heartbeat", () => ({ currentTime: new Date().toISOString() }))
      .on("StatusNotification", ({ status }) => {
        cp.status = status;
        return {};
      })
      .on("Authorize", ({ idTag }) => ({ idTagInfo: idTagInfo(idTag) }))
      .on("StartTransaction", ({ connectorId, idTag, meterStart, timestamp }) => {
        // Idempotency: a charger that lost our reply will resend the same StartTransaction.
        // Return the transaction we already created instead of opening a second one.
        const existing = [...this.transactions.entries()].find(
          ([, t]) => t.chargePointId === id && t.connectorId === connectorId && t.startedAt === timestamp && t.meterStart === meterStart,
        );
        if (existing) return { transactionId: existing[0], idTagInfo: idTagInfo(idTag) };
        const transactionId = this.nextTransactionId++;
        this.transactions.set(transactionId, { chargePointId: id, connectorId, idTag, meterStart, startedAt: timestamp, meterValues: 0 });
        return { transactionId, idTagInfo: idTagInfo(idTag) };
      })
      .on("MeterValues", ({ transactionId }) => {
        const tx = this.transactions.get(transactionId);
        if (tx) tx.meterValues++;
        return {};
      })
      .on("StopTransaction", ({ transactionId, meterStop, timestamp, reason, idTag }) => {
        const tx = this.transactions.get(transactionId);
        // Always answer: refusing a StopTransaction makes the charger retry forever.
        if (!tx) {
          console.warn(`CSMS: StopTransaction for unknown transaction ${transactionId}`);
          return {};
        }
        Object.assign(tx, { meterStop, stoppedAt: timestamp, reason: reason ?? "Local", energyWh: meterStop - tx.meterStart });
        console.log(`CSMS: transaction ${transactionId} finished, ${tx.energyWh} Wh, reason ${tx.reason}`);
        return idTag ? { idTagInfo: idTagInfo(idTag) } : {};
      });
  }
}
