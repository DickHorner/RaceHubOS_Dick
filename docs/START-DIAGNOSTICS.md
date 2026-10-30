# Start timing diagnostics (#67)

The opt-in backend and browser captures measure the existing start path. They do not fix or claim to explain the reported physical CU delay. Start commands, polling and audio behavior are unchanged.

## Capture

1. Set `RACEHUB_START_TRACE=1` in the backend process environment and restart it. For example, on Linux/macOS: `RACEHUB_START_TRACE=1 npm run dev:backend` from the repository root. Existing installer/service users can set the same variable in their process environment.
2. Capture backend console output. `[StartTrace]` records carry a process-local attempt ID, session ID, phase and monotonic `elapsedMs` since backend start acceptance. The `accepted` row also has a UTC wall-clock `startedAt` for identifying the capture. Wall-clock changes do not change elapsed durations.
3. Start one prepared session normally. A second click during its transition is rejected by the existing guard; it cannot replace that attempt's trace. Advance the lights normally after L1. Do not send extra START commands for the measurement.
4. Disable the variable and restart after capture. Logging is off by default. A trace ends at the first observed lights-to-racing transition, failure, disconnect, device replacement or service close. After 60 seconds, the next trace call emits `expired` and stops logging. It keeps no event buffer or diagnostic timer.

## Browser capture

In the tab that will start the session, open developer tools and run:

```js
sessionStorage.setItem('racehubos-start-trace', '1')
```

Keep the console open, filter for `[BrowserStartTrace]`, and start the prepared session from free racing or a championship. Advance at L1 normally. No reload or frontend rebuild is needed. The opt-in is tab-local; other displays do not automatically capture. To disable, run `sessionStorage.removeItem('racehubos-start-trace')` and reload the tab (this also discards an active capture).

Each row contains a page-local trace ID, session ID and monotonic `elapsedMs` from the call to the session start action. The initial `click` row includes UTC `startedAt` for matching captures. The action is measured immediately before fetch, after any caller-side validation. Repeated start calls retain an active capture's origin. A capture ends at observed GO in the light effect, failed start, cancellation, socket/CU disconnect or expiry on the next record after 60 seconds. It adds no timers or event buffer.

| Browser phase | Observation |
| --- | --- |
| `click` | Session start action immediately before HTTP request |
| `http:response` | Fetch returned response headers, with HTTP status; JSON parsing and state update follow |
| `advance:click`, `advance:http:response` | Existing L1 advance action and its HTTP response |
| `status:received` | Changed start value received by DeviceContext's Socket.IO handler, before setting React state; identical repeated values are omitted |
| `light:effect` | StartLights effect processed a start value; this is **not** a measured browser paint or completed CSS transition |
| `audio:scheduled` | Existing oscillator start/stop calls completed, with frequency, duration, AudioContext state and its `currentTime` |
| `audio:failed` | Existing audio try block threw; no exception message is recorded |
| `racing`, `failed`, `disconnected`, `expired` | End of capture |

A suspended AudioContext may queue a beep without audible output. `audio:scheduled` is not speaker playback evidence, and AudioContext time is not the browser performance clock. The trace does not resume audio or suppress existing cues. A rapid sequence can be received in full while React only processes its latest value; compare received values with effects instead of assuming every received value was rendered. On navigation to another page the light component may unmount; the remaining capture is still bounded by disconnect or expiry.

Only fixed diagnostic fields are written to this tab's console. No URL, fragment, driver token, director key, device address, raw status payload or error message is copied; no telemetry is sent to the server or persisted. Default-off cost is a function call and null check at each instrumented boundary. Active status logging is limited to changes, not repeated polls.

Browser and backend trace IDs and elapsed origins are independent. Match the session ID, capture wall-clock and sequence manually; **do not subtract timestamps from different clocks to infer network latency**. Use intervals inside each capture to locate delays. Preserve both logs plus a physical CU light/audio recording for the hardware check.

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
| `reset:lights` | Timing reset triggered upon entering the first light; the simulator keeps its L1 state and tick loop |
| `advance_start:request/ack` | A subsequent light-advance START call, distinct from preparation |
| `session:active` | Existing database transition completed; racing time still begins at observed GO |
| `racing` / `failed` | End of observed start sequence / failed start path. Existing error reporting remains responsible for the error text |

An `ack` means the device method completed. It is not proof that a physical decoder applied a setting. Polling may already be running during reset/profile loading; the trace does not add, drain or reschedule polls. In-flight calls and simulator status broadcasts can overlap other phases. The two waits remain unchanged and do not prove that every pending BLE request has settled.

Only fixed phase names, timing, session/attempt IDs, controller/field and changed start values are logged. No director keys, personal tokens, device addresses, raw BLE buffers or error messages are added to the trace. Existing application logs remain separate. With fast polling, opt-in capture emits roughly two poll records per 100 ms plus status changes, for at most the 60-second observation window; no new client broadcasts, database writes or dependencies are added.

## Hardware evidence still needed

The diagnostic integration exposed a simulator bug: the full reset on entering L1 changed its start state back to stopped (9). The L1 handler now requests a timing-only reset, using the simulator's existing `resetTimer()` and retaining the full reset for explicit reset operations. The integrated simulator sequence is tested through 9 → 1 → 2 → 3 → 4 → 5 → 7 → 0. Devices without `resetTimer()` retain their existing `reset()` call; this does not establish physical CU behavior. The simulator's advance call completes after GO, when the trace has already ended, so its final `advance_start:ack` is outside the capture window.

Capture the same scenario with the simulator and the real CU: fresh versus warm connection, one versus multiple assigned cars. Keep the session ID, capture start time, vehicle count and connection state with each result. Compare reset, profiles, both planned waits, START completion, first L1 and subsequent status spacing. Record the real lights and sound separately; browser effects and audio scheduling cannot establish the visible paint time or when a speaker sounded. Only optimize a demonstrated bottleneck after this comparison; do not remove the fixed waits based on simulator results alone.
