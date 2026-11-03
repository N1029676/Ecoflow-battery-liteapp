// The user's saved batteries. Identity is the serial number: every EcoFlow unit advertises the same
// Bluetooth name ("ECOFLOW_BLE"), and the browser's device id can change if permission is re-granted.
// A battery is only saved after it has connected and authenticated, so every entry is known-valid.

const KEY = 'batteries';
const validSerial = (s) => typeof s === 'string' && /^[A-Z0-9]{10,20}$/.test(s);

export const displayName = (b) => b.nickname?.trim() || `Battery ${b.serial.slice(-4)}`;

export class Batteries {
  /** @param {{get:(k:string,d?:string)=>string,set:(k:string,v:string)=>void,remove?:(k:string)=>void}} store */
  constructor(store) {
    this.store = store;
    this.list = []; // [{ serial, deviceId, nickname }]
    this.last = null; // serial of the most recently connected battery
    this.load();
  }

  load() {
    let obj = null;
    try { obj = JSON.parse(this.store.get(KEY, 'null')); } catch { /* corrupt: start empty */ }
    if (obj?.v === 1 && Array.isArray(obj.list)) {
      this.list = obj.list.filter((b) => validSerial(b?.serial)).map((b) => ({ serial: b.serial, deviceId: b.deviceId ?? null, nickname: String(b.nickname ?? '') }));
      this.last = this.get(obj.last) ? obj.last : this.list[0]?.serial ?? null;
      return;
    }
    // migrate the single remembered device saved by the previous version
    let old = null;
    try { old = JSON.parse(this.store.get('device', 'null')); } catch { /* ignore */ }
    if (validSerial(old?.serial)) {
      this.list = [{ serial: old.serial, deviceId: old.id ?? null, nickname: '' }];
      this.last = old.serial;
      this.save();
      this.store.remove?.('device');
    }
  }

  save() { this.store.set(KEY, JSON.stringify({ v: 1, list: this.list, last: this.last })); }

  get(serial) { return this.list.find((b) => b.serial === serial) ?? null; }

  /** Add a battery, or refresh the browser device id of a known one. Marks it as last used. */
  upsert({ serial, deviceId }) {
    if (!validSerial(serial)) throw new Error(`invalid serial "${serial}"`);
    let b = this.get(serial);
    if (b) b.deviceId = deviceId ?? b.deviceId;
    else { b = { serial, deviceId: deviceId ?? null, nickname: '' }; this.list.push(b); }
    this.last = serial;
    this.save();
    return b;
  }

  rename(serial, nickname) {
    const b = this.get(serial);
    if (!b) return;
    b.nickname = String(nickname).trim().slice(0, 40);
    this.save();
  }

  /** Forget the browser device id (e.g. permission was revoked); the battery stays in the list. */
  clearDeviceId(serial) {
    const b = this.get(serial);
    if (b) { b.deviceId = null; this.save(); }
  }

  remove(serial) {
    const b = this.get(serial);
    this.list = this.list.filter((x) => x.serial !== serial);
    if (this.last === serial) this.last = this.list[0]?.serial ?? null;
    this.save();
    return b;
  }
}

/**
 * What to tell the user after a successful connection, or '' if nothing needs saying.
 * @param {Batteries} bats  the list (already updated with the battery that connected)
 * @param {string|null} requested  serial of the battery the user tapped, or null when they pressed Add
 * @param {string} serial  serial of the battery that actually connected
 * @param {boolean} wasKnown  whether that battery was already saved before this connection
 */
export function connectNotice(bats, requested, serial, wasKnown) {
  if (requested === serial) return '';
  const name = displayName(bats.get(serial));
  if (requested == null) return wasKnown ? `That battery is already saved as ${name}.` : `Added ${name}. You can rename it under Advanced.`;
  const wanted = bats.get(requested);
  const was = wanted ? displayName(wanted) : 'the one you tapped';
  return wasKnown ? `That device is ${name}, not ${was}. Connected to ${name}.` : `That was a different battery, not ${was}. Added it as ${name}.`;
}
