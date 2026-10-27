// A simulated OCPP 1.6-J charge point with one connector.
// It keeps just enough state to behave like real hardware: connector status,
// configuration keys, an energy register, one transaction and an offline queue.
import WebSocket from "ws";
import { OcppConnection, OcppError } from "./ocpp.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// Messages that must reach the CSMS even if the charger was offline when they happened.
const QUEUED_ACTIONS = new Set(["StartTransaction", "StopTransaction", "MeterValues"]);

export class ChargePoint {
  constructor({ url, id, vendor = "LearningOCPP", model = "SimCharger-1", powerKw = 7.4, timeoutMs }) {
    this.url = url.replace(/\/$/, "");
    this.id = id;
    this.vendor = vendor;
    this.model = model;
    this.powerKw = powerKw;
    this.timeoutMs = timeoutMs;
    this.status = "Available";
    this.meterWh = 0;
    this.transaction = null; // { id, idTag, startWh }
    this.offlineQueue = [];
    this.nextLocalTxId = -1; // Placeholder ids for transactions started while offline.
    this.config = {
      HeartbeatInterval: "300",
      MeterValueSampleInterval: "60",
      MeterValuesSampledData: "Energy.Active.Import.Register,Power.Active.Import",
      AuthorizeRemoteTxRequests: "false",
      LocalPreAuthorize: "false",
      NumberOfConnectors: "1",
    };
    this.chargingLimitW = null;
    this.timers = [];
  }

  get online() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    // OCPP-J: the charge point id is the last path segment, and the subprotocol must be ocpp1.6.
    this.ws = new WebSocket(`${this.url}/${encodeURIComponent(this.id)}`, ["ocpp1.6"]);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    if (this.ws.protocol !== "ocpp1.6") console.warn(`CSMS did not accept the ocpp1.6 subprotocol (got "${this.ws.protocol}")`);
    this.conn = new OcppConnection(this.ws, { name: this.id, timeoutMs: this.timeoutMs });
    this.#registerHandlers();
    this.ws.on("close", () => this.#stopTimers());
  }

  disconnect() {
    this.#stopTimers();
    this.ws?.close();
  }

  // Send a CALL, or queue it if offline and the message must not be lost.
  async send(action, payload, localTxId) {
    if (!this.online) {
      if (QUEUED_ACTIONS.has(action)) {
        console.log(`${this.id}: offline, queued ${action}`);
        this.offlineQueue.push({ action, payload, localTxId });
        return null;
      }
      throw new Error(`Offline: cannot send ${action}`);
    }
    return this.conn.call(action, payload);
  }

  async boot() {
    const res = await this.send("BootNotification", {
      chargePointVendor: this.vendor,
      chargePointModel: this.model,
      firmwareVersion: "1.0.0",
    });
    if (res.status !== "Accepted") {
      // Pending or Rejected: the CSMS tells us when to try again.
      throw new Error(`Boot ${res.status}; retry after ${res.interval} s`);
    }
    if (res.interval > 0) this.config.HeartbeatInterval = String(res.interval);
    this.#startHeartbeat();
    await this.setStatus(this.status);
    return res;
  }

  async heartbeat() {
    return this.send("Heartbeat", {});
  }

  async setStatus(status, errorCode = "NoError") {
    this.status = status;
    if (!this.online) return;
    await this.send("StatusNotification", { connectorId: 1, status, errorCode, timestamp: now() });
  }

  async authorize(idTag) {
    const res = await this.send("Authorize", { idTag });
    return res.idTagInfo.status;
  }

  async startTransaction(idTag) {
    if (this.transaction) throw new Error("A transaction is already running");
    await this.setStatus("Preparing");
    const payload = { connectorId: 1, idTag, meterStart: Math.round(this.meterWh), timestamp: now() };
    const localTxId = this.nextLocalTxId--;
    const res = await this.send("StartTransaction", payload, localTxId);
    if (res && res.idTagInfo.status !== "Accepted") {
      // The CSMS can refuse at start; the session still exists on the CSMS side, so stop it cleanly.
      console.log(`${this.id}: StartTransaction idTag ${res.idTagInfo.status}, stopping`);
      this.transaction = { id: res.transactionId, idTag, startWh: this.meterWh };
      return this.stopTransaction("DeAuthorized");
    }
    this.transaction = { id: res ? res.transactionId : localTxId, idTag, startWh: this.meterWh };
    await this.setStatus("Charging");
    this.#startMeterValues();
    return this.transaction.id;
  }

  async stopTransaction(reason = "Local") {
    if (!this.transaction) throw new Error("No transaction to stop");
    this.#stopTimer("meter");
    await this.setStatus("Finishing");
    const tx = this.transaction;
    this.transaction = null;
    await this.send("StopTransaction", {
      transactionId: tx.id,
      idTag: tx.idTag,
      meterStop: Math.round(this.meterWh),
      timestamp: now(),
      reason,
    });
    await this.setStatus("Available");
    return Math.round(this.meterWh - tx.startWh);
  }

  // Advance the energy register as if `seconds` of charging had passed, then report it.
  async sendMeterValues(seconds = Number(this.config.MeterValueSampleInterval)) {
    const watts = Math.min(this.powerKw * 1000, this.chargingLimitW ?? Infinity);
    this.meterWh += (watts * seconds) / 3600;
    return this.send("MeterValues", {
      connectorId: 1,
      transactionId: this.transaction?.id,
      meterValue: [
        {
          timestamp: now(),
          sampledValue: [
            { value: this.meterWh.toFixed(0), measurand: "Energy.Active.Import.Register", unit: "Wh", context: "Sample.Periodic" },
            { value: watts.toFixed(0), measurand: "Power.Active.Import", unit: "W", context: "Sample.Periodic" },
          ],
        },
      ],
    });
  }

