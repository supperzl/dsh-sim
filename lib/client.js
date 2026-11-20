window.__ModuleLoader__.load({ id: "dsh-sim", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

const React = require("react");
const { useCallback, useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

const ROUTE = "/_dsh/dsh-sim";
const LABEL = "\u6a21\u62df\u5668";

/* ------------------------------------------------------------------ icon */

function SimIcon(size, active) {
  return h("svg", {
    width: size, height: size, viewBox: "0 0 16 16", fill: "none",
    "aria-hidden": "true", style: { display: "block", opacity: active === false ? 0.9 : 1 },
  },
    h("rect", { x: 3.4, y: 1.2, width: 9.2, height: 13.6, rx: 2.1, stroke: "currentColor", strokeWidth: 1.3 }),
    h("rect", { x: 4.9, y: 3.1, width: 6.2, height: 8.4, rx: 0.9, fill: "currentColor", opacity: 0.18 }),
    h("circle", { cx: 8, cy: 13.1, r: 0.62, fill: "currentColor" }));
}

/* ----------------------------------------------------------- H.264 player */

function concatArrays(list) {
  let total = 0;
  for (const item of list) total += item.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of list) { out.set(item, offset); offset += item.length; }
  return out;
}

function concatBytes(a, b) {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

function hex2(value) { return value.toString(16).padStart(2, "0"); }
function codecStringFromAvcc(p) { return "avc1." + hex2(p[1]) + hex2(p[2]) + hex2(p[3]); }
function splitNals(payload) {
  const nals = [];
  let start = -1;
  for (let i = 0; i + 3 < payload.length; i += 1) {
    if (payload[i] === 0 && payload[i + 1] === 0 && (payload[i + 2] === 1 || (payload[i + 2] === 0 && payload[i + 3] === 1))) {
      const codeLength = payload[i + 2] === 1 ? 3 : 4;
      if (start >= 0) nals.push(payload.slice(start, i));
      start = i + codeLength;
      i += codeLength - 1;
    }
  }
  if (start >= 0 && start < payload.length) nals.push(payload.slice(start));
  if (nals.length > 0) return nals;
  // AVCC: 4-byte big-endian lengths
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const length = (payload[offset] << 24) | (payload[offset + 1] << 16) | (payload[offset + 2] << 8) | payload[offset + 3];
    if (length <= 0 || offset + 4 + length > payload.length) return [];
    nals.push(payload.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return nals;
}

function hasStartCode(payload) {
  for (let i = 0; i + 3 < payload.length; i += 1) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 0 && payload[i + 3] === 1) return true;
  }
  return false;
}

/** Build an avcC record from MediaCodec's CSD (Annex-B or AVCC NAL units). */
function avcDescriptionOf(payload) {
  const nals = splitNals(payload);
  let sps = null;
  let pps = null;
  for (const nal of nals) {
    if (nal.length === 0) continue;
    const type = nal[0] & 0x1f;
    if (type === 7) sps = nal;
    else if (type === 8) pps = nal;
  }
  if (sps === null) return null;
  const parts = [new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1, (sps.length >> 8) & 0xff, sps.length & 0xff]), sps];
  if (pps !== null) {
    parts.push(new Uint8Array([1, (pps.length >> 8) & 0xff, pps.length & 0xff]));
    parts.push(pps);
  }
  return concatArrays(parts);
}

/** Normalize one media packet to AVCC (length-prefixed NAL units). */
function toAvcc(payload) {
  if (!hasStartCode(payload)) return payload;
  const nals = splitNals(payload);
  const parts = [];
  for (const nal of nals) {
    if (nal.length === 0) continue;
    parts.push(new Uint8Array([(nal.length >>> 24) & 0xff, (nal.length >>> 16) & 0xff, (nal.length >>> 8) & 0xff, nal.length & 0xff]));
    parts.push(nal);
  }
  return concatArrays(parts);
}

function codecStringFromAnnexB(payload) {
  for (let i = 0; i + 4 < payload.length; i += 1) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 0 && payload[i + 3] === 1) {
      const nal = payload[i + 4];
      if ((nal & 0x1f) === 7 && i + 7 < payload.length) {
        return "avc1." + hex2(payload[i + 5]) + hex2(payload[i + 6]) + hex2(payload[i + 7]);
      }
    }
  }
  return "avc1.640033";
}

class H264Player {
  constructor(options) {
    this.canvas = options.canvas;
    this.platform = options.platform;
    this.onStats = options.onStats;
    this.onSize = options.onSize;
    this.buffer = new Uint8Array(0);
    this.decoder = null;
    this.width = 0; this.height = 0;
    this.frames = 0; this.fps = 0; this.fpsAt = performance.now(); this.fpsFrames = 0;
    this.bytes = 0; this.chunks = 0; this.configs = 0; this.errors = 0;
    this.timestamp = 0;
    this.failed = null;
    this.paintedSeed = false;
    this.codecRead = false;
  }

  configure(init) {
    try { if (this.decoder) this.decoder.close(); } catch { /* ignore */ }
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.frames += 1; this.fpsFrames += 1;
        const now = performance.now();
        if (now - this.fpsAt >= 1000) {
          this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsAt));
          this.fpsAt = now; this.fpsFrames = 0;
        }
        this.paint(frame);
        frame.close();
      },
      error: (error) => { this.failed = error; this.errors += 1; this.onStats && this.onStats(this.stats()); },
    });
    try { this.decoder.configure(init); } catch (error) { this.failed = error; }
  }

  paint(frame) {
    const canvas = this.canvas.current;
    if (!canvas) return;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
      this.width = width; this.height = height;
      this.onSize && this.onSize(width, height);
    }
    canvas.getContext("2d").drawImage(frame, 0, 0, width, height);
  }

  stats() {
    return {
      frames: this.frames, fps: this.fps, width: this.width, height: this.height,
      bytes: this.bytes, chunks: this.chunks, configs: this.configs, errors: this.errors || 0,
      failed: this.failed ? String(this.failed.message || this.failed) : null,
    };
  }

  push(bytes) {
    this.bytes += bytes.length;
    this.buffer = concatBytes(this.buffer, bytes);
    if (this.platform === "ios") this.drainIos(); else this.drainAndroid();
  }

  drainIos() {
    while (this.buffer.length >= 5) {
      const length = (this.buffer[0] << 24) | (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];
      if (length < 1) { this.buffer = new Uint8Array(0); return; }
      if (this.buffer.length < 4 + length) return;
      const tag = this.buffer[4];
      const payload = this.buffer.slice(5, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      if (tag === 1) {
        this.configs += 1;
        this.configure({ codec: codecStringFromAvcc(payload), description: payload, optimizeForLatency: true });
      } else if (tag === 2 || tag === 3) {
        if (this.decoder === null) continue;
        this.timestamp = Math.max(this.timestamp + 1, Math.round(performance.now() * 1000));
        try {
          this.chunks += 1;
          this.decoder.decode(new EncodedVideoChunk({ type: tag === 2 ? "key" : "delta", timestamp: this.timestamp, data: payload }));
        } catch (error) { this.failed = error; }
      } else if (tag === 4) {
        const dims = this.jpegSize(payload);
        if (dims && (this.width !== dims.width || this.height !== dims.height)) {
          this.width = dims.width;
          this.height = dims.height;
          this.onSize && this.onSize(dims.width, dims.height);
        }
        this.paintSeed(payload);
      }
    }
  }

  drainAndroid() {
    if (this.buffer.length >= 4 && !this.codecRead) {
      this.codecRead = true;
      this.buffer = this.buffer.slice(4);
    }
    if (!this.codecRead) return;
    while (this.buffer.length >= 12) {
      const first = this.buffer[0];
      if ((first & 0x80) !== 0) {
        this.width = ((this.buffer[4] << 24) | (this.buffer[5] << 16) | (this.buffer[6] << 8) | this.buffer[7]) >>> 0;
        this.height = ((this.buffer[8] << 24) | (this.buffer[9] << 16) | (this.buffer[10] << 8) | this.buffer[11]) >>> 0;
        this.onSize && this.onSize(this.width, this.height);
        this.buffer = this.buffer.slice(12);
        continue;
      }
      const size = (this.buffer[8] << 24) | (this.buffer[9] << 16) | (this.buffer[10] << 8) | this.buffer[11];
      if (size < 0 || this.buffer.length < 12 + size) return;
      const key = (first & 0x20) !== 0;
      const config = (first & 0x40) !== 0;
      const payload = this.buffer.slice(12, 12 + size);
      this.buffer = this.buffer.slice(12 + size);
      if (config) {
        const description = avcDescriptionOf(payload);
        if (description !== null) {
          this.configure({ codec: codecStringFromAvcc(description), description, optimizeForLatency: true });
        } else {
          this.configure({ codec: codecStringFromAnnexB(payload), optimizeForLatency: true });
        }
      } else if (this.decoder !== null) {
        this.timestamp = Math.max(this.timestamp + 1, Math.round(performance.now() * 1000));
        try {
          this.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: this.timestamp, data: toAvcc(payload) }));
        } catch (error) { this.failed = error; }
      }
    }
  }

  jpegSize(payload) {
    let i = 2
    while (i + 9 < payload.length) {
      if (payload[i] !== 0xff) { i += 1; continue }
      const marker = payload[i + 1]
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        const height = (payload[i + 5] << 8) | payload[i + 6]
        const width = (payload[i + 7] << 8) | payload[i + 8]
        if (width > 0 && height > 0) return { width, height }
      }
      const length = (payload[i + 2] << 8) | payload[i + 3]
      i += 2 + (length > 0 ? length : 2)
    }
    return undefined
  }

  paintSeed(payload) {
    if (this.frames > 0 || this.paintedSeed) return;
    this.paintedSeed = true;
    createImageBitmap(new Blob([payload], { type: "image/jpeg" })).then((bitmap) => {
      const canvas = this.canvas.current;
      if (!canvas || this.frames > 0) { bitmap.close(); return; }
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      this.width = bitmap.width; this.height = bitmap.height;
      this.onSize && this.onSize(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
    }).catch(() => {});
  }

  dispose() { try { if (this.decoder) this.decoder.close(); } catch { /* ignore */ } this.decoder = null; }
}

