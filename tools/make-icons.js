// Creates the plugin icons: a small grid of characters that grow from light to dense.
const fs = require("fs"), path = require("path");
const { encodePNG } = require("./png.js");
const dir = path.join(__dirname, "..", "ascii", "icons");
fs.mkdirSync(dir, { recursive: true });
function icon(size, file) {
  const rgba = new Uint8Array(size * size * 4), n = 3, cell = size / n;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = Math.floor(x / cell), j = Math.floor(y / cell);
    const t = (i + j) / (2 * (n - 1));                     // 0 top left … 1 bottom right
    const cx = (i + 0.5) * cell, cy = (j + 0.5) * cell, r = cell * (0.12 + 0.3 * t);
    const d = Math.max(Math.abs(x + 0.5 - cx), Math.abs(y + 0.5 - cy) * 0.8);
    const a = Math.max(0, Math.min(1, (r - d) + 0.5));
    const k = (y * size + x) * 4;
    rgba[k] = rgba[k + 1] = rgba[k + 2] = 225; rgba[k + 3] = a * 255;
  }
  fs.writeFileSync(path.join(dir, file), encodePNG(size, size, rgba, 4));
}
icon(23, "icon@1x.png"); icon(46, "icon@2x.png"); icon(48, "plugin@1x.png"); icon(96, "plugin@2x.png");
console.log("icons written:", fs.readdirSync(dir).join(", "));