  // After a reconnect, send queued messages in order. A transaction that started offline has a
  // negative placeholder id until the CSMS assigns the real one in the StartTransaction reply.
  async flushQueue() {
    const idMap = new Map();
    while (this.offlineQueue.length) {
      const { action, payload, localTxId } = this.offlineQueue.shift();
      if (payload.transactionId != null && idMap.has(payload.transactionId)) payload.transactionId = idMap.get(payload.transactionId);
      const res = await this.conn.call(action, payload);
      if (action === "StartTransaction") {
        idMap.set(localTxId, res.transactionId);
        if (this.transaction?.id === localTxId) this.transaction.id = res.transactionId;
      }
    }
  }

  #registerHandlers() {
    this.conn
      .on("RemoteStartTransaction", ({ idTag }) => {
        if (this.transaction || this.status === "Unavailable") return { status: "Rejected" };
        // Reply first, then act: the CSMS expects a quick answer.
        setTimeout(async () => {
          if (this.config.AuthorizeRemoteTxRequests === "true" && (await this.authorize(idTag)) !== "Accepted") return;
          await this.startTransaction(idTag);
        }, 500);
        return { status: "Accepted" };
      })
      .on("RemoteStopTransaction", ({ transactionId }) => {
        if (!this.transaction || this.transaction.id !== transactionId) return { status: "Rejected" };
        setTimeout(() => this.stopTransaction("Remote"), 500);
        return { status: "Accepted" };
      })
      .on("Reset", ({ type }) => {
        setTimeout(async () => {
          if (this.transaction) await this.stopTransaction(type === "Hard" ? "HardReset" : "SoftReset");
          this.disconnect();
          await sleep(2000);
          await this.connect();
          await this.boot();
        }, 500);
        return { status: "Accepted" };
      })
      .on("GetConfiguration", ({ key } = {}) => {
        const keys = key?.length ? key : Object.keys(this.config);
        return {
          configurationKey: keys.filter((k) => k in this.config).map((k) => ({ key: k, readonly: k === "NumberOfConnectors", value: this.config[k] })),
          unknownKey: keys.filter((k) => !(k in this.config)),
        };
      })
      .on("ChangeConfiguration", ({ key, value }) => {
        if (!(key in this.config)) return { status: "NotSupported" };
        if (key === "NumberOfConnectors") return { status: "Rejected" };
        this.config[key] = String(value);
        if (key === "HeartbeatInterval") this.#startHeartbeat();
        if (key === "MeterValueSampleInterval" && this.transaction) this.#startMeterValues();
        return { status: "Accepted" };
      })
      .on("ChangeAvailability", ({ type }) => {
        if (this.transaction) return { status: "Scheduled" };
        this.setStatus(type === "Inoperative" ? "Unavailable" : "Available");
        return { status: "Accepted" };
      })
      .on("UnlockConnector", () => ({ status: this.transaction ? "UnlockFailed" : "Unlocked" }))
      .on("TriggerMessage", ({ requestedMessage }) => {
        const actions = {
          BootNotification: () => this.boot(),
          Heartbeat: () => this.heartbeat(),
          StatusNotification: () => this.setStatus(this.status),
          MeterValues: () => this.sendMeterValues(0),
        };
        if (!actions[requestedMessage]) return { status: "NotImplemented" };
        setTimeout(actions[requestedMessage], 200); // The trigger reply goes before the triggered message.
        return { status: "Accepted" };
      })
      .on("SetChargingProfile", ({ csChargingProfiles: p }) => {
        const period = p?.chargingSchedule?.chargingSchedulePeriod?.[0];
        if (!period) throw new OcppError("FormationViolation", "chargingSchedulePeriod is required");
        // This simulator applies only the first period of the profile, converting amps at 230 V.
        const unit = p.chargingSchedule.chargingRateUnit;
        this.chargingLimitW = unit === "A" ? period.limit * 230 * (period.numberPhases ?? 1) : period.limit;
        console.log(`${this.id}: charging limit now ${this.chargingLimitW} W (profile ${p.chargingProfileId}, ${p.chargingProfilePurpose})`);
        return { status: "Accepted" };
      })
      .on("ClearChargingProfile", () => {
        this.chargingLimitW = null;
        return { status: "Accepted" };
      });
  }

  #startHeartbeat() {
    this.#stopTimer("heartbeat");
    this.#addTimer("heartbeat", () => this.heartbeat().catch(() => {}), Number(this.config.HeartbeatInterval) * 1000);
  }

  #startMeterValues() {
    this.#stopTimer("meter");
    const seconds = Number(this.config.MeterValueSampleInterval);
    if (seconds > 0) this.#addTimer("meter", () => this.sendMeterValues(seconds).catch(() => {}), seconds * 1000);
  }

  #addTimer(name, fn, ms) {
    this.timers.push({ name, handle: setInterval(fn, ms) });
  }

  #stopTimer(name) {
    for (const t of this.timers.filter((t) => t.name === name)) clearInterval(t.handle);
    this.timers = this.timers.filter((t) => t.name !== name);
  }

  #stopTimers() {
    for (const t of this.timers) clearInterval(t.handle);
    this.timers = [];
  }
}
