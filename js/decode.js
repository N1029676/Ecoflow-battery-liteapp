// Decoders for the Delta Pro "heartbeat" packets (fixed-width little-endian structs).
// Field names/order from rabits/ha-ef-ble (Apache-2.0), see NOTICE; checked against real captures
// in tests/. Units are the raw wire units (mV, mA, 0.1 W, ...) unless noted.

const SIZE = { B: 1, b: 1, H: 2, h: 2, I: 4, i: 4, f: 4 };

function layout(spec) {
  return spec.trim().split(/\s+/).map((s) => {
    const [fmt, name] = s.split(':');
    const n = /^(\d+)s$/.test(fmt) ? parseInt(fmt, 10) : SIZE[fmt];
    if (!n) throw new Error(`bad format ${fmt}`);
    return { fmt, name, n };
  });
}
const size = (l) => l.reduce((a, f) => a + f.n, 0);

/** Unpack as many fields as the data holds (firmware may send shorter/longer structs). */
export function unpack(l, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let o = 0;
  for (const { fmt, name, n } of l) {
    if (o + n > bytes.length) break;
    if (fmt.endsWith('s')) out[name] = bytes.slice(o, o + n);
    else out[name] = { B: () => dv.getUint8(o), b: () => dv.getInt8(o), H: () => dv.getUint16(o, true), h: () => dv.getInt16(o, true),
      I: () => dv.getUint32(o, true), i: () => dv.getInt32(o, true), f: () => dv.getFloat32(o, true) }[fmt]();
    o += n;
  }
  return out;
}

export const PD = layout(`B:model 4s:errCode 4s:sysVer 4s:wifiVer B:wifiAutoRcvy B:soc H:wattsOutSum H:wattsInSum i:remainTime
  B:beepMode B:dcOutState B:usb1Watts B:usb2Watts B:qcUsb1Watts B:qcUsb2Watts B:typec1Watts B:typec2Watts B:typec1Temp B:typec2Temp
  B:carState B:carWatts B:carTemp H:standbyMin H:lcdOffSec B:lcdBrightness I:chgPowerDC I:chgSunPower I:chgPowerAC I:dsgPowerDC I:dsgPowerAC
  I:usbUsedTime I:usbqcUsedTime I:typecUsedTime I:carUsedTime I:invUsedTime I:dcInUsedTime I:mpptUsedTime 2s:reserved
  B:extRj45Port B:ext3p8Port B:ext4p8Port B:sysChgDsgState B:wifiRssi B:wirelessWatts 14s:screenState
  B:acAutoConfig B:minAcOutSoc B:acOutPause B:watthIsConfig B:backupSoc B:hysteresisAdd I:relaySwitchCount`);

export const EMS = layout(`B:chgState B:chgCmd B:dsgCmd I:chgVol I:chgAmp B:fanLevel B:maxChargeSoc B:bmsModel B:lcdShowSoc B:openUpsFlag
  B:bmsWarningState I:chgRemainTime I:dsgRemainTime B:emsIsNormalFlag f:f32LcdShowSoc 3s:bmsIsConnt B:maxAvailableNum B:openBmsIdx
  I:paraVolMin I:paraVolMax B:minDsgSoc B:openOilEbSoc B:closeOilEbSoc`);

export const BMS = layout(`B:num B:type B:cellId I:errCode I:sysVer B:soc I:vol I:amp B:temp B:openBmsIdx I:designCap I:remainCap I:fullCap
  I:cycles B:soh H:maxCellVol H:minCellVol B:maxCellTemp B:minCellTemp B:maxMosTemp B:minMosTemp B:bmsFault B:bqSysStatReg I:tagChgAmp
  f:f32ShowSoc I:inputWatts I:outputWatts I:remainTime`);

// Same layout as upstream's DirectInvDeltaHeartbeatPack (67 bytes). This battery sends 72 bytes; the
// extra 5 trailing bytes are unknown. (Verified on a real capture: acInVol 117.5 V x acInAmp 7.65 A = 899 W.)
export const INV = layout(`I:errCode I:sysVer B:chargerType H:inputWatts H:outputWatts B:invType I:invOutVol I:invOutAmp B:invOutFreq
  I:acInVol I:acInAmp B:acInFreq H:outTemp I:dcInVol I:dcInAmp H:dcInTemp B:fanState B:cfgAcEnabled B:cfgAcXboost I:cfgAcOutVoltage
  B:cfgAcOutFreq B:cfgAcWorkMode B:cfgPauseFlag B:acDipSwitch H:cfgFastChgWatts H:cfgSlowChgWatts H:standbyMins B:dischargeType
  B:acPassbyAutoEn B:prBalanceMode H:acChgRatedPower B:cfgGfciEnable 5s:unknownTail`);

