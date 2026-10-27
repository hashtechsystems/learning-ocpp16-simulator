# Learning OCPP 1.6-J: simulator

A small, readable OCPP 1.6-J charge point simulator with a built-in CSMS. It is the companion code for the book *Learning OCPP 1.6-J* by HashTech Systems, but it works on its own too.

It is written to be read: about 500 lines of plain JavaScript, one file per idea, and every OCPP frame is printed as it goes over the wire, so you can see the protocol rather than guess at it.

It is a teaching tool, not a test suite for certifying chargers. For production testing, use the OCA's test tools or a commercial simulator.

## Quick start

Needs Node.js 22 or later.

```sh
npm install
node sim.js charge
```

With no `--url`, the simulator starts its own CSMS on port 9000 and plays both sides, so you see both halves of every exchange:

```
10:15:02 CP-1 → [2,"8c1e…","Authorize",{"idTag":"TAG-GOOD"}]
10:15:02 CSMS↔CP-1 ← [2,"8c1e…","Authorize",{"idTag":"TAG-GOOD"}]
10:15:02 CSMS↔CP-1 → [3,"8c1e…",{"idTagInfo":{"status":"Accepted"}}]
10:15:02 CP-1 ← [3,"8c1e…",{"idTagInfo":{"status":"Accepted"}}]
```

`[2, …]` is a CALL, `[3, …]` a CALLRESULT and `[4, …]` a CALLERROR.

## Scenarios

| Scenario | What it shows |
|---|---|
| `boot` | BootNotification, the heartbeat interval the CSMS sets, Heartbeat |
| `charge` | Authorize, StartTransaction, MeterValues, StopTransaction |
| `rejected` | Blocked and unknown idTags |
| `offline` | The connection drops mid-session; transaction messages are queued and replayed in order |
| `offline-start` | A session that starts while offline, with a placeholder transactionId that is swapped for the CSMS's one on replay |
| `remote` | RemoteStartTransaction and RemoteStopTransaction from the CSMS |
| `config` | GetConfiguration, ChangeConfiguration (including a read-only key) and TriggerMessage |
| `smart` | SetChargingProfile limiting a session to 16 A, and the lower power showing up in MeterValues |

```sh
node sim.js            # list scenarios
node sim.js offline
```

## Against your own CSMS

```sh
node sim.js boot --url ws://localhost:8180/steve/websocket/CentralSystemService --id CP-1
```

The charge point id is appended to the URL, and the simulator asks for the `ocpp1.6` WebSocket subprotocol. The `remote`, `config` and `smart` scenarios boot and then wait for your CSMS to send commands. The simulator answers RemoteStart/StopTransaction, Reset, GetConfiguration, ChangeConfiguration, ChangeAvailability, UnlockConnector, TriggerMessage, SetChargingProfile and ClearChargingProfile.

## The learning CSMS on its own

```sh
node csms.js --port 9000
```

Point the simulator, or a real charger on your bench, at `ws://<your-ip>:9000/ocpp/<chargePointId>`. Test idTags: `TAG-GOOD` (Accepted), `TAG-BLOCKED`, `TAG-EXPIRED`; anything else is Invalid. It keeps everything in memory and has no security at all, so never expose it to the internet.

## Code tour

- `lib/ocpp.js`: OCPP-J framing, matching replies to calls, timeouts and CALLERRORs.
- `lib/chargepoint.js`: the charge point: connector status, configuration keys, energy register, one transaction and the offline queue.
- `lib/csms.js`: the minimal Central System, including idempotent StartTransaction handling.
- `lib/scenarios.js`: the scenarios above, one function each.

Simplifications, on purpose: one connector, no security profiles, no firmware or diagnostics messages, and only the first period of a charging profile is applied.

```sh
npm test
```

## Licence

MIT. See [LICENSE](LICENSE).
