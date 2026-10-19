"use strict";
// MS ASCII – Photoshop UXP panel.
// Turns the whole document or the selected layer into characters, on a new pixel layer above it.
//  • Any installed font: the characters are drawn once with real text layers (inside a history step that is
//    rolled back), read as pixels and kept as a glyph atlas – core.js builds the picture from it.
//  • The settings live in the XMP of the ASCII layer: select it, change something, click Update.

const { app, core, action, imaging, constants } = require("photoshop");
const { batchPlay } = action;
const Core = require("./core.js");
const UI = require("./ms-ui.js");
const lfs = require("uxp").storage.localFileSystem;

const $ = (id) => document.getElementById(id);
const STORE_KEY = "msascii.state.v1", SOURCE_KEY = "msascii.source.v1", PRESET_KEY = "msascii.presets.v1", SEC_KEY = "msascii.sections.v1";
const LAYER_PREFIX = "MS ASCII · ";
const HIST = "MS ASCII";
const XMP_NS = "http://ms-ascii/1.0/";
const MAX_PIXELS = 60e6;
const ATLAS_PX = 96;     // glyphs are drawn at about this size and scaled from there
// fonts that suit ASCII art – shown first when they are installed
const MONO_FAMILIES = ["Courier New", "Courier", "Courier Prime", "Menlo", "Monaco", "SF Mono", "Andale Mono", "Consolas",
  "Lucida Console", "Lucida Sans Typewriter", "Source Code Pro", "IBM Plex Mono", "JetBrains Mono", "Fira Code", "Fira Mono",
  "Roboto Mono", "Space Mono", "Ubuntu Mono", "Inconsolata", "DejaVu Sans Mono", "Liberation Mono", "Cascadia Code",
  "OCR A Std", "OCR A Extended", "OCR-A", "Share Tech Mono", "VT323", "Press Start 2P", "PT Mono", "Overpass Mono", "Nova Mono"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debounce = (fn, ms) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function load(key, fb) { try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v === null ? fb : v; } catch (e) { return fb; } }
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ } }

let params = Core.sanitize(load(STORE_KEY, {}));
let source = load(SOURCE_KEY, "layer") === "document" ? "document" : "layer";
let activeLook = null, busy = false, selfTestRunning = false, previewMode = "fit";
let editing = null;          // { layerId, sourceId, source } – the ASCII layer the panel is working on
let previewSrc = null;       // { w, h, rgba, scale, key, name }
let fonts = [];              // [{ name, ps, family, style }]

function setStatus(msg, err) { const el = $("status"); el.textContent = msg || ""; el.className = err ? "status err" : "status"; }
function testStatus(msg, err) { setStatus(msg, err); const el = $("testStatus"); if (el) { el.textContent = msg || ""; el.className = err ? "status err" : "status"; } }

// ---------------------------------------------------------------- log (plugin data folder, for support)
const logLines = [];
let logTimer = null;
function log(msg, data) {
  logLines.push(new Date().toISOString() + " " + msg + (data !== undefined ? " " + JSON.stringify(data) : ""));
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  clearTimeout(logTimer);
  logTimer = setTimeout(async () => { try { const f = await (await lfs.getDataFolder()).createFile("ascii-log.txt", { overwrite: true }); await f.write(logLines.join("\n") + "\n"); } catch (e) { /* ignore */ } }, 300);
}

// ---------------------------------------------------------------- pixels
function to8bit(data, cs) {
  if (cs === 8) return data;
  const out = new Uint8Array(data.length), f = cs === 16 ? 255 / 32768 : 255;
  for (let i = 0; i < data.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(data[i] * f)));
  return out;
}
function fromBuf8(buf, doc) {
  const depth = String(doc.bitsPerChannel || "");
  if (depth.indexOf("16") >= 0) { const out = new Uint16Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = Math.round(buf[i] * 32768 / 255); return out; }
  if (depth.indexOf("32") >= 0) { const out = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255; return out; }
  return buf;
}
function toRGBA(raw, comps, n) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (comps >= 3) { out[i * 4] = raw[i * comps]; out[i * 4 + 1] = raw[i * comps + 1]; out[i * 4 + 2] = raw[i * comps + 2]; }
    else out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = raw[i * comps];
    out[i * 4 + 3] = comps === 4 || comps === 2 ? raw[i * comps + comps - 1] : 255;
  }
  return out;
}
const docBounds = (doc) => ({ left: 0, top: 0, right: Math.round(Number(doc.width)), bottom: Math.round(Number(doc.height)) });
function boundsOf(l) { const b = l.boundsNoEffects || l.bounds; return { left: Math.floor(b.left), top: Math.floor(b.top), right: Math.ceil(b.right), bottom: Math.ceil(b.bottom) }; }
function clampB(b, d) { return { left: Math.max(d.left, b.left), top: Math.max(d.top, b.top), right: Math.min(d.right, b.right), bottom: Math.min(d.bottom, b.bottom) }; }
const isGroup = (l) => !!(l && l.layers);
function allLayers(c, out) { for (const l of c.layers || []) { out.push(l); if (l.layers) allLayers(l, out); } return out; }
const isOurs = (l) => !!(l && !l.layers && String(l.name).indexOf(LAYER_PREFIX) === 0);
async function selectLayer(id) { await batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false }], {}); }

