#!/usr/bin/env node
// Usage: node csms.js [--port 9000]
// Runs the learning CSMS on its own so you can point the simulator, or a real charger, at it.
import { parseArgs } from "node:util";
import { Csms } from "./lib/csms.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "9000" } } });
const csms = new Csms({ port: Number(values.port) });
await csms.start();
console.log(`CSMS listening on ws://localhost:${values.port}/ocpp/<chargePointId>`);
console.log("Test idTags: TAG-GOOD (Accepted), TAG-BLOCKED, TAG-EXPIRED; anything else is Invalid.");