/* --------------------------------------------------------- stream session */


/**
 * Physical iPhone player: HEVC NALUs (4-byte length prefixed) decoded by
 * WebCodecs with the hvcC description from the host's /codec route.
 */
class HevcPlayer {
  constructor(options) {
    this.canvas = options.canvas;
    this.onStats = options.onStats;
    this.onSize = options.onSize;
    this.decoder = null;
    this.configured = false;
    this.pending = [];
    this.buffer = new Uint8Array(0);
    this.frames = 0;
    this.bytes = 0;
    this.failed = 0;
    this.width = 0;
    this.height = 0;
    this.timestamp = 0;
  }

  configure(info) {
    const encoded = typeof info.description === "string" ? info.description : "";
    let description;
    if (encoded !== "") {
      const binary = atob(encoded);
      description = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) description[i] = binary.charCodeAt(i);
    }
    if (typeof VideoDecoder === "undefined") {
      this.failed += 1;
      return;
    }
    this.decoder = new VideoDecoder({
      output: (frame) => this.paint(frame),
      error: () => { this.failed += 1; },
    });
    this.decoder.configure({
      codec: info.codec,
      ...(description === undefined ? {} : { description }),
      optimizeForLatency: true,
    });
    this.configured = true;
    if (typeof info.display === "object" && info.display !== null && info.display.width > 0) {
      this.width = info.display.width;
      this.height = info.display.height;
      this.onSize && this.onSize(this.width, this.height);
    }
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.push(chunk);
  }

  push(bytes) {
    this.bytes += bytes.length;
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;
    while (this.buffer.length >= 4) {
      const length = ((this.buffer[0] << 24) | (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3]) >>> 0;
      if (length < 0 || length > 16 * 1024 * 1024) { this.failed += 1; this.buffer = new Uint8Array(0); return; }
      if (this.buffer.length < 4 + length) break;
      const nal = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      this.decodeNal(nal);
    }
  }

  decodeNal(nal) {
    if (nal.length < 2) return;
    const type = (nal[0] >> 1) & 0x3f;
    if (type === 32 || type === 33 || type === 34) return;
    const isKey = type >= 16 && type <= 21;
    if (!this.configured) { this.pending.push(nal); return; }
    if (this.decoder === null) return;
    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: this.timestamp += 1,
        data: nal,
      }));
    } catch {
      this.failed += 1;
    }
  }

  paint(frame) {
    this.frames += 1;
    this.width = frame.displayWidth;
    this.height = frame.displayHeight;
    const canvas = this.canvas && this.canvas.current;
    if (canvas) {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      const context = canvas.getContext("2d");
      try { context.drawImage(frame, 0, 0); } catch { /* ignore */ }
    }
    frame.close();
    this.onSize && this.onSize(this.width, this.height);
    this.onStats && this.onStats(this.stats());
  }

  stats() {
    return { frames: this.frames, bytes: this.bytes, failed: this.failed, width: this.width, height: this.height };
  }

  dispose() {
    try { this.decoder && this.decoder.close(); } catch { /* ignore */ }
    this.decoder = null;
  }
}

class StreamSession {
  constructor(options) {
    this.sessionId = options.sessionId;
    this.streamId = options.streamId;
    this.platform = options.platform;
    this.physical = options.physical === true;
    this.canvas = options.canvas;
    this.onStats = options.onStats;
    this.onSize = options.onSize;
    this.onState = options.onState;
    this.onEnd = options.onEnd;
    this.player = null;
    this.abort = null;
    this.closed = false;
  }

  open() {
    this.closed = false;
    this.close();
    this.closed = false;
    const canvas = this.canvas.current;
    if (canvas) { canvas.width = 1; canvas.height = 1; canvas.getContext("2d").clearRect(0, 0, 1, 1); }
    this.player = this.physical
      ? new HevcPlayer({
          canvas: this.canvas,
          onStats: (stats) => this.onStats && this.onStats(stats),
          onSize: (w, hgt) => this.onSize && this.onSize(w, hgt),
        })
      : new H264Player({
          canvas: this.canvas, platform: this.platform,
          onStats: (stats) => this.onStats && this.onStats(stats),
          onSize: (w, hgt) => this.onSize && this.onSize(w, hgt),
        });
    if (this.physical) {
      const codecUrl = ROUTE + "/codec?sessionId=" + encodeURIComponent(this.sessionId)
        + "&streamId=" + encodeURIComponent(this.streamId ?? "");
      fetch(codecUrl, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((info) => { if (info && this.player) this.player.configure(info); })
        .catch(() => {});
    }
    this.abort = new AbortController();
    const url = ROUTE + "/stream?sessionId=" + encodeURIComponent(this.sessionId)
      + "&streamId=" + encodeURIComponent(this.streamId ?? "");
    fetch(url, { signal: this.abort.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || response.body === null) {
          this.onState && this.onState({ error: "\u89c6\u9891\u8fde\u63a5\u5931\u8d25 HTTP " + response.status });
          return;
        }
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && this.player) this.player.push(value);
        }
        if (!this.closed) this.onEnd && this.onEnd();
      })
      .catch((error) => {
        if (error && error.name === "AbortError") return;
        this.onState && this.onState({ error: "\u89c6\u9891\u8fde\u63a5\u5931\u8d25" });
        if (!this.closed) this.onEnd && this.onEnd();
      });
  }

  stats() {
    return this.player && typeof this.player.stats === "function" ? this.player.stats() : { frames: 0 };
  }

  send(event) {
    fetch(ROUTE + "/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, streamId: this.streamId, event }),
    }).catch(() => {});
  }

  close() {
    this.closed = true;
    if (this.abort) { try { this.abort.abort(); } catch { /* ignore */ } this.abort = null; }
    if (this.player) this.player.dispose();
    this.player = null;
  }
}

/* ------------------------------------------------------------------- view */