// pixels of a region: the document (our layers hidden) or one layer (incl. its layer mask)
async function readPixels(doc, b, layer, targetSize) {
  const o = { documentID: doc.id, sourceBounds: b, colorSpace: "RGB", componentSize: 8 };
  if (layer) o.layerID = layer.id;
  if (targetSize) o.targetSize = targetSize;
  const res = await imaging.getPixels(o);
  const id = res.imageData, sb = res.sourceBounds || b;
  const raw = to8bit(await id.getData({ chunky: true }), id.componentSize || 8);
  const src = toRGBA(raw, id.components, id.width * id.height);
  id.dispose();
  if (!layer) return { w: id.width, h: id.height, rgba: src };
  // a layer only returns its occupied area – place it on the requested region (scaled for previews)
  const f = targetSize ? targetSize.width / (b.right - b.left) : 1;
  const W = targetSize ? targetSize.width : b.right - b.left, H = targetSize ? targetSize.height : b.bottom - b.top, rgba = new Uint8Array(W * H * 4);
  const offX = Math.round((sb.left - b.left) * f), offY = Math.round((sb.top - b.top) * f);
  for (let y = 0; y < id.height; y++) for (let x = 0; x < id.width; x++) {
    const tx = offX + x, ty = offY + y;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const s = (y * id.width + x) * 4, d = (ty * W + tx) * 4;
    rgba[d] = src[s]; rgba[d + 1] = src[s + 1]; rgba[d + 2] = src[s + 2]; rgba[d + 3] = src[s + 3];
  }
  if (targetSize) return { w: W, h: H, rgba };
  try {
    const r = await batchPlay([{ _obj: "get", _target: [{ _property: "hasUserMask" }, { _ref: "layer", _id: layer.id }] }, { _obj: "get", _target: [{ _property: "userMaskEnabled" }, { _ref: "layer", _id: layer.id }] }], {});
    if (r && r[0] && r[0].hasUserMask && !(r[1] && r[1].userMaskEnabled === false)) {
      const mr = await imaging.getLayerMask({ documentID: doc.id, layerID: layer.id, kind: "user", sourceBounds: b });
      const md = mr.imageData, mraw = to8bit(await md.getData({ chunky: true }), md.componentSize || 8), mb = mr.sourceBounds || b;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const mx = Math.max(0, Math.min(md.width - 1, b.left + x - mb.left)), my = Math.max(0, Math.min(md.height - 1, b.top + y - mb.top));
        rgba[(y * W + x) * 4 + 3] = rgba[(y * W + x) * 4 + 3] * mraw[(my * md.width + mx) * md.components] / 255;
      }
      md.dispose();
    }
  } catch (e) { /* no mask */ }
  return { w: W, h: H, rgba };
}
// runs fn with our ASCII layers hidden (history rolled back) – for reading the document
async function withOursHidden(ctx, doc, fn, inHistory) {
  const ours = allLayers(doc, []).filter((l) => isOurs(l) && l.visible);
  if (!ours.length) return fn();
  let hid = null;
  if (!inHistory) hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " read" });
  for (const l of ours) l.visible = false;
  try { return await fn(); }
  finally { if (hid !== null) await ctx.hostControl.resumeHistory(hid, false); else for (const l of ours) l.visible = true; }
}

// ---------------------------------------------------------------- XMP (settings on the ASCII layer)
function xmpFor(p, sourceId, src) {
  const json = JSON.stringify({ params: p, sourceId: sourceId || null, source: src }).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:msascii="${XMP_NS}"><msascii:params>${json}</msascii:params></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
async function writeXmp(layerId, p, sourceId, src) {
  await batchPlay([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }], to: { _obj: "layer", XMPMetadataAsUTF8: xmpFor(p, sourceId, src) } }], {});
}
async function readXmp(layerId) {
  try {
    const r = await batchPlay([{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }] }], {});
    const x = r && r[0] && r[0].XMPMetadataAsUTF8, m = x && /<msascii:params>([\s\S]*?)<\/msascii:params>/.exec(x);
    if (!m) return null;
    const o = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
    return { params: Core.sanitize(o.params), sourceId: o.sourceId || null, source: o.source === "document" ? "document" : "layer" };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- fonts
function loadFonts() {
  try {
    fonts = Array.from(app.fonts || []).map((f) => ({ name: String(f.name), ps: String(f.postScriptName), family: String(f.family || f.name), style: String(f.style || "") }));
  } catch (e) { fonts = []; log("fonts not readable", String(e)); }
}
function monoFonts() {
  const out = [];
  for (const fam of MONO_FAMILIES) {
    const list = fonts.filter((f) => f.family.toLowerCase() === fam.toLowerCase());
    if (!list.length) continue;
    out.push(list.find((f) => /^(regular|roman|book|normal|medium)$/i.test(f.style)) || list[0]);
  }
  return out;
}
function fontByPS(ps) { return fonts.find((f) => f.ps === ps) || null; }
function currentFont() { return fontByPS(params.font) || monoFonts()[0] || fonts[0] || null; }