export const MPPT = layout(`I:faultCode I:swVer I:inVol I:inAmp H:inWatts I:outVol I:outAmp H:outWatts H:mpptTemp B:xt60ChgType B:cfgChgType
  B:chgType B:chgState I:dcdc12vVol I:dcdc12vAmp H:dcdc12vWatts I:carOutVol I:carOutAmp H:carOutWatts H:carTemp B:carState H:dc24vTemp
  B:dc24vState B:chgPauseFlag I:cfgDcChgCurrent B:beepMode B:cfgAcEnable B:cfgAcXboost I:cfgAcOutVol B:cfgAcOutFreq H:cfgChgWatt
  H:acStandbyMins B:dischargeType H:carStandbyMin H:powerStandbyMin H:screenStandbyMin`);

export const LAYOUT_SIZES = { PD: size(PD), EMS: size(EMS), BMS: size(BMS), INV: size(INV), MPPT: size(MPPT) };

/** Classify and decode a decoded inner packet. Returns {kind, data} or null. */
export function decodeTelemetry(pkt) {
  if (pkt.cmdSet === 0x20 && pkt.cmdId === 0x02) {
    if (pkt.src === 0x02) return { kind: 'pd', data: unpack(PD, pkt.payload) };
    if (pkt.src === 0x03) return { kind: 'ems', data: unpack(EMS, pkt.payload) };
    if (pkt.src === 0x04) return { kind: 'inv', data: unpack(INV, pkt.payload) };
    if (pkt.src === 0x05 || pkt.src === 0x07) return { kind: 'mppt', data: unpack(MPPT, pkt.payload) };
  }
  if (pkt.cmdSet === 0x20 && pkt.cmdId === 0x32) return { kind: 'bms', data: unpack(BMS, pkt.payload) };
  return null;
}

/** Friendly summary from the latest decoded messages. Pass {pd, ems, inv, mppt, bms:{[num]:..}}. */
export function summarize(s) {
  const out = {};
  if (s.ems) {
    out.soc = round(s.ems.f32LcdShowSoc, 1);
    out.chargeLimitMax = s.ems.maxChargeSoc; out.dischargeLimitMin = s.ems.minDsgSoc;
    out.chargeMinutes = s.ems.chgRemainTime; out.dischargeMinutes = s.ems.dsgRemainTime;
  }
  if (s.pd) {
    out.inW = s.pd.wattsInSum; out.outW = s.pd.wattsOutSum;
    out.usbA = (s.pd.usb1Watts ?? 0) + (s.pd.usb2Watts ?? 0) + (s.pd.qcUsb1Watts ?? 0) + (s.pd.qcUsb2Watts ?? 0);
    out.usbC = (s.pd.typec1Watts ?? 0) + (s.pd.typec2Watts ?? 0);
  }
  if (s.inv) {
    out.acInW = s.inv.inputWatts; out.acOutW = s.inv.outputWatts;
    out.acInV = round(s.inv.acInVol / 1000, 1); out.acInA = round(s.inv.acInAmp / 1000, 2);
    out.acOutEnabled = s.inv.cfgAcEnabled === 1;
  }
  if (s.mppt) {
    out.solarW = round(s.mppt.inWatts / 10, 1); out.solarV = round(s.mppt.inVol / 10, 1); out.solarA = round(s.mppt.inAmp / 100, 2);
    out.carW = round(s.mppt.carOutWatts / 10, 1); out.car12vOn = s.mppt.carState === 1;
  }
  out.batteries = Object.values(s.bms ?? {}).sort((a, b) => a.num - b.num).map((b) => ({
    num: b.num, soc: round(b.f32ShowSoc ?? b.soc, 1), volts: round(b.vol / 1000, 2), amps: round(toSigned32(b.amp) / 1000, 2),
    tempC: b.temp, cycles: b.cycles, sohPct: b.soh, designAh: round(b.designCap / 1000, 1), remainAh: round(b.remainCap / 1000, 1),
    cellMaxMv: b.maxCellVol, cellMinMv: b.minCellVol,
  }));
  return out;
}

const round = (v, d) => (v == null || Number.isNaN(v) ? v : Math.round(v * 10 ** d) / 10 ** d);
const toSigned32 = (v) => (v | 0);
