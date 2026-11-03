# EcoFlow BLE lite app (spike)

A static web page that talks to an EcoFlow **Delta Pro** directly over Bluetooth LE using Web
Bluetooth (Chrome/Edge, desktop + Android). No server, no cloud. Protocol credit: see `NOTICE`.

**Status:** works on a real Delta Pro. Monitoring is read-only; the optional, collapsed *Controls* section can change a few settings (below).

- **Live dashboard:** state of charge, input/output watts, AC input, per-battery voltage/current/temperature/cycles/health.
  Units for some fields follow community notes and are not all verified.
- **Controls (collapsed by default):** AC output on/off, charge limit (50-100 %), discharge limit (0-30 %), AC charging power
  (200 W up to the unit's rating, 1800 W by default, with the equivalent amps shown) and DC charging current (4-8 A, sent as
  milliamps like the battery reports it). The charge/discharge limits are system-wide (the protocol has one pair, covering AC
  and DC). Changes are two-step where it matters: AC output always asks first (turning it off cuts power to what is plugged in),
  a discharge limit at or above the current charge asks first because the output would stop, and DC current always asks first.
  After sending, the page waits for the battery's own report to show the change and says so, or says plainly that the battery
  did not confirm. Commands come from the community drivers (`js/controls.js`) and are not independently verified.
- **Cell voltages:** tap a battery widget to see every cell voltage (15 per pack on a Delta Pro) with the lowest and highest
  marked, the spread in millivolts, and the cell temperatures.
- **Multiple batteries (one connected at a time):** *Add battery* opens Chrome's chooser; once that battery has connected and
  authenticated it is saved and appears as a named button (default "Battery 0790", the last four digits of its serial;
  rename or remove it under *Advanced*). From then on tap its name to connect, with no chooser, and tapping another battery
  switches to it. Identity is the serial number (all units advertise the same Bluetooth name). This relies on
  `navigator.bluetooth.getDevices()`; browsers without it show the chooser after a reload, but switching between batteries
  already seen during the visit still works. A single battery saved by an earlier version is migrated automatically.
- **Live readout:** the connection bar is two rows (battery buttons + Add + Disconnect, then status). While connected, the
  green dot on the battery button says "connected" and a readout shows `Updated 0.4 s ago` (blinks on every message, turns
  amber if messages stop). When you connect it also shows the Bluetooth signal strength in dBm for 10 seconds and then fades
  it out: Chrome can only read signal strength from advertisements, and a Delta Pro stops advertising once connected, so it
  cannot be kept live.
- **Layout:** a compact connection card (one Connect / Cancel / Disconnect button and a status pill; the user ID and options
  live under *Advanced*, which opens itself on first run), a **?** help panel with the instructions, and two-column
  tiles whose extra details open in a popover when tapped.
- **State-of-charge bars:** one compact widget per pack (main battery, then each extra battery) at the top of the live data
  card; there is no averaged system bar. Each has its name rotated 90 degrees in a rail on its left edge and a 20-segment
  battery bar (whole segments, 5 % steps) beside it. Green; yellow at or below 25 %, red at or below 10 % (with a
  "Low"/"Critical" label as well, so colour is not the only cue). While charging, the last lit segment pulses slowly (disabled
  when the OS asks for reduced motion). Charging/discharging is taken from the pack current (positive = charging). Tap a widget
  for voltage, current, temperature, capacity, cycles, health, cell range and the charge/discharge limits.
- **Connection notices:** after connecting, a short note appears when it matters: a battery was added, "already saved as ..."
  when you press Add and pick one you have, or which battery you actually reached if it was not the one you tapped.
- **History:** readings are recorded on your device while connected (15 s samples for 6 h, 5-minute averages for 14 days) and
  shown as charts (battery %, power in/out, temperature) with 1 h to 14 d ranges, a table view and CSV export. Stored in the
  browser's localStorage; nothing leaves the device.
- **Reliable on a phone:** reconnects automatically if the link drops (exponential backoff), reconnects if data stalls for 20 s,
  and keeps the screen on while connected (Screen Wake Lock; toggleable).
- **Installable:** works as an installable, offline-capable app (PWA) when served over HTTPS (e.g. GitHub Pages): use the
  "Install app" button or the browser menu.
- **Debug toggle:** verbose protocol logging, raw frames and the packet table are hidden unless you tick *debug*.

Tests: `npm test` (protocol vs python reference vectors, decoders vs real captures, history, handshake vs a simulated device),
`npm run test:e2e` (bundled page in headless Chromium against a fake Bluetooth device: connect, dashboard, history, debug
toggle, reconnect, stall watchdog, wake lock) and `npm run test:pwa` (manifest, icons, service worker, offline load).
The e2e scripts need `playwright` (set `PLAYWRIGHT_PATH` if it is installed globally).

## Run

1. Quit/disconnect the EcoFlow phone app (the battery accepts one BLE connection).
2. Open `index.html` in Chrome or Edge (double-click; no server needed). It is a single
   self-contained file: all JS is inlined.
3. Enter your numeric EcoFlow **user ID** (use the in-page "Look up" form, or `python3 -I tools/get-user-id.py EMAIL`)
   and press **Scan & connect**. The unit must already be bound to your account in the EcoFlow app.
4. Use **Save .txt** to capture the log (contains your device serial number).

On Android, Chrome can't easily open a local HTML file as a trusted page; host `index.html`
(e.g. GitHub Pages, which is HTTPS) and open that URL.

## Developing

`index.html` is generated: edit `js/*` and `tools/template.html`, then `npm run build`
(needs `npm install` once for esbuild). `npm test` runs the protocol tests.

## If it can't find GATT services

The primary service UUID isn't documented, so `js/ble.js` declares several candidates. The log
lists what was found. If nothing matches, find the service UUID with nRF Connect and paste it into
*Advanced → Extra service UUIDs*.

## Layout

| path | purpose |
|---|---|
| `js/protocol.js` | crypto glue, frames, packets (pure, tested) |
| `js/secp160r1.js`, `js/md5.js`, `js/crc.js` | pieces WebCrypto lacks |
| `js/session.js` | handshake/auth state machine (transport-agnostic) |
| `js/ble.js` | Web Bluetooth transport |
| `js/app.js`, `tools/template.html` | UI source (connection supervisor, dashboard, history wiring) |
| `js/history.js`, `js/chart.js` | history store (two-tier, persisted) and canvas line chart |
| `js/batteries.js` | saved batteries (serial-keyed, persisted, migrated) |
| `js/controls.js` | write commands (AC output, limits), validation, confirmation logic |
| `js/socbar.js` | 20-segment state-of-charge bar (pure helpers + DOM component) |
| `manifest.webmanifest`, `sw.js`, `icon.svg`, `icon-*.png` | PWA files (`tools/make-icons.mjs` renders the PNGs) |
| `index.html` | generated single-file bundle (`npm run build`) |
| `tests/`, `tools/gen-vectors.py` | Node tests; reference vectors from python-ecdsa/pycryptodome |