// ---------------------------------------------------------------- glyph atlas
// glyphs per font are cached; only missing characters are drawn
const atlasCache = new Map();   // ps → { px, glyphs, failed }
let atlasJob = null;
async function atlasFor(font, chars) {
  const key = font ? font.ps : "_mini";
  let A = atlasCache.get(key);
  if (!A) { A = { px: ATLAS_PX, glyphs: {} }; atlasCache.set(key, A); }
  const need = Core.uniqueChars(chars.concat(["M", "g", "|"])).filter((c) => !A.glyphs[c]);
  if (!font || !need.length) return font ? A : Core.miniAtlas(chars);
  if (window.__canvasAtlas) { for (const c of need) A.glyphs[c] = window.__canvasAtlas(font, c, ATLAS_PX); return A; }
  while (atlasJob) await atlasJob;
  const doc = app.activeDocument;
  if (!doc) return Core.miniAtlas(chars);
  atlasJob = (async () => {
    try {
      await core.executeAsModal(async (ctx) => {
        const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " glyphs" });
        try { await drawGlyphs(doc, font, need, A); }
        finally { await ctx.hostControl.resumeHistory(hid, false); }   // roll back: the text layers vanish again
      }, { commandName: HIST + " font" });
    } catch (e) { log("glyphs failed", String(e && e.stack || e)); A.failed = String(e && e.message || e); }
  })();
  await atlasJob; atlasJob = null;
  return A;
}
// one text layer per character: draw, read its pixels relative to the pen point, delete
async function drawGlyphs(doc, font, chars, A) {
  const res = Number(doc.resolution) || 72, D = docBounds(doc);
  const px = Math.max(24, Math.min(ATLAS_PX, Math.floor(Math.min(D.right, D.bottom) / 3)));
  A.px = px;
  const pt = px * 72 / res, X = Math.round(px * 0.6), Y = Math.round(px * 1.6);
  let n = 0;
  for (const c of chars) {
    if (/\s/.test(c)) { A.glyphs[c] = { w: 0, h: 0, x0: 0, y0: 0, a: new Uint8Array(0) }; continue; }
    if (n++ % 6 === 0) setStatus(`Preparing "${font.name}" … ${n} / ${chars.length}`);
    await batchPlay([{
      _obj: "make", _target: [{ _ref: "textLayer" }],
      using: {
        _obj: "textLayer", textKey: c,
        textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: X / D.right * 100 }, vertical: { _unit: "percentUnit", _value: Y / D.bottom * 100 } },
        antiAlias: { _enum: "antiAliasType", _value: "antiAliasSmooth" },
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: c.length, textStyle: { _obj: "textStyle", fontPostScriptName: font.ps, size: { _unit: "pointsUnit", _value: pt }, color: { _obj: "RGBColor", red: 0, grain: 0, blue: 0 } } }],
        paragraphStyleRange: [{ _obj: "paragraphStyleRange", from: 0, to: c.length, paragraphStyle: { _obj: "paragraphStyle", align: { _enum: "alignmentType", _value: "left" } } }],
      },
    }], {});
    const layer = doc.activeLayers[0];
    let g = { w: 0, h: 0, x0: 0, y0: 0, a: new Uint8Array(0) };
    try {
      await batchPlay([{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _id: layer.id }] }], {});
      const b = boundsOf(layer);
      if (b.right > b.left && b.bottom > b.top) {
        const r = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, sourceBounds: b, colorSpace: "RGB", componentSize: 8 });
        const id = r.imageData, sb = r.sourceBounds || b, raw = to8bit(await id.getData({ chunky: true }), id.componentSize || 8);
        const a = new Uint8Array(id.width * id.height);
        for (let i = 0; i < a.length; i++) a[i] = id.components === 4 || id.components === 2 ? raw[i * id.components + id.components - 1] : 255;
        g = { w: id.width, h: id.height, x0: sb.left - X, y0: sb.top - Y, a };
        id.dispose();
      }
    } catch (e) { log("glyph", { c, e: String(e) }); }
    A.glyphs[c] = g;
    try { await layer.delete(); } catch (e) { /* rolled back anyway */ }
  }
}

// ---------------------------------------------------------------- target: what gets converted
async function resolveTarget(doc) {
  const sel = (doc.activeLayers || [])[0] || null;
  if (sel && isOurs(sel)) {
    const x = await readXmp(sel.id);
    if (x) {
      const src = x.source === "layer" ? allLayers(doc, []).find((l) => l.id === x.sourceId) || null : null;
      return { ours: sel, saved: x, source: x.source, layer: src };
    }
  }
  if (source === "document") return { ours: allLayers(doc, []).find((l) => isOurs(l) && l.name === LAYER_PREFIX + "Document") || null, source: "document", layer: null };
  if (!sel) return { source: "layer", layer: null, error: "Select a layer – or switch to Whole document." };
  if (isGroup(sel)) return { source: "layer", layer: null, error: "Select a single layer, not a group." };
  const ours = allLayers(doc, []).find((l) => isOurs(l) && l.name === LAYER_PREFIX + sel.name) || null;
  return { source: "layer", layer: sel, ours };
}
function regionOf(doc, t) {
  const D = docBounds(doc);
  if (t.source === "document") return D;
  const b = clampB(boundsOf(t.layer), D);
  return b.right > b.left && b.bottom > b.top ? b : null;
}

