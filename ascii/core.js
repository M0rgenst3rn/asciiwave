"use strict";
// Asciiwave – engine. Plain JavaScript without Photoshop, so it runs in Node, in a browser and in the panel.
//
// The picture is cut into a grid of cells (any angle). Every cell gets the brightness, colour and coverage
// of the pixels below it; from that it picks a character (or a size / opacity) and a colour. Then every
// output pixel looks up its cell and samples that cell's glyph.
//
// Glyphs come from a glyph atlas: alpha bitmaps of the characters in the chosen font, measured from the pen
// position on the baseline. In Photoshop the atlas is rendered with real text layers (any installed font),
// in the browser with a canvas, in Node with the tiny fallback font below.

const CHARSETS = [
  { id: "classic", name: "Classic", chars: " .:-=+*#%@" },
  { id: "detailed", name: "Detailed", chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  { id: "blocks", name: "Blocks", chars: " ░▒▓█" },
  { id: "dots", name: "Dots", chars: " .·•●" },
  { id: "lines", name: "Lines", chars: " .-~=+/|\\#" },
  { id: "binary", name: "Binary", chars: "01" },
  { id: "hex", name: "Hex", chars: "0123456789ABCDEF" },
  { id: "letters", name: "Letters", chars: " ilcoaxeswmWMB" },
  { id: "custom", name: "Own", chars: "" },
];
const CHAR_MODES = [
  { id: "ramp", name: "By brightness", tip: "Brightness picks the character – from light to dense" },
  { id: "text", name: "Your text", tip: "Your text runs through the grid; brightness sets size or opacity" },
  { id: "random", name: "Random", tip: "Random characters from the set; brightness sets size or opacity" },
];
const TONE_BY = [
  { id: "char", name: "Character" },
  { id: "size", name: "Size" },
  { id: "opacity", name: "Opacity" },
];
const COLOR_MODES = [
  { id: "ink", name: "One colour" },
  { id: "image", name: "From image" },
  { id: "gradient", name: "Gradient" },
];
// gradient palettes: shadows → mid → highlights
const PALETTES = [
  { id: "terminal", name: "Terminal", stops: ["#03140a", "#1f9e4a", "#b6ffcf"] },
  { id: "amber", name: "Amber", stops: ["#1a0d00", "#c96f00", "#ffd27a"] },
  { id: "ice", name: "Ice", stops: ["#06121f", "#2f7fd6", "#d9f3ff"] },
  { id: "sunset", name: "Sunset", stops: ["#2a0b3d", "#e5486b", "#ffd36b"] },
  { id: "vapor", name: "Vapor", stops: ["#2b0f54", "#ff4fd8", "#4ff4ff"] },
  { id: "fire", name: "Fire", stops: ["#220400", "#e8420c", "#fff07a"] },
  { id: "ink", name: "Ink", stops: ["#0d0d12", "#4b4d5c", "#e9e6df"] },
  { id: "toxic", name: "Toxic", stops: ["#0b1a00", "#7ad400", "#f4ff7a"] },
];
// one-click directions of the text flow (angle of the lines, clockwise in degrees)
const DIRECTIONS = [
  { id: "right", name: "→", angle: 0, tip: "Left to right" },
  { id: "down-right", name: "↘", angle: 45, tip: "Top left to bottom right" },
  { id: "down", name: "↓", angle: 90, tip: "Top to bottom" },
  { id: "down-left", name: "↙", angle: 135, tip: "Top right to bottom left" },
  { id: "left", name: "←", angle: 180, tip: "Right to left" },
  { id: "up-left", name: "↖", angle: -135, tip: "Bottom right to top left" },
  { id: "up", name: "↑", angle: -90, tip: "Bottom to top" },
  { id: "up-right", name: "↗", angle: -45, tip: "Bottom left to top right" },
];

const DEFAULTS = {
  charMode: "ramp",       // ramp | text | random
  charset: "classic",
  custom: " .oO@",        // own characters (charset "custom")
  text: "ASCII ",         // your text (charMode "text")
  sortDensity: true,      // order the characters by how much ink they have
  toneBy: "char",         // char | size | opacity
  font: "",               // PostScript name of the font ("" = a monospaced default)
  fontName: "",           // display name of the font
  cell: 12,               // cell height in px
  width: 60,              // cell width in % of the height
  glyphSize: 100,         // glyph size in % of the cell
  angle: 0,               // direction of the lines in degrees, clockwise
  upright: false,         // keep the characters upright when the grid is turned
  contrast: 0,            // -100 … 100
  brightness: 0,          // -100 … 100
  denseOn: "dark",        // dark | light – where the dense characters (and most ink) go
  threshold: 0,           // % – cells with less tone stay empty
  colorMode: "ink",       // ink | image | gradient
  ink: "#111111",
  palette: "terminal",
  grad1: "#03140a", grad2: "#1f9e4a", grad3: "#b6ffcf",
  saturation: 100,        // % (colour from image)
  background: "color",    // none | color
  bgColor: "#f2ede3",
  hideSource: true,       // hide the original layer (layer mode)
  seed: 1,
};
const LIMITS = {
  cell: [3, 120], width: [30, 200], glyphSize: [40, 200], angle: [-180, 180], contrast: [-100, 100],
  brightness: [-100, 100], threshold: [0, 95], saturation: [0, 200], seed: [1, 9999],
};
const CHOICES = {
  charMode: CHAR_MODES.map((m) => m.id), charset: CHARSETS.map((c) => c.id), toneBy: TONE_BY.map((t) => t.id),
  denseOn: ["dark", "light"], colorMode: COLOR_MODES.map((m) => m.id), palette: PALETTES.map((p) => p.id).concat(["own"]),
  background: ["none", "color"],
};
const HEX = /^#[0-9a-f]{6}$/i;

function sanitize(p) {
  const o = Object.assign({}, DEFAULTS);
  if (!p || typeof p !== "object") return o;
  for (const k of Object.keys(DEFAULTS)) {
    if (p[k] === undefined) continue;
    const d = DEFAULTS[k], v = p[k];
    if (typeof d === "number") {
      const n = Number(v);
      if (!isFinite(n)) continue;
      const L = LIMITS[k];
      o[k] = L ? Math.max(L[0], Math.min(L[1], n)) : n;
    } else if (typeof d === "boolean") o[k] = v === true || v === "true";
    else if (CHOICES[k]) { if (CHOICES[k].indexOf(String(v)) >= 0) o[k] = String(v); }
    else if (k === "ink" || k === "bgColor" || /^grad\d$/.test(k)) { if (HEX.test(String(v))) o[k] = String(v).toLowerCase(); }
    else o[k] = String(v).slice(0, k === "text" || k === "custom" ? 400 : 200);
  }
  if (o.charMode !== "ramp" && o.toneBy === "char") o.toneBy = "size";
  return o;
}

// Looks: complete settings. The font only applies when it is installed (main.js decides).
const LOOKS = [
  { id: "terminal", name: "Terminal", p: { charset: "classic", colorMode: "ink", ink: "#3dff7a", background: "color", bgColor: "#050806", denseOn: "light", cell: 12 } },
  { id: "paper", name: "Paper Print", p: { charset: "detailed", colorMode: "ink", ink: "#1b1a18", background: "color", bgColor: "#f2ede3", denseOn: "dark", cell: 10 } },
  { id: "fullcolour", name: "Full Colour", p: { charset: "detailed", colorMode: "image", saturation: 130, background: "color", bgColor: "#000000", denseOn: "light", cell: 10 } },
  { id: "blocks", name: "Pixel Blocks", p: { charset: "blocks", colorMode: "image", saturation: 115, background: "color", bgColor: "#0a0a0a", denseOn: "light", cell: 14, width: 60 } },
  { id: "amber", name: "Amber CRT", p: { charset: "classic", colorMode: "gradient", palette: "amber", background: "color", bgColor: "#120900", denseOn: "light", cell: 12 } },
  { id: "matrix", name: "Falling Code", p: { charMode: "random", charset: "binary", toneBy: "opacity", colorMode: "gradient", palette: "terminal", background: "color", bgColor: "#010401", denseOn: "light", cell: 14, angle: 90, upright: true } },
  { id: "binary", name: "Binary", p: { charMode: "random", charset: "binary", toneBy: "size", colorMode: "ink", ink: "#e9e6df", background: "color", bgColor: "#111216", denseOn: "light", cell: 12 } },
  { id: "typewriter", name: "Typewriter", p: { charMode: "text", text: "TYPE ", toneBy: "opacity", colorMode: "ink", ink: "#202020", background: "color", bgColor: "#efe8da", denseOn: "dark", cell: 11 } },
  { id: "halftone", name: "Dot Halftone", p: { charset: "dots", toneBy: "char", colorMode: "ink", ink: "#14141a", background: "color", bgColor: "#f4f1ea", denseOn: "dark", cell: 10, width: 100 } },
  { id: "vapor", name: "Vaporwave", p: { charset: "letters", colorMode: "gradient", palette: "vapor", background: "color", bgColor: "#140726", denseOn: "light", cell: 12, angle: -20 } },
  { id: "blueprint", name: "Blueprint", p: { charset: "lines", colorMode: "ink", ink: "#dce9ff", background: "color", bgColor: "#123a8c", denseOn: "light", cell: 11 } },
  { id: "diagonal", name: "Diagonal Type", p: { charMode: "text", text: "ASCII ", toneBy: "size", colorMode: "image", saturation: 120, background: "color", bgColor: "#0b0b0e", denseOn: "light", cell: 16, angle: -45 } },
];
function lookParams(id) {
  const l = LOOKS.find((x) => x.id === id);
  if (!l) return null;
  const p = Object.assign({}, DEFAULTS, l.p);
  if (l.p.palette) Object.assign(p, gradOf(l.p.palette));
  return sanitize(p);
}
function gradOf(paletteId) {
  const pal = PALETTES.find((x) => x.id === paletteId);
  return pal ? { grad1: pal.stops[0], grad2: pal.stops[1], grad3: pal.stops[2] } : {};
}

// the characters the settings use (unique, in order)
function charsOf(p) {
  let s;
  if (p.charMode === "text") s = p.text || "A";
  else if (p.charset === "custom") s = p.custom || " .oO@";
  else s = (CHARSETS.find((c) => c.id === p.charset) || CHARSETS[0]).chars;
  return Array.from(s);
}
function uniqueChars(list) { const seen = new Set(), out = []; for (const c of list) if (!seen.has(c)) { seen.add(c); out.push(c); } return out; }

function hexRgb(h) { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

// ---------------------------------------------------------------- glyphs
// atlas: { px, glyphs: { ch: { w, h, x0, y0, a } } } – x0/y0: top-left of the bitmap from the pen point on the
// baseline (y down). a: Uint8Array alpha. Characters without ink (space) have w = h = 0.
function coverage(g, emH) { if (!g || !g.w) return 0; let s = 0; for (let i = 0; i < g.a.length; i++) s += g.a[i]; return s / 255 / (emH * emH * 0.6); }

// the vertical extent of the font: ascent / descent measured from the drawn glyphs
function metricsOf(atlas, chars) {
  let asc = 0, desc = 0;
  for (const c of uniqueChars(chars.concat(["M", "g", "|", "█"]))) {
    const g = atlas.glyphs[c];
    if (!g || !g.w) continue;
    asc = Math.max(asc, -g.y0); desc = Math.max(desc, g.y0 + g.h);
  }
  if (asc <= 0) { asc = atlas.px * 0.75; desc = atlas.px * 0.25; }
  return { asc, desc };
}

// a glyph scaled to output pixels: area-averaged, so small cells stay clean. x / y: where the bitmap's
// top-left pixel sits relative to the pen point (output px).
function scaleGlyph(g, s) {
  const X0 = Math.floor(g.x0 * s) - 1, Y0 = Math.floor(g.y0 * s) - 1;
  const bw = Math.ceil(g.w * s) + 3, bh = Math.ceil(g.h * s) + 3;
  const acc = new Float32Array(bw * bh);
  for (let y = 0; y < g.h; y++) {
    const ty = Math.min(bh - 1, Math.floor(g.y0 * s + (y + 0.5) * s) - Y0);
    for (let x = 0; x < g.w; x++) {
      const v = g.a[y * g.w + x];
      if (v) acc[ty * bw + Math.min(bw - 1, Math.floor(g.x0 * s + (x + 0.5) * s) - X0)] += v;
    }
  }
  const k = s * s, out = new Uint8Array(bw * bh);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round(acc[i] * k));
  return { w: bw, h: bh, a: out, x: X0, y: Y0, inkW: g.w * s, inkX: g.x0 * s };
}
// prepared glyph set for a render: char list in tone order + scaled bitmaps, centred in a cell
function prepareGlyphs(atlas, p, cw, ch) {
  const chars = charsOf(p), uniq = uniqueChars(chars);
  const m = metricsOf(atlas, chars);
  const s = ch * (p.glyphSize / 100) / (m.asc + m.desc);
  const cov = {};
  for (const c of uniq) cov[c] = coverage(atlas.glyphs[c], atlas.px);
  let order = p.charMode === "ramp" ? uniq.slice() : chars.slice();
  if (p.charMode === "ramp" && p.sortDensity) order.sort((a, b) => cov[a] - cov[b]);
  const map = {}, list = [];
  for (const c of uniq) {
    const g = atlas.glyphs[c];
    if (!g || !g.w) { map[c] = -1; continue; }
    const sg = scaleGlyph(g, s);
    // centre the ink horizontally in the cell; baseline so that ascent + descent sit centred
    sg.cx = -(sg.inkX + sg.inkW / 2);
    sg.cy = -ch / 2 + (ch - (m.asc + m.desc) * s) / 2 + m.asc * s;   // cell-centre → baseline
    map[c] = list.length; list.push(sg);
  }
  return { order: order.map((c) => map[c]), list, scale: s };
}

// ---------------------------------------------------------------- render
// src: { w, h, rgba } – the picture. opts: { atlas, scale (preview: output px per document px), bgMask }
// returns Uint8Array RGBA (w × h)
function render(src, p, atlas, opts) {
  opts = opts || {};
  p = sanitize(p);
  const W = src.w, H = src.h, S = opts.scale || 1, px = src.rgba;
  const ch = Math.max(1, p.cell * S), cw = Math.max(1, ch * p.width / 100);
  const G = prepareGlyphs(atlas, p, cw, ch);
  const th = p.angle * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const ox = W / 2, oy = H / 2;
  // grid coordinates: u along the lines, v across them
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const dx = x - ox, dy = y - oy, u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
    u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v);
  }
  const cols = Math.max(1, Math.ceil((u1 - u0) / cw)), rows = Math.max(1, Math.ceil((v1 - v0) / ch));
  const N = cols * rows;
  const cGlyph = new Int32Array(N).fill(-1), cK = new Float32Array(N), cA = new Float32Array(N), cCol = new Uint8Array(N * 3);
  // --- cells: sample the picture
  const ns = Math.max(2, Math.min(5, Math.round(ch / 3)));
  const con = p.contrast >= 0 ? 1 + p.contrast / 40 : 1 + p.contrast / 110, bri = p.brightness / 200;
  const ink = hexRgb(p.ink), g1 = hexRgb(p.grad1), g2 = hexRgb(p.grad2), g3 = hexRgb(p.grad3);
  const thr = p.threshold / 100, sat = p.saturation / 100, nOrder = G.order.length;
  let seq = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const uc = u0 + (i + 0.5) * cw, vc = v0 + (j + 0.5) * ch;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < ns; sy++) for (let sx = 0; sx < ns; sx++) {
        const uu = uc + ((sx + 0.5) / ns - 0.5) * cw, vv = vc + ((sy + 0.5) / ns - 0.5) * ch;
        const x = Math.floor(ox + uu * cs - vv * sn), y = Math.floor(oy + uu * sn + vv * cs);
        n++;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const q = (y * W + x) * 4, al = px[q + 3];
        r += px[q] * al; g += px[q + 1] * al; b += px[q + 2] * al; a += al;
      }
      if (a < 255 * n * 0.06) continue;
      r /= a; g /= a; b /= a;
      const cover = a / (255 * n);
      let l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      l = Math.max(0, Math.min(1, (l - 0.5) * con + 0.5 + bri));
      let t = p.denseOn === "dark" ? 1 - l : l;
      t *= Math.min(1, cover * 1.15);
      if (t < thr || t <= 0.004) continue;
      const k = i + j * cols;
      // character
      let gi;
      if (p.charMode === "ramp") gi = G.order[Math.min(nOrder - 1, Math.round(t * (nOrder - 1)))];
      else if (p.charMode === "text") gi = G.order[seq++ % nOrder];
      else gi = G.order[Math.floor(hash(i, j, p.seed) * nOrder) % nOrder];
      if (gi < 0) continue;
      cGlyph[k] = gi;
      cK[k] = p.toneBy === "size" ? Math.sqrt(t) : 1;
      cA[k] = p.toneBy === "opacity" ? t : 1;
      // colour
      let cr, cg, cb;
      if (p.colorMode === "ink") { cr = ink[0]; cg = ink[1]; cb = ink[2]; }
      else if (p.colorMode === "image") {
        const m = (r + g + b) / 3;
        cr = m + (r - m) * sat; cg = m + (g - m) * sat; cb = m + (b - m) * sat;
      } else {
        const f = l < 0.5 ? l * 2 : (l - 0.5) * 2, A = l < 0.5 ? g1 : g2, B = l < 0.5 ? g2 : g3;
        cr = A[0] + (B[0] - A[0]) * f; cg = A[1] + (B[1] - A[1]) * f; cb = A[2] + (B[2] - A[2]) * f;
      }
      cCol[k * 3] = Math.max(0, Math.min(255, cr)); cCol[k * 3 + 1] = Math.max(0, Math.min(255, cg)); cCol[k * 3 + 2] = Math.max(0, Math.min(255, cb));
    }
  }
  // --- pixels: look up the cell and sample its glyph
  const out = new Uint8Array(W * H * 4);
  const bg = p.background === "color" ? hexRgb(p.bgColor) : null, bgMask = opts.bgMask;
  for (let y = 0; y < H; y++) {
    const dy = y + 0.5 - oy;
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - ox, u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
      const fi = (u - u0) / cw, fj = (v - v0) / ch, i = Math.floor(fi), j = Math.floor(fj);
      const o = (y * W + x) * 4;
      let ga = 0, k = -1;
      if (i >= 0 && j >= 0 && i < cols && j < rows) {
        k = i + j * cols;
        const gi = cGlyph[k];
        if (gi >= 0) {
          const sg = G.list[gi], kk = cK[k];
          let lx, ly;
          if (p.upright) {
            const uc = u0 + (i + 0.5) * cw, vc = v0 + (j + 0.5) * ch;
            lx = dx - (uc * cs - vc * sn); ly = dy - (uc * sn + vc * cs);
          } else { lx = (fi - i - 0.5) * cw; ly = (fj - j - 0.5) * ch; }
          // into the scaled glyph bitmap (pen point at cell centre + cx, baseline at cy)
          const gx = lx / kk - sg.cx - sg.x - 0.5, gy = ly / kk - sg.cy - sg.y - 0.5;
          ga = sampleA(sg, gx, gy) * cA[k];
        }
      }
      if (bg) {
        const ba = bgMask ? bgMask[y * W + x] / 255 : 1;
        if (ba <= 0 && ga <= 0) continue;
        const f = ga / 255;
        for (let c = 0; c < 3; c++) out[o + c] = bg[c] + ((k >= 0 ? cCol[k * 3 + c] : 0) - bg[c]) * f;
        out[o + 3] = Math.max(ba * 255, ga);
      } else if (ga > 0) {
        out[o] = cCol[k * 3]; out[o + 1] = cCol[k * 3 + 1]; out[o + 2] = cCol[k * 3 + 2]; out[o + 3] = ga;
      }
    }
  }
  return out;
}
// bilinear alpha lookup in a scaled glyph
function sampleA(sg, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  if (x0 < -1 || y0 < -1 || x0 >= sg.w || y0 >= sg.h) return 0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= sg.w || yy >= sg.h ? 0 : sg.a[yy * sg.w + xx]);
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// ---------------------------------------------------------------- fallback font
// A tiny 5 × 7 pixel font for tests in Node and when no font could be rendered: enough to see a result.
const MINI = {
  " ": [], ".": [0, 0, 0, 0, 0, 0, 4], ":": [0, 4, 0, 0, 0, 4, 0], "-": [0, 0, 0, 14, 0, 0, 0], "=": [0, 0, 31, 0, 31, 0, 0],
  "+": [0, 4, 4, 31, 4, 4, 0], "*": [0, 21, 14, 31, 14, 21, 0], "#": [10, 31, 10, 10, 31, 10, 0], "%": [25, 26, 2, 4, 11, 19, 0],
  "@": [14, 17, 23, 21, 23, 16, 14], "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "█": [31, 31, 31, 31, 31, 31, 31],
  "▓": [27, 31, 14, 31, 27, 31, 14], "▒": [21, 10, 21, 10, 21, 10, 21], "░": [17, 0, 4, 0, 17, 0, 4], "A": [14, 17, 17, 31, 17, 17, 17],
  "M": [17, 27, 21, 21, 17, 17, 17], "g": [0, 15, 17, 15, 1, 14, 0], "|": [4, 4, 4, 4, 4, 4, 4],
};
function miniAtlas(chars, px) {
  px = px || 70;
  const cell = px / 7, glyphs = {};
  for (const c of uniqueChars(chars.concat(["M", "g", "|"]))) {
    const rowsBits = MINI[c] || MINI["#"];
    if (c === " " || !rowsBits.length) { glyphs[c] = { w: 0, h: 0, x0: 0, y0: 0, a: new Uint8Array(0) }; continue; }
    const w = Math.round(5 * cell), h = Math.round(7 * cell), a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const bit = rowsBits[Math.min(6, Math.floor(y / cell))] >> (4 - Math.min(4, Math.floor(x / cell))) & 1;
      a[y * w + x] = bit ? 255 : 0;
    }
    glyphs[c] = { w, h, x0: 0, y0: -Math.round(6 * cell), a };
  }
  return { px, glyphs, mini: true };
}

module.exports = {
  CHARSETS, CHAR_MODES, TONE_BY, COLOR_MODES, PALETTES, DIRECTIONS, DEFAULTS, LIMITS, LOOKS,
  sanitize, lookParams, gradOf, charsOf, uniqueChars, metricsOf, prepareGlyphs, render, miniAtlas, coverage,
};
