// Checks without Photoshop: settings, characters, grid, direction, colours, looks. Run: node tools/check.js
const Core = require("../ascii/core.js");
let bad = 0;
const check = (name, ok, extra) => { if (!ok) bad++; console.log((ok ? "ok   " : "FAIL ") + name + (extra !== undefined ? "  " + extra : "")); };
const pic = (w, h, fn) => { const rgba = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a] = fn(x, y); const i = (y * w + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a === undefined ? 255 : a; } return { w, h, rgba }; };
const ink = (out, x0, y0, x1, y1, w) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += out[(y * w + x) * 4 + 3]; return s / ((x1 - x0) * (y1 - y0) * 255); };
const atlasFor = (p) => Core.miniAtlas(Core.charsOf(Core.sanitize(p)));
const R = (src, p, o) => { p = Core.sanitize(p); return Core.render(src, p, atlasFor(p), o); };
const T = { background: "none" };

// settings
{ const s = Core.sanitize({ cell: 999, charMode: "x", ink: "red", angle: "45", toneBy: "char", text: "x".repeat(1000) });
  check("settings are clamped and checked", s.cell === 120 && s.charMode === "ramp" && s.ink === Core.DEFAULTS.ink && s.angle === 45 && s.text.length === 400); }
check("text / random mode can't tone by character", Core.sanitize({ charMode: "text", toneBy: "char" }).toneBy === "size");
// brightness → characters
{ const src = pic(200, 40, (x) => { const v = x < 100 ? 20 : 235; return [v, v, v]; });
  const out = R(src, Object.assign({ cell: 10, denseOn: "dark" }, T));
  const dark = ink(out, 0, 0, 100, 40, 200), light = ink(out, 100, 0, 200, 40, 200);
  check("dense on dark: more ink where the picture is dark", dark > light * 3, dark.toFixed(3) + " vs " + light.toFixed(3));
  const out2 = R(src, Object.assign({ cell: 10, denseOn: "light" }, T));
  check("dense on light: the other way round", ink(out2, 100, 0, 200, 40, 200) > ink(out2, 0, 0, 100, 40, 200) * 3); }
{ const p = Core.sanitize({ charset: "classic" }), A = atlasFor(p), G = Core.prepareGlyphs(A, p, 6, 10);
  const cov = G.order.map((gi) => (gi < 0 ? 0 : G.list[gi].a.reduce((s, v) => s + v, 0)));
  check("ramp is ordered from light to dense", cov.every((c, i) => !i || c >= cov[i - 1] - 1), cov.join()); }
// every character set renders
for (const cs of Core.CHARSETS) {
  const src = pic(120, 60, (x) => { const v = x * 2; return [v, v, v]; });
  const out = R(src, Object.assign({ charset: cs.id, custom: " .oO@", cell: 10 }, T));
  check("character set " + cs.name + " renders", ink(out, 0, 0, 120, 60, 120) > 0.02);
}
// your text runs through the grid in reading order
{ const p = Core.sanitize({ charMode: "text", text: "AM", toneBy: "opacity", cell: 10, width: 100, ...T });
  const A = Core.miniAtlas(["A", "M"]), src = pic(40, 10, () => [0, 0, 0]), out = Core.render(src, p, A);
  const col = (i) => { let s = ""; for (let y = 0; y < 10; y++) s += out[(y * 40 + i * 10 + 5) * 4 + 3] > 128 ? 1 : 0; return s; };
  check("your text repeats along the line: A M A M", col(0) === col(2) && col(1) === col(3) && col(0) !== col(1), [0, 1, 2, 3].map(col).join(" ")); }
