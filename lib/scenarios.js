// Each scenario walks through one part of OCPP 1.6-J. `csms` is set when the simulator runs
// against its built-in CSMS, so scenarios can also play the Central System's side.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (text) => console.log(`\n── ${text}`);

export const scenarios = {
  async boot({ cp }) {
    step("Connect and send BootNotification; the reply sets the heartbeat interval");
    await cp.boot();
    step("Heartbeat: the CSMS replies with its current time, which chargers use to set their clock");
    await cp.heartbeat();
  },

  async charge({ cp }) {
    await cp.boot();
    step("Authorize the driver's idTag before starting");
    const status = await cp.authorize("TAG-GOOD");
    if (status !== "Accepted") throw new Error(`Tag ${status}`);
    step("StartTransaction: the CSMS assigns the transactionId");
    await cp.startTransaction("TAG-GOOD");
    step("MeterValues during charging (each one simulates a minute)");
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      await cp.sendMeterValues(60);
    }
    step("StopTransaction with the final meter reading");
    const wh = await cp.stopTransaction("EVDisconnected");
    console.log(`\nDelivered ${wh} Wh`);
  },

  async rejected({ cp }) {
    await cp.boot();
    step("Authorize a blocked tag: the charger must not start");
    console.log(`Authorize returned ${await cp.authorize("TAG-BLOCKED")}`);
    step("Authorize an unknown tag");
    console.log(`Authorize returned ${await cp.authorize("TAG-UNKNOWN")}`);
  },

  async offline({ cp }) {
    await cp.boot();
    await cp.startTransaction("TAG-GOOD");
    await cp.sendMeterValues(60);
    step("The connection drops mid-session; the charger keeps charging and queues transaction messages");
    cp.disconnect();
    await sleep(300);
    await cp.sendMeterValues(60);
    await cp.sendMeterValues(60);
    await cp.stopTransaction("Local");
    console.log(`${cp.offlineQueue.length} messages queued`);
    step("Reconnect, boot again, then deliver the queue in order");
    await cp.connect();
    await cp.boot();
    await cp.flushQueue();
  },

  async "offline-start"({ cp }) {
    await cp.boot();
    step("Offline before the session starts: the charger uses a local placeholder transactionId");
    cp.disconnect();
    await sleep(300);
    await cp.startTransaction("TAG-GOOD");
    await cp.sendMeterValues(60);
    await cp.stopTransaction("Local");
    step("Reconnect and replay: the CSMS's transactionId replaces the placeholder in later messages");
    await cp.connect();
    await cp.boot();
    await cp.flushQueue();
  },

  async remote({ cp, csms }) {
    await cp.boot();
    if (!csms) return listen(cp);
    step("CSMS sends RemoteStartTransaction; the charger accepts, then starts on its own");
    await csms.call(cp.id, "RemoteStartTransaction", { connectorId: 1, idTag: "TAG-GOOD" });
    await sleep(1500);
    await cp.sendMeterValues(60);
    step("CSMS sends RemoteStopTransaction for that transactionId");
    await csms.call(cp.id, "RemoteStopTransaction", { transactionId: cp.transaction.id });
    await sleep(1500);
  },

  async config({ cp, csms }) {
    await cp.boot();
    if (!csms) return listen(cp);
    step("CSMS reads configuration keys");
    await csms.call(cp.id, "GetConfiguration", { key: ["HeartbeatInterval", "MeterValueSampleInterval", "NoSuchKey"] });
    step("CSMS changes the heartbeat interval; a read-only key is rejected");
    await csms.call(cp.id, "ChangeConfiguration", { key: "HeartbeatInterval", value: "60" });
    await csms.call(cp.id, "ChangeConfiguration", { key: "NumberOfConnectors", value: "2" });
    step("CSMS asks for a StatusNotification with TriggerMessage");
    await csms.call(cp.id, "TriggerMessage", { requestedMessage: "StatusNotification", connectorId: 1 });
    await sleep(500);
  },

  async smart({ cp, csms }) {
    await cp.boot();
    await cp.startTransaction("TAG-GOOD");
    await cp.sendMeterValues(60);
    if (!csms) return listen(cp);
    step("CSMS limits this session to 16 A on one phase (about 3.7 kW) with a TxProfile");
    await csms.call(cp.id, "SetChargingProfile", {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        transactionId: cp.transaction.id,
        stackLevel: 0,
        chargingProfilePurpose: "TxProfile",
        chargingProfileKind: "Relative",
        chargingSchedule: { chargingRateUnit: "A", chargingSchedulePeriod: [{ startPeriod: 0, limit: 16, numberPhases: 1 }] },
      },
    });
    step("MeterValues now show the lower power");
    await cp.sendMeterValues(60);
    await cp.stopTransaction("Local");
  },
};

// Against an external CSMS, stay connected and answer whatever it sends.
async function listen(cp) {
  step("Connected and waiting for commands from your CSMS (Ctrl+C to quit)");
  await new Promise(() => {});
}