const FRAME_OPTIONS = [
  { id: "device", label: "\u624b\u673a\u6846" },
  { id: "bezel", label: "\u8fb9\u6846" },
  { id: "none", label: "\u65e0\u6846" },
];
const FRAME_KEY = "dsh-sim:frame-style";
const USED_KEY = "dsh-sim:used-devices";
const LAST_KEY = "dsh-sim:last-device";
function readUsedDevices() {
  try {
    const raw = window.localStorage.getItem(USED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item) => typeof item === "string").slice(0, 12) : [];
  } catch { return []; }
}
function readLastDevice() {
  try {
    const raw = window.localStorage.getItem(LAST_KEY);
    const value = raw ? JSON.parse(raw) : undefined;
    return value && typeof value.value === "string" && typeof value.id === "string" ? value : undefined;
  } catch { return undefined; }
}
function rememberLastDevice(item) {
  try {
    window.localStorage.setItem(LAST_KEY, JSON.stringify({
      value: item.value, id: item.id, platform: item.platform, name: item.name,
    }));
  } catch { /* ignore */ }
}
function rememberUsedDevice(id) {
  try {
    const next = readUsedDevices().filter((item) => item !== id);
    next.unshift(id);
    window.localStorage.setItem(USED_KEY, JSON.stringify(next.slice(0, 12)));
  } catch { /* ignore */ }
}
function readFrameStyle() {
  try {
    const saved = window.localStorage.getItem(FRAME_KEY);
    if (saved && FRAME_OPTIONS.some((option) => option.id === saved)) return saved;
  } catch { /* ignore */ }
  return "device";
}
const S = {
  root: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px 10px", boxSizing: "border-box", color: "var(--dsw-alias-label-primary, #1f2328)" },
  row: { display: "flex", alignItems: "center", gap: 5, flex: "none" },
  select: { flex: 1, minWidth: 0, height: 28, padding: "0 6px", borderRadius: 7, border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))", background: "var(--dsw-alias-bg-l1, #fff)", color: "inherit", fontSize: 12 },
  stage: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-l2, rgba(0,0,0,.04))", borderRadius: 10, overflow: "hidden", position: "relative" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary, #6b7280)", fontSize: 12, padding: 16, textAlign: "center" },
  status: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #6b7280)", fontFamily: "var(--ds-font-family-code, monospace)" },
};

function DeviceShell(props) {
  const styleId = props.styleId || "device";
  const platform = props.platform || "ios";
  const safeWidth = Math.max(1, Math.round(props.width || 0));
  if (styleId === "none") {
    return h("div", {
      style: {
        width: safeWidth, flex: "none", borderRadius: Math.round(safeWidth * 0.06),
        overflow: "hidden", background: "#000", lineHeight: 0,
      },
    }, props.children);
  }
  const device = styleId === "device";
  const inset = device ? Math.max(8, Math.round(safeWidth * 0.034)) : 6;
  const screenRadius = Math.round(safeWidth * (platform === "ios" ? (device ? 0.118 : 0.10) : (device ? 0.068 : 0.05)));
  const outerRadius = screenRadius + inset;
  const holeWidth = platform === "ios"
    ? Math.round(safeWidth * 0.30)
    : Math.max(6, Math.round(safeWidth * 0.018));
  const holeHeight = platform === "ios"
    ? Math.max(6, Math.round(safeWidth * 0.034))
    : Math.max(6, Math.round(safeWidth * 0.018));
  const decorations = device ? [
    h("div", {
      key: "hole",
      style: {
        position: "absolute", top: Math.max(4, Math.round(inset * 0.34)), left: "50%",
        transform: "translateX(-50%)", width: holeWidth, height: holeHeight,
        borderRadius: 999, background: "#050507", zIndex: 3,
      },
    }),
    h("div", {
      key: "bar",
      style: {
        position: "absolute", bottom: Math.max(4, Math.round(inset * 0.42)), left: "50%",
        transform: "translateX(-50%)", width: Math.round(safeWidth * 0.34), height: 4,
        borderRadius: 999, background: "rgba(255,255,255,.55)", zIndex: 3,
      },
    }),
    h("div", { key: "vup", style: { position: "absolute", left: -3, top: "20%", width: 3, height: Math.round(safeWidth * 0.07), borderRadius: 2, background: "#26262a" } }),
    h("div", { key: "vdn", style: { position: "absolute", left: -3, top: "31%", width: 3, height: Math.round(safeWidth * 0.07), borderRadius: 2, background: "#26262a" } }),
    h("div", { key: "pwr", style: { position: "absolute", right: -3, top: "25%", width: 3, height: Math.round(safeWidth * 0.11), borderRadius: 2, background: "#26262a" } }),
  ] : [];
  return h("div", {
    style: {
      position: "relative", width: safeWidth, flex: "none", boxSizing: "border-box",
      padding: inset, borderRadius: outerRadius,
      background: "linear-gradient(145deg, #2c2c31, #0c0c0f 55%, #1c1c21)",
      border: "1px solid rgba(255,255,255,.14)",
      boxShadow: "0 18px 40px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.05)",
    },
  }, decorations,
    h("div", {
      style: {
        width: "100%", borderRadius: screenRadius, overflow: "hidden",
        background: "#000", lineHeight: 0, position: "relative",
      },
    }, props.children));
}

const S_ICON = 26;
const DROPDOWN_STYLE = {
  position: "absolute", top: 32, left: 0, zIndex: 80, width: 300,
  maxWidth: "calc(100vw - 24px)", maxHeight: 360, overflow: "auto",
  background: "var(--dsw-alias-bg-l1, #fff)", color: "inherit",
  border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
  borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,.2)", padding: 6,
};
const DROPDOWN_HEADER = { fontSize: 10, opacity: 0.55, padding: "6px 8px 2px" };
const DROPDOWN_ROW = {
  display: "flex", alignItems: "center", gap: 8, width: "100%",
  padding: "6px 8px", borderRadius: 7, border: 0, background: "transparent",
  color: "inherit", cursor: "pointer", textAlign: "left",
};

