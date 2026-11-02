# EcoFlow BLE lite app (spike)

A static web page that talks to an EcoFlow **Delta Pro** directly over Bluetooth LE using Web
Bluetooth (Chrome/Edge, desktop + Android). No server, no cloud. Protocol credit: see `NOTICE`.

**Status: spike.** It connects, does the encrypted handshake, authenticates, and dumps decrypted
packets. Telemetry decoding (state of charge, watts, ...) comes next, once real captures confirm
the packet layouts. Untested against real hardware so far; the crypto and framing are verified
against reference vectors (`npm test`), and the handshake state machine against a simulated device.

## Run

1. Quit/disconnect the EcoFlow phone app (the battery accepts one BLE connection).
2. `npm run serve` (or `python3 -m http.server`), open <http://localhost:8000> in Chrome.
   Web Bluetooth needs HTTPS or localhost. On Android, use `chrome://inspect` port forwarding to
   reach your PC's localhost, or host the folder on GitHub Pages.
3. Enter your numeric EcoFlow **user ID** (get it once with `python3 -I tools/get-user-id.py EMAIL`)
   and press **Scan & connect**. The unit must already be bound to your account in the EcoFlow app.
4. Use **Save .txt** to capture the log (contains your device serial number).

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
| `js/app.js`, `index.html` | spike UI |
| `tests/`, `tools/gen-vectors.py` | Node tests; reference vectors from python-ecdsa/pycryptodome |
