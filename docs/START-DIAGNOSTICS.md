# Start timing diagnostics (#67)

This backend-only diagnostic slice measures the existing start path. It does not fix or claim to explain the reported physical CU delay. Browser click, Socket.IO receipt and audio scheduling timestamps are not yet instrumented.

## Capture

1. Set `RACEHUB_START_TRACE=1` in the backend process environment and restart it. For example, on Linux/macOS: `RACEHUB_START_TRACE=1 npm run dev:backend` from the repository root. Existing installer/service users can set the same variable in their process environment.
2. Capture backend console output. `[StartTrace]` records carry a process-local attempt ID, session ID, phase and monotonic `elapsedMs` since backend start acceptance. The `accepted` row also has a UTC wall-clock `startedAt` for identifying the capture. Wall-clock changes do not change elapsed durations.
3. Start one prepared session normally. A second click during its transition is rejected by the existing guard; it cannot replace that attempt's trace. Advance the lights normally after L1. Do not send extra START commands for the measurement.
4. Disable the variable and restart after capture. Logging is off by default. A trace ends at the first observed lights-to-racing transition, failure, disconnect, device replacement or service close. After 60 seconds, the next trace call emits `expired` and stops logging. It keeps no event buffer or diagnostic timer.

## Interpretation

| Phases | What the interval includes |
| --- | --- |
| `accepted` → `reset:begin` | Backend validation and exclusivity checks; excludes the browser and network request |
| `reset:begin/end` | Initial device reset and optional position clearing |
| `load:begin/end` | Session loading, including existing queued writes |
| `profiles:begin/end` | All assigned car configuration writes; a simulator without decoder programming skips these |
| `profile:request/ack` | One speed, brake or fuel API call; controller is the existing zero-based slot (0–5). Includes queue time, not just BLE transit |
| `wait:before_start:begin/end` | Existing intentional 1000 ms wait after polling is stopped |
| `prepare_start:request/ack` | The preparation START API call and its completion |
| `wait:after_start:begin/end` | Existing intentional 1000 ms wait after START completion |
| `polling:resume`, `poll:begin/end/error` | Poll restart and individual poll calls, including queue/response time |
| `status` | A changed `cu:status.start` value immediately before broadcast; repeated values are omitted |
| `reset:lights` | Existing additional reset triggered upon entering the first light |
| `advance_start:request/ack` | A subsequent light-advance START call, distinct from preparation |
| `session:active` | Existing database transition completed; racing time still begins at observed GO |
| `racing` / `failed` | End of observed start sequence / failed start path. Existing error reporting remains responsible for the error text |

An `ack` means the device method completed. It is not proof that a physical decoder applied a setting. Polling may already be running during reset/profile loading; the trace does not add, drain or reschedule polls. In-flight calls and simulator status broadcasts can overlap other phases. The two waits remain unchanged and do not prove that every pending BLE request has settled.

Only fixed phase names, timing, session/attempt IDs, controller/field and changed start values are logged. No director keys, personal tokens, device addresses, raw BLE buffers or error messages are added to the trace. Existing application logs remain separate. With fast polling, opt-in capture emits roughly two poll records per 100 ms plus status changes, for at most the 60-second observation window; no new client broadcasts, database writes or dependencies are added.

## Hardware evidence still needed

The integrated simulator test exposes an existing distinction: `SyncService.handleStatus()` resets on entering L1, while `CarreraSimulator.reset()` changes its start state to stopped (9). With these services connected, the observed path is 9 → 1 → 9; another START repeats 1 → 9 instead of completing the countdown. The trace explicitly records `reset:lights` and does not invent GO. This slice preserves that behavior for diagnosis; it is not evidence about the physical CU or a passing end-to-end simulator countdown.

Capture the same scenario with the simulator and the real CU: fresh versus warm connection, one versus multiple assigned cars. Keep the session ID, capture start time, vehicle count and connection state with each result. Compare reset, profiles, both planned waits, START completion, first L1 and subsequent status spacing. Record the real lights and sound separately; backend timestamps cannot establish when a browser rendered a light or scheduled a beep. Only optimize a demonstrated bottleneck after this comparison; do not remove the fixed waits based on simulator results alone.