// ---------------------------------------------------------------- preview
const PV_W = 300, PV_H = 170;
async function encodeRGBA(rgba, w, h, back) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, n = w * h; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255, bg = back(i % w, Math.floor(i / w));
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = bg + (rgba[i * 4 + c] - bg) * a;
  }
  const d = await imaging.createImageDataFromBuffer(rgb, { width: w, height: h, components: 3, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
  try { return "data:image/jpeg;base64," + await imaging.encodeImageData({ imageData: d, base64: true }); } finally { d.dispose(); }
}
const checker = (x, y) => (((x >> 3) + (y >> 3)) & 1 ? 46 : 34);

let previewBusy = false;
async function refreshPreviewSource() {
  if (busy || selfTestRunning || previewBusy) return;
  const doc = app.activeDocument;
  if (!doc) { previewSrc = null; $("targetName").textContent = "–"; return showPreviewMsg("Open a document…"); }
  previewBusy = true;
  try {
    const t = await resolveTarget(doc);
    if (t.saved && (!editing || editing.layerId !== t.ours.id)) {
      // an ASCII layer was selected: load its settings
      params = Core.sanitize(t.saved.params); source = t.saved.source; activeLook = null;
      store(STORE_KEY, params); store(SOURCE_KEY, source); syncUI();
      setStatus("Settings of this ASCII layer loaded – change them and click Update.");
    }
    editing = t.ours ? { layerId: t.ours.id } : null;
    $("targetName").textContent = t.source === "document" ? doc.name || doc.title || "Document" : t.layer ? t.layer.name : "–";
    syncApply(t);
    if (t.error || (t.source === "layer" && !t.layer)) { previewSrc = null; return showPreviewMsg(t.error || "The original layer of this ASCII layer is gone."); }
    const b = regionOf(doc, t);
    if (!b) { previewSrc = null; return showPreviewMsg("The layer is empty."); }
    const W = b.right - b.left, H = b.bottom - b.top;
    let rb = b, size = null, scale;
    if (previewMode === "fit") { const f = Math.min(1, PV_W / W, PV_H / H); size = { width: Math.max(1, Math.round(W * f)), height: Math.max(1, Math.round(H * f)) }; scale = size.width / W; }
    else {   // 1:1 – the middle of the region at full size
      const cx = Math.round((b.left + b.right) / 2), cy = Math.round((b.top + b.bottom) / 2);
      rb = clampB({ left: cx - PV_W / 2, top: cy - PV_H / 2, right: cx + PV_W / 2, bottom: cy + PV_H / 2 }, b); scale = 1;
    }
    let px = null;
    await core.executeAsModal(async (ctx) => {
      if (t.source === "document") px = await withOursHidden(ctx, doc, () => readPixels(doc, rb, null, size));
      else if (t.layer.visible) px = await readPixels(doc, rb, t.layer, size);
      else {   // a hidden original (under its ASCII layer) is shown for a moment – rolled back
        const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " read" });
        try { t.layer.visible = true; px = await readPixels(doc, rb, t.layer, size); } finally { await ctx.hostControl.resumeHistory(hid, false); }
      }
    }, { commandName: HIST + " preview" });
    previewSrc = Object.assign(px, { scale });
    await renderPreview();
    if (previewMode === "fit") renderThumbs();   // the look tiles always show the whole picture
  } catch (e) {
    previewSrc = null; showPreviewMsg("Preview not possible: " + (e.message || e)); log("preview", String(e && e.stack || e));
  } finally { previewBusy = false; }
}
function showPreviewMsg(msg) { $("preview").className = "hidden"; $("previewMsg").className = "preview-msg"; $("previewMsg").textContent = msg; }
let previewToken = 0;
async function renderPreview() {
  const s = previewSrc;
  if (!s) return;
  const token = ++previewToken;
  const atlas = await atlasFor(currentFont(), Core.charsOf(params));
  if (token !== previewToken) return;
  const out = Core.render(s, params, atlas, { scale: s.scale, bgMask: bgMaskOf(s) });
  const url = await encodeRGBA(out, s.w, s.h, checker);
  if (token !== previewToken) return;
  $("preview").src = url; $("preview").className = ""; $("previewMsg").className = "hidden";
  if (atlas.failed) setStatus(`"${currentFont() ? currentFont().name : "?"}" could not be drawn – ${atlas.failed}`, true);
  else if (/^Preparing/.test($("status").textContent)) setStatus("");
}
function bgMaskOf(s) { if (source === "document") return null; const m = new Uint8Array(s.w * s.h); for (let i = 0; i < m.length; i++) m[i] = s.rgba[i * 4 + 3]; return m; }

// look tiles show your picture in every look
let thumbToken = 0;
async function renderThumbs() {
  const token = ++thumbToken, s = previewSrc;
  if (!s) return;
  const TW = 96, TH = 54, f = Math.min(TW / s.w, TH / s.h);
  const w = Math.max(1, Math.round(s.w * f)), h = Math.max(1, Math.round(s.h * f));
  const small = { w, h, rgba: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(s.w - 1, Math.floor(x / f)), sy = Math.min(s.h - 1, Math.floor(y / f));
    for (let c = 0; c < 4; c++) small.rgba[(y * w + x) * 4 + c] = s.rgba[(sy * s.w + sx) * 4 + c];
  }
  for (const l of Core.LOOKS) {
    if (token !== thumbToken) return;
    try {
      const lp = Core.lookParams(l.id), atlas = await atlasFor(currentFont(), Core.charsOf(lp));
      // thumbnails use bigger cells than the result, so the look stays readable
      const out = Core.render(small, Object.assign(lp, { cell: Math.max(5, lp.cell * 0.55) }), atlas, { scale: 1, bgMask: bgMaskOf(small) });
      const url = await encodeRGBA(out, w, h, checker);
      const tile = document.querySelector(`.look[data-id="${l.id}"]`);
      if (tile && token === thumbToken) { const img = document.createElement("img"); img.src = url; tile.replaceChild(img, tile.firstChild); }
    } catch (e) { log("thumb", String(e)); return; }
    await sleep(0);
  }
}