function DevicePicker(props) {
  const { groups, value, busy, onPick } = props;
  const maxWidth = typeof props.maxWidth === "number" ? props.maxWidth : 156;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const boxRef = useRef(null);
  const all = groups === null ? [] : [...groups.ios, ...groups.physical, ...groups.android, ...groups.avds];
  const selected = all.find((item) => item.value === value);
  const usedIds = open ? readUsedDevices() : [];

  useEffect(() => {
    if (!open) return () => {};
    const onDoc = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  const q = query.trim().toLowerCase();
  const match = (item) => q === "" || item.name.toLowerCase().includes(q) || item.sub.toLowerCase().includes(q);
  const used = all.filter((item) => (usedIds.includes(item.id) || item.value === value) && match(item));
  const others = all.filter((item) => !usedIds.includes(item.id) && item.value !== value && match(item));

  const row = (item) => h("button", {
    key: item.value,
    type: "button",
    style: DROPDOWN_ROW,
    onMouseEnter: (event) => { event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))"; },
    onMouseLeave: (event) => { event.currentTarget.style.background = "transparent"; },
    onClick: () => { setOpen(false); setQuery(""); onPick(item); },
  },
    h("span", {
      style: {
        width: 6, height: 6, borderRadius: 999, flex: "none",
        background: item.stateText === "\u8fd0\u884c\u4e2d" ? "#22c55e" : "#c3c7ce",
      },
    }),
    h("span", { style: { flex: 1, minWidth: 0 } },
      h("span", { style: { display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.label),
      h("span", { style: { display: "block", fontSize: 10, opacity: 0.6 } }, item.sub)),
    item.value === value ? h("span", { style: { fontSize: 12 } }, "\u2713") : null);

  return h("div", { ref: boxRef, style: { position: "relative", flex: "1 1 auto", minWidth: 0, maxWidth: 200 } },
    h("button", {
      type: "button", disabled: busy, "aria-label": "\u9009\u62e9\u6a21\u62df\u5668\uff1a" + (selected ? selected.name : "\u672a\u9009\u62e9"), "aria-expanded": open,
      style: {
        ...S.select, display: "flex", alignItems: "center", gap: 4, width: "100%",
        textAlign: "left", cursor: "pointer", overflow: "hidden",
      },
      onClick: () => { setOpen((current) => !current); setQuery(""); },
    },
      h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        busy ? "\u542f\u52a8\u4e2d\u2026" : selected ? selected.name : (groups === null ? "\u6b63\u5728\u52a0\u8f7d\u8bbe\u5907\u2026" : "\u9009\u62e9\u6a21\u62df\u5668 / \u8bbe\u5907")),
      h("span", { style: { fontSize: 9, opacity: 0.55 } }, "\u25bc")),
    open ? h("div", { style: DROPDOWN_STYLE },
      h("input", {
        value: query,
        onChange: (event) => setQuery(event.target.value),
        placeholder: "\u641c\u7d22\u8bbe\u5907\u2026",
        style: {
          width: "100%", boxSizing: "border-box", height: 28, padding: "0 8px", marginBottom: 4,
          borderRadius: 7, border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16))",
          background: "transparent", color: "inherit", fontSize: 12, outline: "none",
        },
      }),
      used.length > 0 ? h("div", { style: DROPDOWN_HEADER }, "\u4f7f\u7528\u8fc7\u7684\u8bbe\u5907") : null,
      used.map(row),
      others.length > 0 ? h("button", {
        type: "button",
        style: DROPDOWN_ROW,
        onClick: () => setShowAll((current) => !current),
      },
        h("span", { style: { width: 10, fontSize: 10, opacity: 0.6 } }, showAll ? "\u25be" : "\u203a"),
        h("span", { style: { flex: 1, fontSize: 11, opacity: 0.75 } }, "\u6b64\u8ba1\u7b97\u673a\u4e0a\u7684\u5176\u4ed6\u8bbe\u5907\uff08" + others.length + "\uff09")) : null,
      showAll ? others.map(row) : null,
      used.length + others.length === 0
        ? h("div", { style: { padding: 10, fontSize: 11, opacity: 0.6, display: "flex", alignItems: "center", gap: 8 } },
            groups === null ? h(Spinner, { dark: true, size: 12 }) : null,
            groups === null ? "\u6b63\u5728\u52a0\u8f7d\u8bbe\u5907\u2026" : "\u6ca1\u6709\u5339\u914d\u7684\u8bbe\u5907")
        : null,
    ) : null);
}

const ICON_SVG = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", style: { display: "block" } };

