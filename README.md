# EcoFlow BLE lite app (spike)

A static web page that talks to an EcoFlow **Delta Pro** directly over Bluetooth LE using Web
Bluetooth (Chrome/Edge, desktop + Android). No server, no cloud. Protocol credit: see `NOTICE`.

**Status: spike.** It connects, does the encrypted handshake, authenticates, and dumps decrypted
packets. Telemetry decoding (state of charge, watts, ...) comes next, once real captures confirm
the packet layouts. Untested against real hardware so far; the crypto and framing are verified
against reference vectors (`npm test`), and the handshake state machine against a simulated device.

## Run

1. Quit/disconnect the EcoFlow phone app (the battery accepts one BLE connection).
2. Open `index.html` in Chrome or Edge (double-click; no server needed). It is a single
   self-contained file: all JS is inlined.
3. Enter your numeric EcoFlow **user ID** (get it once with `python3 -I tools/get-user-id.py EMAIL`)
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
| `js/app.js`, `tools/template.html` | spike UI source |
| `index.html` | generated single-file bundle (`npm run build`) |
| `tests/`, `tools/gen-vectors.py` | Node tests; reference vectors from python-ecdsa/pycryptodome |