// ---------------------------------------------------------------- apply / update / remove
async function makePixelLayer(doc, name, buf, w, h, off, above) {
  if (above) await selectLayer(above.id);
  else if (doc.layers[0]) await selectLayer(doc.layers[0].id);
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name } }], {});
  const layer = doc.activeLayers[0];
  if (!above && doc.layers[0] && doc.layers[0].id !== layer.id) await layer.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);
  const d = await imaging.createImageDataFromBuffer(fromBuf8(buf, doc), { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
  try { await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: d, targetBounds: { left: off.left, top: off.top } }); }
  finally { d.dispose(); }
  return layer;
}
async function apply() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) return setStatus("Open a document first.", true);
  if (String(doc.mode).toLowerCase().indexOf("rgb") < 0) return setStatus("MS ASCII needs an RGB document – Image › Mode › RGB Color.", true);
  busy = true;
  const t0 = Date.now();
  try {
    const t = await resolveTarget(doc);
    if (t.error) throw new Error(t.error);
    if (t.source === "layer" && !t.layer) throw new Error("The original layer of this ASCII layer is gone – select a layer and click Apply.");
    const b = regionOf(doc, t);
    if (!b) throw new Error("The layer is empty.");
    const W = b.right - b.left, H = b.bottom - b.top;
    if (W * H > MAX_PIXELS) throw new Error(`Too large (${Math.round(W * H / 1e6)} MP, maximum ${MAX_PIXELS / 1e6} MP).`);
    const p = Core.sanitize(params), font = currentFont();
    const atlas = await atlasFor(font, Core.charsOf(p));
    if (atlas.failed) throw new Error(`"${font.name}" could not be drawn: ${atlas.failed}`);
    let made = null;
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: t.ours ? HIST + " · Update" : HIST });
      try {
        let src;
        if (t.source === "document") src = await withOursHidden(ctx, doc, () => readPixels(doc, b, null, null), true);
        else { if (!t.layer.visible) t.layer.visible = true; src = await readPixels(doc, b, t.layer, null); }
        const mask = t.source === "layer" ? (() => { const m = new Uint8Array(W * H); for (let i = 0; i < m.length; i++) m[i] = src.rgba[i * 4 + 3]; return m; })() : null;
        const out = Core.render(src, p, atlas, { bgMask: mask });
        const name = LAYER_PREFIX + (t.source === "document" ? "Document" : t.layer.name);
        // Update: the new layer takes the place of the old one
        const above = t.ours || t.layer;
        made = await makePixelLayer(doc, name, out, W, H, b, above);
        if (t.ours) await t.ours.delete();
        await writeXmp(made.id, p, t.layer ? t.layer.id : null, t.source);
        if (t.layer) t.layer.visible = !p.hideSource;
        await selectLayer(made.id);
        await ctx.hostControl.resumeHistory(hid, true);
      } catch (e) { await ctx.hostControl.resumeHistory(hid, false); throw e; }
    }, { commandName: HIST });
    editing = { layerId: made.id };
    syncApply({ ours: made });
    setStatus(`${t.ours ? "Updated" : "Done"}: "${made.name}" – ${W} × ${H} px in ${((Date.now() - t0) / 1000).toFixed(1)} s. One undo step.`);
    log("apply", { source: t.source, W, H, font: font && font.ps, ms: Date.now() - t0 });
  } catch (e) {
    setStatus(String(e && e.message || e), true); log("apply failed", String(e && e.stack || e));
  } finally { busy = false; }
}
async function remove() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) return;
  busy = true;
  try {
    const sel = (doc.activeLayers || []).filter(isOurs);
    let list = sel;
    if (!list.length) { const t = await resolveTarget(doc); if (t.ours) list = [t.ours]; }
    if (!list.length) { setStatus("No MS ASCII layer selected."); return; }
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " · Remove" });
      for (const l of list) {
        const x = await readXmp(l.id), src = x && x.sourceId ? allLayers(doc, []).find((k) => k.id === x.sourceId) : null;
        if (src) src.visible = true;
        await l.delete();
        if (src) await selectLayer(src.id);
      }
      await ctx.hostControl.resumeHistory(hid, true);
    }, { commandName: HIST + " · Remove" });
    editing = null;
    setStatus(`Removed ${list.length} ASCII layer${list.length > 1 ? "s" : ""}.`);
  } catch (e) { setStatus(String(e && e.message || e), true); }
  finally { busy = false; refreshPreviewSource(); }
}
function syncApply(t) { $("apply").textContent = t && t.ours ? "Update" : "Apply"; }

// ---------------------------------------------------------------- UI
const ctl = {};
const SLIDERS = [
  { parent: "secGrid", key: "cell", label: "Cell size", unit: "px", min: 3, max: 120, step: 1, tip: "Height of one character cell" },
  { parent: "secGrid", key: "width", label: "Cell width", unit: "%", min: 30, max: 200, step: 1, tip: "Width of a cell in % of its height – 60 % suits most monospaced fonts" },
  { parent: "secGrid", key: "glyphSize", label: "Character size", unit: "%", min: 40, max: 200, step: 1 },
  { parent: "secAngle", key: "angle", label: "Angle", unit: "°", min: -180, max: 180, step: 1, tip: "Direction of the lines, clockwise" },
  { parent: "secTone", key: "contrast", label: "Contrast", unit: "", min: -100, max: 100, step: 1 },
  { parent: "secTone", key: "brightness", label: "Brightness", unit: "", min: -100, max: 100, step: 1 },
  { parent: "secTone", key: "threshold", label: "Leave empty below", unit: "%", min: 0, max: 95, step: 1, tip: "Cells with less tone stay empty – cleans up backgrounds" },
  { parent: "secSat", key: "saturation", label: "Saturation", unit: "%", min: 0, max: 200, step: 1, show: (p) => p.colorMode === "image" },
];
function changed(fromLook) {
  params = Core.sanitize(params);
  if (!fromLook) activeLook = null;
  store(STORE_KEY, params);
  syncUI();
  debouncedPreview();
}
const debouncedPreview = debounce(() => renderPreview().catch((e) => log("preview", String(e))), 80);
const set = (k, v) => { params[k] = v; changed(); };

