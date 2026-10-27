import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargePoint } from "../lib/chargepoint.js";
import { Csms } from "../lib/csms.js";
import { scenarios } from "../lib/scenarios.js";

let port = 9300;

async function run(name) {
  const csms = new Csms({ port: ++port });
  await csms.start();
  const cp = new ChargePoint({ url: `ws://localhost:${port}/ocpp`, id: "CP-TEST" });
  try {
    await cp.connect();
    await scenarios[name]({ cp, csms });
    return { csms, cp };
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

test("charge: one transaction with the delivered energy", async () => {
  const { csms } = await run("charge");
  const [tx] = csms.transactions.values();
  assert.equal(csms.transactions.size, 1);
  assert.equal(tx.reason, "EVDisconnected");
  assert.ok(tx.energyWh > 0);
});

test("offline: queued messages arrive after reconnect", async () => {
  const { csms, cp } = await run("offline");
  assert.equal(cp.offlineQueue.length, 0);
  assert.ok([...csms.transactions.values()][0].stoppedAt);
});

test("offline-start: the CSMS transactionId replaces the placeholder", async () => {
  const { csms } = await run("offline-start");
  const [[id, tx]] = csms.transactions.entries();
  assert.ok(id > 0);
  assert.equal(tx.meterValues, 1);
  assert.ok(tx.stoppedAt);
});

test("remote: RemoteStart and RemoteStop produce one finished transaction", async () => {
  const { csms } = await run("remote");
  assert.equal([...csms.transactions.values()][0].reason, "Remote");
});

test("a repeated StartTransaction returns the same transactionId", async () => {
  const csms = new Csms({ port: ++port });
  await csms.start();
  const cp = new ChargePoint({ url: `ws://localhost:${port}/ocpp`, id: "CP-TEST" });
  await cp.connect();
  const payload = { connectorId: 1, idTag: "TAG-GOOD", meterStart: 0, timestamp: new Date().toISOString() };
  const a = await cp.conn.call("StartTransaction", payload);
  const b = await cp.conn.call("StartTransaction", payload);
  cp.disconnect();
  await csms.stop();
  assert.equal(a.transactionId, b.transactionId);
});
