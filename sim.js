#!/usr/bin/env node
// Usage: node sim.js <scenario> [--url ws://host:port/path] [--id CP-1]
// Without --url the simulator starts its own CSMS on port 9000 and plays both sides.
import { parseArgs } from "node:util";
import { ChargePoint } from "./lib/chargepoint.js";
import { Csms } from "./lib/csms.js";
import { scenarios } from "./lib/scenarios.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: "string" }, id: { type: "string", default: "CP-1" }, port: { type: "string", default: "9000" } },
});
const name = positionals[0];
if (!scenarios[name]) {
  console.log(`Scenarios: ${Object.keys(scenarios).join(", ")}\nUsage: node sim.js <scenario> [--url ws://localhost:9000/ocpp] [--id CP-1]`);
  process.exit(name ? 1 : 0);
}

let csms;
if (!values.url) {
  csms = new Csms({ port: Number(values.port) });
  await csms.start();
  console.log(`Built-in CSMS listening on ws://localhost:${values.port}/ocpp`);
}
const cp = new ChargePoint({ url: values.url ?? `ws://localhost:${values.port}/ocpp`, id: values.id });
try {
  await cp.connect();
  await scenarios[name]({ cp, csms });
  console.log("\nDone.");
} catch (err) {
  console.error(`\nScenario failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  cp.disconnect();
  await csms?.stop();
}