function buildUI() {
  for (const s of SLIDERS) ctl[s.key] = UI.slider($(s.parent), Object.assign({ def: Core.DEFAULTS[s.key] }, s), { get: () => params[s.key], set: (v) => set(s.key, v) });
  UI.seg($("previewModeSeg"), [{ id: "fit", name: "Fit", tip: "Whole picture" }, { id: "detail", name: "1:1", tip: "Detail at the real size" }], (v) => { previewMode = v; syncUI(); refreshPreviewSource(); });
  UI.seg($("sourceSeg"), [{ id: "layer", name: "Selected layer" }, { id: "document", name: "Whole document" }], (v) => { source = v; store(SOURCE_KEY, v); editing = null; syncUI(); refreshPreviewSource(); });
  UI.seg($("charModeSeg"), Core.CHAR_MODES, (v) => set("charMode", v));
  UI.seg($("toneSeg"), Core.TONE_BY, (v) => set("toneBy", v));
  UI.seg($("denseSeg"), [{ id: "dark", name: "Dark areas", tip: "Dense characters where the picture is dark – for light backgrounds" }, { id: "light", name: "Light areas", tip: "Dense characters where the picture is light – for dark backgrounds" }], (v) => set("denseOn", v));
  UI.seg($("colorModeSeg"), Core.COLOR_MODES, (v) => set("colorMode", v));
  UI.seg($("bgSeg"), [{ id: "none", name: "Transparent" }, { id: "color", name: "Colour" }], (v) => set("background", v));
  $("charsetRow").innerHTML = Core.CHARSETS.map((c) => `<div class="chip" data-v="${c.id}">${UI.esc(c.name)}${c.chars ? `<span class="sample">${UI.esc(c.chars.replace(/^ /, "").slice(0, 6))}</span>` : ""}</div>`).join("");
  $("charsetRow").querySelectorAll(".chip").forEach((el) => el.addEventListener("click", () => set("charset", el.getAttribute("data-v"))));
  $("paletteChips").innerHTML = Core.PALETTES.map((p) => `<div class="chip pal" data-v="${p.id}">${p.stops.map((c) => `<i style="background-color:${c}"></i>`).join("")}${UI.esc(p.name)}</div>`).join("");
  $("paletteChips").querySelectorAll(".chip").forEach((el) => el.addEventListener("click", () => { const id = el.getAttribute("data-v"); Object.assign(params, Core.gradOf(id), { palette: id }); changed(); }));
  $("dirRow").innerHTML = Core.DIRECTIONS.map((d) => `<div class="dir" data-a="${d.angle}" title="${d.tip}">${d.name}</div>`).join("");
  $("dirRow").querySelectorAll(".dir").forEach((el) => el.addEventListener("click", () => set("angle", Number(el.getAttribute("data-a")))));
  $("customChars").addEventListener("input", debounce(() => { params.custom = $("customChars").value || " "; params.charset = "custom"; changed(); }, 250));
  $("textInput").addEventListener("input", debounce(() => { params.text = $("textInput").value || "A"; changed(); }, 250));
  for (const k of ["sortDensity", "upright", "hideSource"]) UI.bindSwitch(k, (on) => set(k, on));
  for (const k of ["ink", "bgColor", "grad1", "grad2", "grad3"]) {
    $("swatch-" + k).addEventListener("click", () => UI.openColorPop({ pop: $("colorPop"), key: k, anchor: $("swatch-" + k), get: () => params[k], set: (c) => { params[k] = c; if (/^grad/.test(k)) params.palette = "own"; changed(); }, exact: () => pickColor(k) }));
  }
  // looks
  $("lookGrid").innerHTML = Core.LOOKS.map((l) => `<div class="look" data-id="${l.id}" title="${UI.esc(l.name)}"><div class="ph"></div><div class="lbl">${UI.esc(l.name)}</div></div>`).join("");
  $("lookGrid").querySelectorAll(".look").forEach((el) => el.addEventListener("click", () => applyLook(el.getAttribute("data-id"))));
  // fonts
  $("fontSearch").addEventListener("input", debounce(renderFontResults, 120));
  // presets & tools
  rebuildPresets();
  $("presetSave").addEventListener("click", () => {
    const name = String($("presetName").value || "").trim();
    if (!name) return setStatus("Give the preset a name first.", true);
    const u = load(PRESET_KEY, {}); u[name] = Object.assign({}, params); store(PRESET_KEY, u);
    $("presetName").value = ""; rebuildPresets(); setStatus(`Preset "${name}" saved.`);
  });
  $("resetAll").addEventListener("click", () => { const f = params.font, fn = params.fontName; params = Core.sanitize({ font: f, fontName: fn }); changed(); });
  $("refreshPreview").addEventListener("click", () => { previewSrc = null; refreshPreviewSource(); });
  $("apply").addEventListener("click", apply);
  $("remove").addEventListener("click", remove);
  $("selfTest").addEventListener("click", () => { testStatus("Self-test running – a test document opens, this takes a moment …"); setTimeout(() => runSelfTest().catch((e) => testStatus("Self-test stopped: " + (e.message || e), true)), 60); });
  UI.sections(SEC_KEY, { looks: true, chars: true, font: false, grid: true, tone: false, colour: true, more: false });
}
function rebuildPresets() {
  const u = load(PRESET_KEY, {});
  UI.presetList($("presetList"), Object.keys(u), (n) => { params = Core.sanitize(load(PRESET_KEY, {})[n]); changed(); setStatus(`Preset "${n}" loaded.`); },
    (n) => { const x = load(PRESET_KEY, {}); delete x[n]; store(PRESET_KEY, x); rebuildPresets(); setStatus(`Preset "${n}" deleted.`); });
}
function applyLook(id) {
  const lp = Core.lookParams(id);
  if (!lp) return;
  params = Object.assign(lp, { font: params.font, fontName: params.fontName, hideSource: params.hideSource });
  activeLook = id;
  changed(true);
  setStatus(`Look "${Core.LOOKS.find((l) => l.id === id).name}" – everything stays adjustable.`);
}
function pickFont(f) { params.font = f.ps; params.fontName = f.name; changed(); }
function renderFontChips() {
  const list = monoFonts(), cur = currentFont();
  $("fontChips").innerHTML = list.length ? list.map((f) => `<div class="chip${cur && f.ps === cur.ps ? " on" : ""}" data-ps="${UI.esc(f.ps)}">${UI.esc(f.family)}</div>`).join("")
    : `<div class="empty">No monospaced font found – search all fonts below.</div>`;
  $("fontChips").querySelectorAll(".chip").forEach((el) => el.addEventListener("click", () => pickFont(fontByPS(el.getAttribute("data-ps")))));
}
function renderFontResults() {
  const q = String($("fontSearch").value || "").trim().toLowerCase(), cur = currentFont();
  if (!q) { $("fontResults").innerHTML = ""; return; }
  const words = q.split(/\s+/);
  const hits = fonts.filter((f) => words.every((w) => (f.name + " " + f.family + " " + f.style).toLowerCase().indexOf(w) >= 0)).slice(0, 60);
  $("fontResults").innerHTML = hits.length ? hits.map((f) => `<div class="font-item${cur && f.ps === cur.ps ? " on" : ""}" data-ps="${UI.esc(f.ps)}">${UI.esc(f.family)}<span class="st">${UI.esc(f.style)}</span></div>`).join("")
    : `<div class="empty">No font matches "${UI.esc(q)}".</div>`;
  $("fontResults").querySelectorAll(".font-item").forEach((el) => el.addEventListener("click", () => pickFont(fontByPS(el.getAttribute("data-ps")))));
}
async function pickColor(k) {
  const h = parseInt(params[k].slice(1), 16);
  try {
    let res;
    await core.executeAsModal(async () => {
      res = await batchPlay([{ _obj: "showColorPicker", _target: { _ref: "application" }, context: HIST, color: { _obj: "RGBColor", red: (h >> 16) & 255, grain: (h >> 8) & 255, blue: h & 255 } }], {});
    }, { commandName: "Pick colour" });
    const c = res && res[0] && (res[0].RGBFloatColor || res[0].color);
    if (c && c.red !== undefined) {
      const g = c.grain !== undefined ? c.grain : c.green;
      params[k] = "#" + [c.red, g, c.blue].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
      if (/^grad/.test(k)) params.palette = "own";
      changed();
    }
  } catch (e) { setStatus("Colour picker not available – type a hex value.", true); }
}