function IconPlay() {
  return h("svg", ICON_SVG, h("path", { d: "M5.2 3.1v9.8L13.2 8z", fill: "currentColor" }));
}
function IconStop() {
  return h("svg", ICON_SVG, h("rect", { x: 4.4, y: 4.4, width: 7.2, height: 7.2, rx: 1.4, fill: "currentColor" }));
}
function IconRefresh() {
  return h("svg", ICON_SVG,
    h("path", { d: "M13.1 8A5.1 5.1 0 1 1 11.5 4.3", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", fill: "none" }),
    h("path", { d: "M13.2 1.9v3H10.2", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" }));
}
function IconRotate() {
  return h("svg", ICON_SVG,
    h("rect", { x: 4.6, y: 2.4, width: 6.8, height: 11.2, rx: 1.6, stroke: "currentColor", strokeWidth: 1.4, fill: "none" }),
    h("path", { d: "M13.6 5.6a5.4 5.4 0 0 1 0 4.8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", fill: "none" }),
    h("path", { d: "M2.4 10.4a5.4 5.4 0 0 1 0-4.8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", fill: "none" }));
}
function IconHome() {
  return h("svg", ICON_SVG,
    h("path", { d: "M2.6 7.4 8 2.7l5.4 4.7", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" }),
    h("path", { d: "M4.3 6.7v6.5h7.4V6.7", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" }),
    h("path", { d: "M6.7 13.2V9.6h2.6v3.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" }));
}
function IconPower() {
  return h("svg", ICON_SVG,
    h("path", { d: "M8 2.3v5.1", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
    h("path", { d: "M4.8 4.5a4.5 4.5 0 1 0 6.4 0", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", fill: "none" }));
}

function Spinner(props) {
  const size = props.size || 14;
  return h("span", {
    style: {
      width: size, height: size, flex: "none", borderRadius: "50%",
      border: props.dark ? "2px solid rgba(31,35,40,.18)" : "2px solid rgba(255,255,255,.35)",
      borderTopColor: props.dark ? "rgba(31,35,40,.75)" : "#fff",
      animation: "dsh-sim-spin .8s linear infinite",
      boxSizing: "border-box",
    },
  });
}

const SPIN_KEYFRAMES = "@keyframes dsh-sim-spin{to{transform:rotate(360deg)}}";

function IconLock() {
  return h("svg", ICON_SVG,
    h("rect", { x: 3.7, y: 7.1, width: 8.6, height: 6.5, rx: 1.5, stroke: "currentColor", strokeWidth: 1.4, fill: "none" }),
    h("path", { d: "M5.5 7.1V5.3a2.5 2.5 0 0 1 5 0v1.8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", fill: "none" }),
    h("circle", { cx: 8, cy: 10.5, r: 1.05, fill: "currentColor" }));
}

function IconButton(props) {
  const [hover, setHover] = useState(false);
  const primary = props.primary === true;
  return h("button", {
    type: "button",
    title: props.title,
    "aria-label": props.label || props.title,
    disabled: props.disabled,
    onClick: props.onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: 28, height: 28, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: 7, padding: 0, cursor: props.disabled ? "default" : "pointer", outline: "none",
      border: primary ? "1px solid transparent" : "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))",
      background: primary
        ? "var(--dsw-alias-state-business-primary, #4d6bfe)"
        : (hover ? "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))" : "var(--dsw-alias-bg-l1, #fff)"),
      color: primary ? "#fff" : "var(--dsw-alias-label-primary, #1f2328)",
      opacity: props.disabled ? 0.45 : 1,
      transition: "background .12s ease",
    },
  }, props.children);
}

function SimTab(props) {
  const sessionId = props.scope && typeof props.scope.sessionId === "string" ? props.scope.sessionId : "";
  // Every simulator tab owns its own stream; the host keys sessions by
  // (conversation, stream). Older hosts/default tab fall back to "default".
  const streamId = (props.tab && props.tab.meta && typeof props.tab.meta.streamId === "string" && props.tab.meta.streamId !== "")
    ? props.tab.meta.streamId
    : (props.tab && typeof props.tab.id === "string" && props.tab.id !== "" ? props.tab.id : "default");
  const visible = props.visible !== false;
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [devices, setDevices] = useState(null);
  const [status, setStatus] = useState({ running: false });
  const [busy, setBusy] = useState(false);
  const [busyText, setBusyText] = useState("");
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState({ frames: 0, fps: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState("");
  const [frameStyle, setFrameStyle] = useState(readFrameStyle);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [barWidth, setBarWidth] = useState(0);
  const toolbarRef = useRef(null);
  const stageRef = useRef(null);

  const post = useCallback(async (path, body) => {
    const response = await fetch(ROUTE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, streamId, ...body }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) throw new Error(json.error || ("HTTP " + response.status));
    return json;
  }, [sessionId, streamId]);



  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const response = await fetch(ROUTE + "/devices", { cache: "no-store" });
      setDevices(await response.json());
    } catch (e) { setError(String(e && e.message ? e.message : e)); }
    finally { setDevicesLoading(false); }
  }, []);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  useEffect(() => {
    if (!devices || selected !== "" || (status && status.running)) return;
    const ios = devices.ios || [];
    const booted = ios.find((device) => device.state === "Booted" && device.name.includes("iPhone"))
      ?? ios.find((device) => device.state === "Booted");
    if (booted) setSelected("ios:" + booted.id);
  }, [devices, selected, status]);

  const openStream = useCallback((platform, physical) => {
    if (!visible || sessionId === "") return;
    let session;
    session = new StreamSession({
      sessionId, streamId, platform, physical: physical === true, canvas: canvasRef,
      onStats: setStats,
      onSize: (width, height) => setSize({ width, height }),
      onState: (state) => { if (state.error) setError(state.error); },
      // A stream can die without us closing it (host reload, device sleep,
      // network hiccup). Drop it so the status poll opens a fresh one instead
      // of leaving a black canvas until the user restarts the device.
      onEnd: () => {
        if (streamRef.current === session) {
          streamRef.current = null;
          setSize({ width: 0, height: 0 });
          setStatus({ running: false });
        }
      },
    });
    session.open();
    streamRef.current = session;
  }, [sessionId, streamId, visible]);



  // Follow this conversation's stream while the tab is visible. The tab is
  // per-conversation (better-sidebar scopes it), so nothing leaks across chats.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    setStatus({ running: false });
    setError("");
    setStats({ frames: 0, fps: 0 });
    setSize({ width: 0, height: 0 });
    if (streamRef.current) streamRef.current.close();
    streamRef.current = null;
    if (!visible || sessionId === "") return () => {};

    const sync = () => {
      post("/status", {}).then((json) => {
        if (cancelled) return;
        setError((current) => (current.startsWith("HTTP ") ? "" : current));
        if (streamRef.current !== null && typeof streamRef.current.stats === "function") {
          const diag = streamRef.current.stats();
          post("/diag", { diag: { ...diag, error: diag.failed || diag.error } }).catch(() => {});
        }
        if (json.running) {
          setStatus(json);
          if (streamRef.current === null) {
            setSelected((json.platform || "") + ":" + (json.device || ""));
            openStream(json.platform, json.physical === true);
          }
        } else {
          // Host says the stream is gone (stopped/shut down elsewhere): drop
          // whatever we hold and leave the running state, even if the local
          // session already ended and streamRef is null.
          setStatus({ running: false });
          if (streamRef.current !== null) {
            streamRef.current.close();
            streamRef.current = null;
          }
          setSize({ width: 0, height: 0 });
        }
      }).catch((e) => { if (!cancelled) setError(String(e.message || e)); });
    };
    sync();
    timer = window.setInterval(sync, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionId, visible, post, openStream]);



  useEffect(() => () => { if (streamRef.current) streamRef.current.close(); }, []);

  // Size the canvas bitmap as soon as the device reports its resolution (the
  // scrcpy session packet / first iOS frame), BEFORE the first decoded frame.
  // Otherwise the canvas keeps its intrinsic 300x150 default and the phone
  // frame looks landscape for the first moments of a stream.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
  }, [size.width, size.height]);



  useEffect(() => {
    const element = toolbarRef.current;
    if (!element || typeof ResizeObserver === "undefined") return () => {};
    const observer = new ResizeObserver(() => setBarWidth(element.clientWidth));
    observer.observe(element);
    setBarWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === "undefined") return () => {};
    const observer = new ResizeObserver(() => {
      setStageSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setStageSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [sessionId, visible]);


  useEffect(() => {
    try { window.localStorage.setItem(FRAME_KEY, frameStyle); } catch { /* ignore */ }
  }, [frameStyle]);

  const displayWidth = useMemo(() => {
    if (!size.width || !size.height) return undefined;
    // Contain: scale the whole device into the visible stage (both axes), so
    // it is always fully visible and follows the panel as it resizes.
    const stageWidth = stageSize.width - 20;
    const stageHeight = stageSize.height - 20;
    if (stageWidth <= 0) return undefined;
    const byHeight = stageHeight > 0 ? stageHeight * (size.width / size.height) : Number.POSITIVE_INFINITY;
    return Math.max(1, Math.round(Math.min(stageWidth, byHeight)));
  }, [size.width, size.height, stageSize]);

  const start = useCallback(async (platform, device, name) => {
    if (sessionId === "") { setError("\u5f53\u524d\u4f1a\u8bdd\u5c1a\u672a\u5c31\u7eea"); return; }
    setBusy(true); setBusyText("\u6b63\u5728\u542f\u52a8\u8bbe\u5907\u2026"); setError(""); setSize({ width: 0, height: 0 });
    try {
      const json = await post("/start", { platform, device, name });
      setError("");
      setStatus(json);
      openStream(platform, json.physical === true);
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }, [sessionId, post, openStream]);

  const stop = useCallback(async () => {
    setBusy(true); setBusyText("\u6b63\u5728\u505c\u6b62\u2026"); setError("");
    try {
      await post("/stop", {});
      if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
      setStatus({ running: false }); setStats({ frames: 0, fps: 0 });
    } catch (e) { setError(String(e.message || e)); }
    finally { setBusy(false); }
  }, [post]);

  const shutdownSimulator = useCallback(async () => {
    setBusy(true); setBusyText("\u6b63\u5728\u5173\u95ed\u6a21\u62df\u5668\u2026"); setError("");
    try {
      await post("/shutdown", {});
      if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
      setStatus({ running: false }); setStats({ frames: 0, fps: 0 }); setSize({ width: 0, height: 0 });
    } catch (error) {
      setError(String(error && error.message ? error.message : error));
    } finally { setBusy(false); }
  }, [post]);

  const send = useCallback((event) => { if (streamRef.current) streamRef.current.send(event); }, []);

  const pointer = useRef({ down: false });
  const point = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const onPointerDown = useCallback((event) => {
    if (!streamRef.current) return;
    const p = point(event);
    pointer.current = { down: true };
    event.currentTarget.setPointerCapture && event.currentTarget.setPointerCapture(event.pointerId);
    send({ kind: "touch", action: "begin", x: p.x, y: p.y, width: size.width, height: size.height });
  }, [send, size]);
  const onPointerMove = useCallback((event) => {
    if (!pointer.current.down) return;
    const p = point(event);
    send({ kind: "touch", action: "move", x: p.x, y: p.y, width: size.width, height: size.height });
  }, [send, size]);
  const onPointerUp = useCallback((event) => {
    if (!pointer.current.down) return;
    const p = point(event);
    pointer.current.down = false;
    send({ kind: "touch", action: "end", x: p.x, y: p.y, width: size.width, height: size.height });
  }, [send, size]);

  const groups = useMemo(() => {
    if (!devices) return null;
    const ios = (devices.ios || []).map((device) => ({
      value: "ios:" + device.id,
      label: device.name,
      sub: (device.runtime ? device.runtime.replace(/^iOS\./, "iOS ") : "iOS")
        + " \u00b7 " + (device.state === "Booted" ? "\u8fd0\u884c\u4e2d" : "\u5df2\u505c\u6b62"),
      stateText: device.state === "Booted" ? "\u8fd0\u884c\u4e2d" : "\u5df2\u505c\u6b62",
      platform: "ios", id: device.id, name: device.name,
    }));
    const android = (devices.android || []).map((device) => ({
      value: "android:" + device.id,
      label: device.name,
      sub: "Android" + (device.osVersion ? " " + device.osVersion : "")
        + (device.sdk ? " \u00b7 API " + device.sdk : "")
        + " \u00b7 " + (device.state === "device" ? "\u8fd0\u884c\u4e2d" : device.state),
      stateText: device.state === "device" ? "\u8fd0\u884c\u4e2d" : device.state,
      platform: "android", id: device.id, name: device.name,
    }));
    const avds = (devices.avds || [])
      .filter((avd) => !(devices.android || []).some((device) => device.id === avd))
      .map((avd) => ({
        value: "android:" + avd, label: avd,
        sub: "Android AVD \u00b7 \u672a\u542f\u52a8", stateText: "\u672a\u542f\u52a8",
        platform: "android", id: avd, name: avd,
      }));
    const physical = (devices.physical || []).map((device) => ({
      value: "ios:" + device.id,
      label: device.name,
      sub: "\u771f\u673a \u00b7 " + (device.runtime || "iOS") + (device.model ? " \u00b7 " + device.model : ""),
      stateText: "\u8fde\u63a5\u4e2d",
      platform: "ios", id: device.id, name: device.name, physical: true,
    }));
    return { ios, android, avds, physical };
  }, [devices]);

  const onPick = useCallback((item) => {
    if (!item) return;
    rememberUsedDevice(item.id);
    rememberLastDevice(item);
    setSelected(item.value);
    start(item.platform, item.id, item.name);
  }, [start]);

  const startDefault = useCallback(() => {
    if (groups === null) return;
    const all = [...groups.ios, ...groups.physical, ...groups.android, ...groups.avds];
    const picked = all.find((item) => item.value === selected)
      ?? groups.ios.find((item) => item.name.includes("iPhone") && item.label.includes("\u5df2\u542f\u52a8"))
      ?? groups.ios.find((item) => item.name.includes("iPhone"))
      ?? groups.ios.find((item) => item.label.includes("\u5df2\u542f\u52a8"))
      ?? groups.ios[0]
      ?? groups.android[0]
      ?? groups.avds[0];
    if (picked) {
      rememberUsedDevice(picked.id);
      rememberLastDevice(picked);
      setSelected(picked.value);
      start(picked.platform, picked.id, picked.name);
    }
  }, [groups, selected, start]);

  const running = status && status.running === true;
  const platform = running ? status.platform : "";
  const showPicker = barWidth === 0 || barWidth >= 250;
  const showExtras = barWidth === 0 || barWidth >= 360;



  // Mouse wheel / trackpad scroll over the picture scrolls the device instead
  // of the page. Deltas are normalized and throttled to one control message per
  // 60 ms; iOS has no wheel HID event, so the host emulates it with a short drag.
  useEffect(() => {
    const host = canvasRef.current;
    if (!host || !running || !visible) return () => {};
    let dy = 0;
    let x = 0.5;
    let y = 0.5;
    let timer = 0;
    const flush = () => {
      timer = 0;
      if (dy === 0) return;
      const delta = Math.max(-1, Math.min(1, dy / 80));
      dy = 0;
      send({ kind: "scroll", x, y, dy: delta });
    };
    const onWheel = (event) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      }
      dy += event.deltaY;
      if (timer === 0) timer = window.setTimeout(flush, 60);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheel);
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [running, visible, send]);


  return h("div", { style: S.root },
    h("style", null, SPIN_KEYFRAMES),
    h("div", { ref: toolbarRef, style: { ...S.row, flexWrap: "nowrap", width: "100%" } },
      showPicker ? h(DevicePicker, { groups, value: selected, busy, onPick, maxWidth: barWidth >= 420 ? 200 : 132 }) : null,
      h("span", { style: { flex: 1 } }),
      h(IconButton, {
        primary: !running,
        onClick: running ? stop : startDefault,
        disabled: busy || groups === null,
        title: running ? "\u505c\u6b62" : "\u542f\u52a8",
      }, busy ? h(Spinner) : h(running ? IconStop : IconPlay)),
      !running ? h(IconButton, { onClick: loadDevices, disabled: busy || devicesLoading, title: "\u5237\u65b0\u8bbe\u5907" },
        devicesLoading ? h(Spinner, { dark: true }) : h(IconRefresh)) : null,
      running ? h(IconButton, { title: "\u65cb\u8f6c", onClick: () => send({ kind: "rotate" }) }, h(IconRotate)) : null,
      running ? h(IconButton, { title: "\u4e3b\u9875", onClick: () => send({ kind: "key", name: "home" }) }, h(IconHome)) : null,
      running ? h(IconButton, {
        title: platform === "ios" ? "\u9501\u5c4f" : "\u7535\u6e90",
        onClick: () => send({ kind: "key", name: platform === "ios" ? "lock" : "power" }),
      }, h(platform === "ios" ? IconLock : IconPower)) : null,
      running && platform === "ios" ? h(IconButton, { title: "\u5173\u95ed\u6a21\u62df\u5668", onClick: shutdownSimulator }, h(IconPower)) : null,
      running && showExtras ? h("select", {
        style: { ...S.select, flex: "0 0 auto", width: 58, minWidth: 0 },
        value: frameStyle,
        onChange: (event) => setFrameStyle(event.target.value),
        "aria-label": "\u8bbe\u5907\u8fb9\u6846",
      }, FRAME_OPTIONS.map((option) => h("option", { key: option.id, value: option.id }, option.label))) : null),

    error !== "" ? h("span", {
      style: { ...S.status, color: "#d33", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      title: error,
    }, error) : null,

    h("div", {
      ref: stageRef,
      style: { ...S.stage, overflow: "auto", justifyContent: "safe center", alignItems: "safe center", padding: 8 },
    },
      running && visible
        ? h("div", {
            style: {
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "100%", height: "100%",
              opacity: size.width > 0 ? 1 : 0,
              pointerEvents: size.width > 0 ? "auto" : "none",
            },
          },
            h(DeviceShell, {
              styleId: frameStyle,
              platform: platform || "ios",
              width: displayWidth === undefined ? Math.min(Math.max(160, (stageSize.width || 360) - 16), 420) : displayWidth,
            },
              h("canvas", {
                ref: canvasRef,
                style: { display: "block", width: "100%", height: "auto", maxWidth: "none", maxHeight: "none", background: "#000" },
                onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
              })))
        : visible ? h("div", {
            style: {
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: 10, width: "100%", height: "100%", padding: 8, boxSizing: "border-box",
            },
          },
            h("div", {
              style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #9aa0a6)", lineHeight: 1.4 },
            }, "没有连接模拟器"),
            h(DeviceShell, {
              styleId: frameStyle,
              platform: platform || "ios",
              width: displayWidth === undefined ? Math.min(Math.max(160, (stageSize.width || 360) - 16), 420) : displayWidth,
            },
              h("div", {
                style: {
                  width: "100%", aspectRatio: (platform || "ios") === "ios" ? "1206 / 2622" : "9 / 19.5",
                  background: "#000", display: "flex", alignItems: "center", justifyContent: "center",
                },
              },
                h("span", {
                  style: { fontSize: 12, color: "rgba(255,255,255,.45)", lineHeight: 1.5 },
                }, "流已断开连接"))))
        : null,
      (running && visible && size.width === 0) || busy ? h("div", {
        style: {
          position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 5,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        },
      },
        h("div", {
          style: {
            display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
            padding: "20px 26px", borderRadius: 14,
            background: "var(--dsw-alias-bg-l1, #fff)",
            border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
            boxShadow: "0 12px 34px rgba(0,0,0,.14)",
          },
        },
          h(Spinner, { dark: true, size: 22 }),
          h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #6b7280)" } },
            busy ? (busyText || (running ? "正在停止…" : "正在启动设备…")) : "正在连接画面…"))) : null,
      h("div", {
        style: {
          position: "absolute", right: 8, bottom: 8, zIndex: 5,
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 8px", borderRadius: 999,
          background: "rgba(20,20,24,.62)", color: "#fff", fontSize: 10,
          pointerEvents: "none", whiteSpace: "nowrap",
        },
      },
        h("span", { style: { width: 6, height: 6, borderRadius: 999, background: running ? "#22c55e" : "#9ca3af" } }),
        running ? "\u5df2\u8fde\u63a5" : "\u672a\u8fde\u63a5")));

}


/* ------------------------------------------------------------- workspace */

const PANE_BAR = { display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", minHeight: 32, flex: "none" };

function pickerSub(item) {
  return item.sub;
}

function deviceItems(devices, platform) {
  if (devices === null) return { ios: [], android: [], avds: [], physical: [] };
  const ios = (devices.ios || []).map((device) => ({
    value: "ios:" + device.id,
    label: device.name,
    sub: (device.runtime ? device.runtime.replace(/^iOS\./, "iOS ") : "iOS") + " · " + (device.state === "Booted" ? "运行中" : "已停止"),
    stateText: device.state === "Booted" ? "运行中" : "已停止",
    platform: "ios", id: device.id, name: device.name,
  }));
  const physical = (devices.physical || []).map((device) => ({
    value: "ios:" + device.id,
    label: device.name,
    sub: "真机 · " + (device.runtime || "iOS") + (device.model ? " · " + device.model : ""),
    stateText: "已连接",
    platform: "ios", id: device.id, name: device.name, physical: true,
  }));
  const android = (devices.android || []).map((device) => ({
    value: "android:" + device.id,
    label: device.name,
    sub: "Android" + (device.osVersion ? " " + device.osVersion : "") + (device.sdk ? " · API " + device.sdk : "") + " · " + (device.state === "device" ? "运行中" : device.state),
    stateText: device.state === "device" ? "运行中" : device.state,
    platform: "android", id: device.id, name: device.name,
  }));
  const avds = (devices.avds || [])
    .filter((avd) => !(devices.android || []).some((device) => device.id === avd))
    .map((avd) => ({ value: "android:" + avd, label: avd, sub: "Android AVD · 未启动", stateText: "未启动", platform: "android", id: avd, name: avd }));
  if (platform === "ios") return { ios, physical, android: [], avds: [] };
  return { ios: [], physical: [], android, avds };
}

function DevicePane(props) {
  const { sessionId, slot, platform, title } = props;
  const [devices, setDevices] = useState(null);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stageWidth, setStageWidth] = useState(0);
  const [stageHeight, setStageHeight] = useState(0);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const streamRef = useRef(null);

  const post = useCallback(async (path, body) => {
    const response = await fetch(ROUTE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, streamId: slot, ...body }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) throw new Error(json.error || "HTTP " + response.status);
    return json;
  }, [sessionId, slot]);

  const openStream = useCallback((streamPlatform, physical) => {
    if (streamRef.current !== null) { streamRef.current.close(); streamRef.current = null; }
    const session = new StreamSession({
      sessionId, streamId: slot, platform: streamPlatform, physical: physical === true, canvas: canvasRef,
      onSize: (width, height) => setSize({ width, height }),
      onState: (state) => { if (state.error) setError(state.error); },
      onEnd: () => { if (streamRef.current === session) { streamRef.current = null; setSize({ width: 0, height: 0 }); } },
    });
    session.open();
    streamRef.current = session;
  }, [sessionId, slot]);

  useEffect(() => () => { if (streamRef.current !== null) streamRef.current.close(); }, []);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return () => {};
    const measure = () => { setStageWidth(node.clientWidth); setStageHeight(node.clientHeight); };
    measure();
    if (typeof ResizeObserver === "undefined") return () => {};
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(ROUTE + "/devices", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => { if (!cancelled) setDevices(json); })
      .catch(() => { if (!cancelled) setDevices({ ios: [], physical: [], android: [], avds: [] }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const sync = () => {
      post("/status", {}).then((json) => {
        if (cancelled) return;
        if (json.running) {
          setStatus(json);
          setSelected((json.platform || "") + ":" + (json.device || ""));
          if (streamRef.current === null) openStream(json.platform, json.physical === true);
        } else {
          setStatus({ running: false });
          if (streamRef.current !== null) { streamRef.current.close(); streamRef.current = null; }
          setSize({ width: 0, height: 0 });
        }
      }).catch(() => {});
    };
    sync();
    timer = window.setInterval(sync, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [post, openStream]);

  const groups = useMemo(() => deviceItems(devices, platform), [devices, platform]);
  const items = useMemo(() => {
    const all = [...groups.ios, ...groups.physical, ...groups.android, ...groups.avds];
    return all;
  }, [groups]);

  const start = useCallback(async (item) => {
    if (!item || busy) return;
    setBusy(true); setError(""); setSize({ width: 0, height: 0 });
    try {
      const json = await post("/start", { platform: item.platform, device: item.id, name: item.name });
      setStatus(json);
      setSelected(item.value);
      openStream(json.platform, json.physical === true);
    } catch (error) { setError(String(error && error.message ? error.message : error)); }
    finally { setBusy(false); }
  }, [post, openStream, busy]);

  const running = status !== null && status.running === true;
  const send = useCallback((event) => { post("/control", { event }).catch(() => {}); }, [post]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await post("/stop", {});
      if (streamRef.current !== null) { streamRef.current.close(); streamRef.current = null; }
      setStatus({ running: false }); setSize({ width: 0, height: 0 });
    } catch (error) { setError(String(error && error.message ? error.message : error)); }
    finally { setBusy(false); }
  }, [post]);

  const shutdown = useCallback(async () => {
    setBusy(true);
    try {
      await post("/shutdown", {});
      if (streamRef.current !== null) { streamRef.current.close(); streamRef.current = null; }
      setStatus({ running: false }); setSize({ width: 0, height: 0 });
    } catch (error) { setError(String(error && error.message ? error.message : error)); }
    finally { setBusy(false); }
  }, [post]);

  const pointer = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const onDown = (event) => { const p = pointer(event); if (p) send({ kind: "touch", action: "begin", x: p.x, y: p.y }); };
  const onMove = (event) => { const p = pointer(event); if (p) send({ kind: "touch", action: "move", x: p.x, y: p.y }); };
  const onUp = (event) => { const p = pointer(event); if (p) send({ kind: "touch", action: "end", x: p.x, y: p.y }); };

  const frameWidth = Math.max(140, Math.min((stageWidth || 320) - 18, stageHeight > 0 ? (stageHeight - 18) / 2.2 : 380, 380));
  const selectedItem = items.find((item) => item.value === selected);
  const idleLabel = platform === "ios" ? "iPhone" : "Android";

  return h("div", {
    style: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, borderRight: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.07))" },
  },
    h("div", { style: PANE_BAR },
      h("span", { style: { fontSize: 10, opacity: 0.5, flex: "none" } }, title),
      h(DevicePicker, { groups, value: selected, busy, onPick: start, maxWidth: 150 }),
      h(IconButton, {
        title: running ? "停止" : "启动",
        onClick: running ? stop : () => start(selectedItem ?? items[0]),
        disabled: busy || (!running && items.length === 0),
      }, h(running ? IconStop : IconPlay)),
      running ? h(IconButton, { title: "主页", onClick: () => send({ kind: "key", name: "home" }) }, h(IconHome)) : null,
      running ? h(IconButton, { title: "旋转", onClick: () => send({ kind: "rotate" }) }, h(IconRotate)) : null,
      running && platform === "ios" ? h(IconButton, { title: "关闭模拟器", onClick: shutdown }, h(IconPower)) : null,
    ),
    h("div", {
      ref: stageRef,
      style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: 6 },
    },
      h(DeviceShell, {
        styleId: "device",
        platform,
        width: frameWidth,
      },
        running
          ? h("canvas", {
              ref: canvasRef,
              style: { display: "block", width: "100%", height: "auto", opacity: size.width > 0 ? 1 : 0.001, background: "#000", touchAction: "none" },
              onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp,
            })
          : h("div", {
              style: { width: "100%", aspectRatio: platform === "ios" ? "1206 / 2622" : "9 / 19.5", background: "#000", display: "flex", alignItems: "center", justifyContent: "center" },
            },
              h("span", { style: { fontSize: 11, color: "rgba(255,255,255,.42)" } }, running ? "正在连接画面…" : "流已断开连接")))),
    error !== "" ? h("div", { style: { fontSize: 10, color: "#d33", padding: "0 8px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: error }, error) : null,
    h("div", { style: { ...S.status, alignSelf: "flex-end", margin: "0 6px 6px" } },
      h("span", { style: { width: 6, height: 6, borderRadius: 999, background: running ? "#22c55e" : "#9ca3af" } }),
      running ? "已连接" : (idleLabel + " · 未连接")));
}

function LogsDock(props) {
  const { sessionId } = props;
  const [open, setOpen] = useState(true);
  const [lines, setLines] = useState([]);
  const [meta, setMeta] = useState(null);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState("all");

  useEffect(() => {
    if (!open) return () => {};
    let cancelled = false;
    let timer = 0;
    const load = () => {
      fetch(ROUTE + "/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, streamId: "android", lines: 400 }),
      }).then((response) => response.json()).then((json) => {
        if (cancelled) return;
        setMeta(json);
        if (json.supported) setLines(json.lines || []);
      }).catch(() => {});
    };
    load();
    timer = window.setInterval(load, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionId, open]);

  const shown = lines.filter((line) => {
    if (filter !== "" && !line.toLowerCase().includes(filter.toLowerCase())) return false;
    if (level === "all") return true;
    const upper = line.toUpperCase();
    if (level === "error") return upper.includes(" E/") || upper.includes(" E ") || upper.includes("ERROR");
    if (level === "warn") return upper.includes(" W/") || upper.includes(" W ") || upper.includes("WARN");
    if (level === "info") return upper.includes(" I/") || upper.includes(" I ") || upper.includes("INFO");
    return true;
  }).slice(-300);

  return h("div", {
    style: {
      flex: "none", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
      display: "flex", flexDirection: "column", minHeight: 0,
      height: open ? 190 : 30, transition: "height .15s ease", background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02))",
    },
  },
    h("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", flex: "none" } },
      h("button", {
        type: "button",
        onClick: () => setOpen((current) => !current),
        style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 11, padding: "2px 4px" },
      }, (open ? "▾ " : "▸ ") + "日志"),
      h("input", {
        value: filter,
        onChange: (event) => setFilter(event.target.value),
        placeholder: "过滤…",
        style: {
          flex: 1, minWidth: 0, maxWidth: 220, height: 22, padding: "0 6px", fontSize: 11,
          borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))",
          background: "transparent", color: "inherit", outline: "none",
        },
      }),
      h("select", {
        value: level,
        onChange: (event) => setLevel(event.target.value),
        style: { height: 22, fontSize: 11, borderRadius: 6, background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))" },
      }, ["all", "info", "warn", "error"].map((value) => h("option", { key: value, value }, value))),
      h("span", { style: { fontSize: 10, opacity: 0.5, marginLeft: "auto" } },
        meta === null ? "" : meta.supported ? shown.length + " 行" : "Android 设备未连接"),
      h("button", {
        type: "button",
        onClick: () => setLines([]),
        style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 10, opacity: 0.6 },
      }, "清空"),
    ),
    open ? h("div", {
      style: {
        flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px 6px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10, lineHeight: 1.55,
        whiteSpace: "pre-wrap", wordBreak: "break-all",
      },
    }, shown.length === 0
      ? h("div", { style: { opacity: 0.5, paddingTop: 6 } }, "暂无日志")
      : shown.map((line, index) => h("div", { key: index, style: { opacity: line.includes(" E ") || line.includes(" E/") ? 0.95 : 0.75 } }, line))) : null);
}

function WorkspaceTab(props) {
  const sessionId = props.scope && typeof props.scope.sessionId === "string" ? props.scope.sessionId : "";
  const [layout, setLayout] = useState("both");
  const panes = [];
  if (layout !== "android") panes.push(h(DevicePane, { key: "ios", sessionId, slot: "ios", platform: "ios", title: "iOS" }));
  if (layout !== "ios") panes.push(h(DevicePane, { key: "android", sessionId, slot: "android", platform: "android", title: "Android" }));
  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
    h("div", {
      style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", flex: "none", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.07))" },
    },
      h("span", { style: { fontSize: 10, opacity: 0.5 } }, "布局"),
      ...["both", "ios", "android"].map((value) => h("button", {
        key: value,
        type: "button",
        onClick: () => setLayout(value),
        style: {
          fontSize: 11, padding: "2px 10px", borderRadius: 999, cursor: "pointer",
          border: "1px solid " + (layout === value ? "transparent" : "var(--dsw-alias-border-l2, rgba(0,0,0,.14))"),
          background: layout === value ? "var(--dsw-alias-accent-soft, rgba(64,120,255,.14))" : "transparent",
          color: "inherit",
        },
      }, value === "both" ? "双设备" : value === "ios" ? "仅 iOS" : "仅 Android"))),
    h("div", { style: { flex: 1, display: "flex", minHeight: 0 } }, panes),
    h(LogsDock, { sessionId }));
}