// direction
{ const src = pic(60, 60, (x, y) => [x * 4, y * 4, 128]);
  const a = R(src, { cell: 10, angle: 0, ...T }), b = R(src, { cell: 10, angle: 90, ...T });
  let diff = 0; for (let i = 3; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
  check("angle 90° gives a different picture", diff > 1000);
  const c = R(src, { cell: 10, angle: 37, ...T }), d = R(src, { cell: 10, angle: 37, upright: true, ...T });
  let dd = 0; for (let i = 3; i < c.length; i += 4) dd += Math.abs(c[i] - d[i]);
  check("upright characters differ from turned ones", dd > 1000); }
{ const src = pic(80, 80, () => [10, 10, 10]);
  for (const ang of [0, 45, 90, 135, 180, -45, -90, -135]) {
    const out = R(src, { cell: 8, angle: ang, ...T }); const cov = ink(out, 0, 0, 80, 80, 80);
    if (!(cov > 0.1)) { check("angle " + ang + "° covers the whole picture", false, cov); }
  }
  check("every direction covers the whole picture", true); }
// colours and background
{ const src = pic(40, 20, () => [40, 40, 40]);
  const out = R(src, { cell: 10, colorMode: "ink", ink: "#ff0000", ...T });
  let red = true; for (let i = 0; i < out.length; i += 4) if (out[i + 3] > 200 && !(out[i] > 200 && out[i + 1] < 30)) red = false;
  check("one colour: ink in that colour", red);
  const bg = R(src, { cell: 10, background: "color", bgColor: "#00ff00" });
  check("background colour fills every pixel", bg.every((v, i) => i % 4 !== 3 || v === 255) && bg[1] > 0); }
{ const src = pic(60, 20, (x) => (x < 30 ? [255, 0, 0] : [0, 0, 255]));
  const out = R(src, { cell: 10, charset: "blocks", colorMode: "image", denseOn: "dark", ...T });
  let r = 0, b = 0; for (let i = 0; i < out.length; i += 4) if (out[i + 3] > 128) { if (out[i] > out[i + 2]) r++; else b++; }
  check("colour from image keeps the colours", r > 20 && b > 20, r + " / " + b); }
{ const p = { cell: 10, charset: "blocks", colorMode: "gradient", grad1: "#000000", grad2: "#ff0000", grad3: "#ffffff", denseOn: "light", ...T };
  const out = R(pic(60, 20, () => [128, 128, 128]), p);
  let ok = false; for (let i = 0; i < out.length; i += 4) if (out[i + 3] > 60 && out[i] > 200 && out[i + 1] < 60) ok = true;
  check("gradient: mid tones get the middle colour", ok); }
// threshold and transparent layers
{ const src = pic(60, 20, (x) => (x < 30 ? [0, 0, 0] : [200, 200, 200]));
  const out = R(src, { cell: 10, threshold: 50, ...T });
  check("leave empty below: light half stays empty", ink(out, 30, 0, 60, 20, 60) === 0 && ink(out, 0, 0, 30, 20, 60) > 0.05); }
{ const src = pic(60, 20, (x) => [0, 0, 0, x < 30 ? 255 : 0]), mask = new Uint8Array(60 * 20);
  for (let i = 0; i < mask.length; i++) mask[i] = src.rgba[i * 4 + 3];
  const out = Core.render(src, Core.sanitize({ cell: 10, background: "color" }), Core.miniAtlas(Core.charsOf(Core.DEFAULTS)), { bgMask: mask });
  check("selected layer: nothing outside the layer, background only on it", ink(out, 31, 0, 60, 20, 60) === 0 && ink(out, 0, 0, 29, 20, 60) > 0.9); }
// looks
for (const l of Core.LOOKS) {
  const p = Core.lookParams(l.id), out = R(pic(120, 72, (x, y) => [x * 2, y * 3, 120]), p);
  check("look " + l.name + " renders", ink(out, 0, 0, 120, 72, 120) > 0.05);
}
// speed
{ const src = pic(3000, 2000, (x, y) => [(x * 7) & 255, (y * 3) & 255, 128]), t0 = Date.now();
  R(src, { cell: 8, angle: 30, colorMode: "image" });
  const ms = Date.now() - t0; check("6 MP at 8 px cells and 30° in under 4 s", ms < 4000, ms + " ms"); }

console.log(bad ? bad + " FAILED" : "all ok");
process.exit(bad ? 1 : 0);