function syncUI() {
  const p = params;
  for (const k of Object.keys(ctl)) { const c = ctl[k]; c.set(p[k]); c.row.className = "sl" + (c.def.show && !c.def.show(p) ? " hidden" : ""); }
  UI.syncSeg($("previewModeSeg"), previewMode);
  UI.syncSeg($("sourceSeg"), source);
  UI.syncSeg($("charModeSeg"), p.charMode);
  UI.syncSeg($("denseSeg"), p.denseOn);
  UI.syncSeg($("colorModeSeg"), p.colorMode);
  UI.syncSeg($("bgSeg"), p.background);
  // tone: "Character" only works when the brightness picks the character
  $("toneSeg").querySelectorAll(".seg-btn").forEach((b) => { const v = b.getAttribute("data-v"); b.className = "seg-btn" + (v === p.toneBy ? " active" : "") + (v === "char" && p.charMode !== "ramp" ? " hidden" : ""); });
  $("charsetRow").className = p.charMode === "text" ? "chips hidden" : "chips";
  $("charsetRow").querySelectorAll(".chip").forEach((el) => { el.className = el.getAttribute("data-v") === p.charset ? "chip on" : "chip"; });
  $("customRow").className = p.charMode !== "text" && p.charset === "custom" ? "field" : "field hidden";
  $("textRow").className = p.charMode === "text" ? "field" : "field hidden";
  $("sortRow").className = p.charMode === "ramp" ? "row" : "row hidden";
  if (document.activeElement !== $("customChars")) $("customChars").value = p.custom;
  if (document.activeElement !== $("textInput")) $("textInput").value = p.text;
  UI.setSwitch("sortDensity", p.sortDensity); UI.setSwitch("upright", p.upright); UI.setSwitch("hideSource", p.hideSource);
  $("dirRow").querySelectorAll(".dir").forEach((el) => { el.className = Number(el.getAttribute("data-a")) === p.angle ? "dir on" : "dir"; });
  $("inkRow").className = p.colorMode === "ink" ? "field" : "field hidden";
  $("gradRow").className = p.colorMode === "gradient" ? "" : "hidden";
  $("paletteChips").querySelectorAll(".chip").forEach((el) => { el.className = "chip pal" + (el.getAttribute("data-v") === p.palette ? " on" : ""); });
  $("bgRow").className = p.background === "color" ? "field" : "field hidden";
  for (const k of ["ink", "bgColor", "grad1", "grad2", "grad3"]) { $("swatch-" + k).style.backgroundColor = p[k]; const hl = $("hexl-" + k); if (hl) hl.textContent = p[k]; }
  document.querySelectorAll(".look").forEach((el) => { el.className = el.getAttribute("data-id") === activeLook ? "look active" : "look"; });
  $("lookName").textContent = activeLook ? Core.LOOKS.find((l) => l.id === activeLook).name : "";
  const f = currentFont();
  $("fontMeta").textContent = f ? f.name : "no font";
  $("charsMeta").textContent = p.charMode === "text" ? "“" + p.text.trim().slice(0, 14) + "”" : Core.charsOf(p).join("").trim().slice(0, 14);
  $("gridMeta").textContent = `${p.cell} px · ${p.angle}°`;
  renderFontChips();
  if ($("fontSearch").value) renderFontResults();
}