function MobileDevTab() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const refreshPanel = useCallback(() => fetch(ROUTE + "/mobile-panel", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
    .then((response) => response.json())
    .then((json) => {
      if (!json.ok) throw new Error(json.error || "无法启动模拟器");
      // The panel forwards what the user shoots or annotates to this host; carry
      // the host origin in the URL so it knows where to send it.
      let next = json.url;
      try {
        const parsed = new URL(json.url);
        parsed.searchParams.set("host", window.location.origin);
        next = parsed.toString();
      } catch { /* keep the URL as served */ }
      setUrl((current) => current === next ? current : next);
      setError("");
    }), []);

  useEffect(() => {
    let cancelled = false;
    refreshPanel()
      .catch((error) => { if (!cancelled) setError(String(error && error.message ? error.message : error)); });
    return () => { cancelled = true; };
  }, [refreshPanel]);

  useEffect(() => {
    const timer = setInterval(() => { refreshPanel().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [refreshPanel]);

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
    error !== "" ? h("div", { style: { padding: 12, fontSize: 12, color: "#d33" } }, error) : null,
    url !== ""
      ? h("iframe", { src: url, style: { flex: 1, width: "100%", minHeight: 0, border: 0, background: "#000" } })
      : h("div", { style: { margin: "auto", fontSize: 12, opacity: 0.6 } }, "正在启动模拟器…"));
}

/* ----------------------------------------------------------------- plugin */

let betterSidebarService;

/**
 * Every "模拟器" click opens another window.
 *
 * The sidebar focuses an existing tab whose id matches the new one, so a single
 * registered type with a fixed id can only ever exist once. `createTab` mints a
 * unique id per window and `dedupeKey` never matches, which is the documented
 * multi-instance pattern (the browser builtin hosts one tab per URL the same
 * way). The two older kinds stay registered but hidden, so windows created by an
 * earlier version keep rendering after an upgrade.
 */
const SIM_KIND = "dsh-sim:simulator";
const LEGACY_KINDS = ["dsh-sim:simulator-2", "dsh-sim:simulator-3"];
const SIM_TITLE = "模拟器";
let simWindowSerial = 0;

function sidebarTabCount(state) {
  try {
    let count = 0;
    const one = (tab) => tab && (tab.type === SIM_KIND || LEGACY_KINDS.includes(tab.type));
    const walk = (node) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        if (node.every((item) => item && typeof item === "object" && typeof item.type === "string")) count += node.filter(one).length;
        else for (const item of node) walk(item);
        return;
      }
      for (const value of Object.values(node)) if (value !== null && typeof value === "object") walk(value);
    };
    walk(state);
    return count;
  } catch {
    return 0;
  }
}

