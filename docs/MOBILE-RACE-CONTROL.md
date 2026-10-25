# Mobile race control and driver Chaos buttons

The mobile race director and personal Chaos button are optional. Both require a
server-only director credential. No new account provider or internet service is
involved.

## Enable on the race PC

In the installed RaceHubOS folder, generate a random credential:

```sh
printf '\nRACE_CONTROL_SECRET=%s\n' "$(openssl rand -hex 32)" >> packages/backend/.env
chmod 600 packages/backend/.env
```

If `RACE_CONTROL_SECRET` already exists, replace it instead of appending another
entry. `packages/backend/.env` is gitignored. Restart RaceHubOS after changing
the key. The value must contain at least 32 UTF-8 bytes.

Open `http://localhost:3001/display/control` on the race PC or
`http://<race-pc-LAN-IP>:3001/display/control` on a phone. Enter the
`RACE_CONTROL_SECRET` there, **not in a URL**. The browser holds it only in
memory for the current page; re-enter it after refresh.

Select a session to pause, resume, or stop. To give a participant a Chaos
button, choose their name under *Personal chaos links*. The resulting URL
has the form:

```text
http://<race-pc-LAN-IP>:3001/display/driver/<driver-id>#chaos=<signed-driver-access>
```

The fragment after `#` is not sent in HTTP requests. The driver display uses
it to authorize a separate POST request. Without this fragment the driver
display stays read-only. If you copy a link containing `localhost` to a
second device, open the director page from the race PC's LAN address first.

## Behavior and access boundaries

- A driver link is signed, bound to one session driver and controller
  assignment, and expires after six hours. Reassigning a driver invalidates
  the previous link. Anyone with the intact link can request Chaos for that
  driver: treat it as a credential.
- Chaos pauses **the entire race** once, not an individual car. A repeat
  request while paused is harmless. Only the director controls resume/stop.
- A failed or disconnected CU does not produce a successful pause response.
  No audio/visual confirmation substitutes for observing the physical track.
  This is **not** a safety-rated emergency stop.
- Remote mutating legacy `/api/*` requests always require the director
  credential (and are rejected until the feature is configured). The race PC can still use its local browser
  controls. Spectator/driver GET routes remain public. Remote legacy admin
  sessions without the credential will receive HTTP 403.
- Legacy Socket.IO commands from remote devices are disabled. LAN displays
  continue to receive live data and do not gain control permissions.

## Security limits

Use only on a trusted LAN or behind **real HTTPS and authenticated proxy
controls**. A plain HTTP LAN can expose the director credential and driver
tokens to network eavesdroppers. Do not expose the API to the internet.

The old local browser controls remain trusted by loopback address and
local-origin checks; local processes and reverse proxies that relay requests
through loopback need their own security boundary. This is not an account
system. To revoke all issued links, rotate `RACE_CONTROL_SECRET` and restart.

## Developer verification

```sh
npm test -w @racehubos/backend -- raceControl
npm run build -w @racehubos/frontend
npm test -w @racehubos/frontend -- mobileChaos.spec.js
```

Also test two phones with distinct driver assignments, rapid repeated Chaos
taps, CU disconnect, subsequent resume by the director, and expiry/reassignment
on a real CU or simulator before merging the draft PR.