// ---------------------------------------------------------------- self-test
function testArt(w, h) {
  const a = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, d = Math.hypot(x - w * 0.3, y - h * 0.5);
    const v = d < h * 0.3 ? 30 : 60 + 190 * x / w;
    a[i] = v; a[i + 1] = v * 0.9; a[i + 2] = 255 - v * 0.5; a[i + 3] = 255;
  }
  return a;
}
async function inkPixels(doc, layer) {
  let n = 0;
  await core.executeAsModal(async () => { const px = await readPixels(doc, docBounds(doc), layer, null); for (let i = 3; i < px.rgba.length; i += 4) if (px.rgba[i] > 128) n++; }, { commandName: HIST + " test" });
  return n;
}
async function runSelfTest() {
  if (busy || selfTestRunning) return;
  selfTestRunning = true;
  const results = [], saved = Object.assign({}, params), savedSource = source, t0 = Date.now();
  const check = async (name, fn) => { try { const r = await fn(); results.push({ name, ok: !!(r && r.ok), r }); } catch (e) { results.push({ name, ok: false, r: String(e && e.stack || e) }); } };
  try {
    let doc, artId, bgId;
    const W = 600, H = 360;
    await core.executeAsModal(async () => {
      doc = await app.documents.add({ width: W, height: H, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MS ASCII Self-test" });
      await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: "Art" } }], {});
      const l = doc.activeLayers[0]; artId = l.id;
      const d = await imaging.createImageDataFromBuffer(testArt(400, 240), { width: 400, height: 240, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
      await imaging.putPixels({ documentID: doc.id, layerID: l.id, imageData: d, targetBounds: { left: 100, top: 60 } }); d.dispose();
      bgId = doc.layers[doc.layers.length - 1].id;
    }, { commandName: HIST + " test" });
    const art = () => allLayers(doc, []).find((l) => l.id === artId);
    const ours = () => allLayers(doc, []).filter(isOurs);
    await check("Fonts: the font list is readable", async () => ({ ok: fonts.length > 0, n: fonts.length, mono: monoFonts().map((f) => f.family).slice(0, 5) }));
    await check("Glyphs: the font is drawn, '@' has more ink than '.'", async () => {
      const f = currentFont(), A = await atlasFor(f, [".", "@", "#"]);
      const c1 = Core.coverage(A.glyphs["."], A.px), c2 = Core.coverage(A.glyphs["@"], A.px);
      return { ok: !A.failed && c2 > c1 * 2 && c1 > 0, font: f && f.ps, dot: +c1.toFixed(3), at: +c2.toFixed(3), failed: A.failed };
    });
    await check("Selected layer: ASCII layer above it, original hidden", async () => {
      source = "layer"; params = Core.sanitize(Object.assign({}, Core.DEFAULTS, { font: saved.font, colorMode: "ink", ink: "#000000", cell: 10 }));
      await core.executeAsModal(async () => selectLayer(artId), { commandName: HIST + " test" });
      await apply();
      const o = ours(), idx = doc.layers.findIndex((l) => l.id === (o[0] && o[0].id)), ai = doc.layers.findIndex((l) => l.id === artId);
      const ink = o[0] ? await inkPixels(doc, o[0]) : 0;
      return { ok: o.length === 1 && idx >= 0 && idx < ai && !art().visible && ink > 2000, n: o.length, ink, status: $("status").textContent };
    });
    await check("Settings are stored in the layer (XMP)", async () => {
      const x = await readXmp(ours()[0].id);
      return { ok: !!x && x.params.cell === 10 && x.sourceId === artId && x.source === "layer" };
    });
    await check("Update: changed settings replace the layer, no duplicate", async () => {
      await core.executeAsModal(async () => selectLayer(ours()[0].id), { commandName: HIST + " test" });
      params.cell = 18; await apply();
      const o = ours(), x = o[0] ? await readXmp(o[0].id) : null;
      return { ok: o.length === 1 && x && x.params.cell === 18, n: o.length };
    });
    await check("Angle 90° and your text render", async () => {
      await core.executeAsModal(async () => selectLayer(ours()[0].id), { commandName: HIST + " test" });
      params = Core.sanitize(Object.assign({}, params, { charMode: "text", text: "MS ", angle: 90, toneBy: "size" })); await apply();
      const o = ours(), ink = o[0] ? await inkPixels(doc, o[0]) : 0;
      return { ok: o.length === 1 && ink > 1000, ink };
    });
    await check("Whole document: one layer on top", async () => {
      source = "document"; params = Core.sanitize(Object.assign({}, Core.DEFAULTS, { font: saved.font, background: "color", bgColor: "#101010", colorMode: "image", denseOn: "light" }));
      await apply();
      const top = doc.layers[0], ink = await inkPixels(doc, top);
      return { ok: isOurs(top) && top.name === LAYER_PREFIX + "Document" && ink === W * H, name: top.name, ink };
    });
    await check("Whole document again: the old ASCII layers are not read in", async () => {
      await apply();
      const docLayers = ours().filter((l) => l.name === LAYER_PREFIX + "Document");
      return { ok: docLayers.length === 1, n: docLayers.length };
    });
    await check("Every look renders", async () => {
      const f = currentFont(), small = { w: 120, h: 72, rgba: testArt(120, 72) }, empty = [];
      for (const l of Core.LOOKS) { const lp = Core.lookParams(l.id), A = await atlasFor(f, Core.charsOf(lp)), out = Core.render(small, lp, A, {}); let n = 0; for (let i = 3; i < out.length; i += 4) if (out[i]) n++; if (n < 50) empty.push(l.name); }
      return { ok: !empty.length, empty };
    });
    await check("Remove: ASCII layers gone, original visible", async () => {
      await core.executeAsModal(async () => { await batchPlay([{ _obj: "selectAllLayers", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {}); }, { commandName: HIST + " test" });
      await remove();
      return { ok: ours().length === 0 && art().visible, left: ours().map((l) => l.name) };
    });
    void bgId;
  } catch (e) { results.push({ name: "Self-test setup", ok: false, r: String(e && e.stack || e) }); }
  params = saved; source = savedSource; store(SOURCE_KEY, source); syncUI();
  const bad = results.filter((r) => !r.ok);
  log("SELFTEST", { secs: Math.round((Date.now() - t0) / 1000), results });
  selfTestRunning = false;
  testStatus(`Self-test: ${results.length - bad.length} / ${results.length} ok` + (bad.length ? " – failed: " + bad.map((b) => b.name + " " + JSON.stringify(b.r).slice(0, 180)).join("; ") : ". Close the test document without saving."), bad.length > 0);
}

// ---------------------------------------------------------------- start
const onPsEvent = debounce(() => { if (!busy && !selfTestRunning) refreshPreviewSource(); }, 400);
async function init() {
  loadFonts();
  if (!fontByPS(params.font)) { const f = currentFont(); if (f) { params.font = f.ps; params.fontName = f.name; } }
  try { buildUI(); syncUI(); } catch (e) { log("UI", String(e && e.stack || e)); }
  try { action.addNotificationListener(["select", "make", "delete", "open", "close", "set", "move", "transform", "hide", "show"], onPsEvent); }
  catch (e) { log("events not available", String(e)); }
  refreshPreviewSource();
}
init();