function simDescriptor(extra) {
  return {
    id: SIM_KIND,
    title: SIM_TITLE,
    description: "iOS / Android 模拟器实时画面，点按即可操作；每次打开都是一个独立窗口",
    icon: (size) => SimIcon(size),
    order: 55,
    single: false,
    dedupeKey: () => undefined,
    createTab: (state) => {
      simWindowSerial += 1;
      const index = Math.max(sidebarTabCount(state), simWindowSerial - 1) + 1;
      return {
        tab: {
          id: SIM_KIND + ":" + Date.now().toString(36) + "-" + simWindowSerial,
          type: SIM_KIND,
          title: index <= 1 ? SIM_TITLE : SIM_TITLE + " " + index,
        },
      };
    },
    component: (props) => h(MobileDevTab, props),
    ...extra,
  };
}

function apply(ctx) {
  ctx.inject(["betterSidebar"], (sidebarCtx) => {
    betterSidebarService = sidebarCtx.betterSidebar;
    sidebarCtx.effect(() => {
      const disposers = [sidebarCtx.betterSidebar.registerTab(simDescriptor({}))];
      for (const id of LEGACY_KINDS) {
        disposers.push(sidebarCtx.betterSidebar.registerTab({
          id,
          title: SIM_TITLE,
          description: "旧版模拟器窗口",
          icon: (size) => SimIcon(size),
          order: 55,
          hidden: true,
          single: false,
          component: (props) => h(MobileDevTab, props),
        }));
      }
      return () => { for (const dispose of disposers) if (typeof dispose === "function") dispose(); };
    }, "dsh-sim: better-sidebar tabs");
  });
}

exports.name = "dsh-sim";
exports.inject = [];
exports.apply = apply;
return module.exports;
} });