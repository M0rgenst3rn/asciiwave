// Shows the panel UI in a browser (without Photoshop): Photoshop/UXP are mocked.
// Open ui-preview.html through a local web server; it names the plugin folder in data-plugin (e.g. "../ascii/").
// The mock has a small document with a picture layer; glyphs are drawn with a canvas instead of text layers.
// ?doc=document starts in "Whole document" mode, ?img=<url> uses your own picture.
const SCRIPT_END = "</" + "script>";
const f = document.getElementById("frame");
const base = f.getAttribute("data-plugin");
(async () => {
  const get = async (p) => (await fetch(base + p)).text();
  const html = await get("index.html");
  const main = await get("main.js");
  const mods = {};
  const scan = async (src) => {
    for (const m of src.matchAll(/require\("\.\/([^"]+)"\)/g)) {
      if (mods[m[1]] !== undefined) continue;
      mods[m[1]] = "";
      mods[m[1]] = await get(m[1]);
      await scan(mods[m[1]]);
    }
  };
  await scan(main);
  const q = new URLSearchParams(location.search);
  if (q.get("doc") === "document") localStorage.setItem("asciiwave.source.v1", JSON.stringify("document"));
  const defs = Object.keys(mods).map((n) => `window.__defs[${JSON.stringify(n)}] = function (module, exports, require) {\n${mods[n]}\n};`).join("\n");
  const stub = "<script>" + `
  window.__defs = {}; window.__cache = {};
  ` + defs + `
  // ---- a small document: one picture layer
  const W = 900, H = 600, art = document.createElement("canvas"); art.width = W; art.height = H;
  (function draw() {
    const x = art.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#1b2a6b"); g.addColorStop(0.55, "#d9487a"); g.addColorStop(1, "#ffd36b");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const r = x.createRadialGradient(330, 300, 20, 330, 300, 210); r.addColorStop(0, "#fff6e0"); r.addColorStop(0.6, "#f7a35c"); r.addColorStop(1, "rgba(247,163,92,0)");
    x.fillStyle = r; x.beginPath(); x.arc(330, 300, 210, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#0d0f1e"; x.beginPath(); x.moveTo(0, 470); x.lineTo(180, 360); x.lineTo(320, 440); x.lineTo(520, 300); x.lineTo(700, 420); x.lineTo(900, 340); x.lineTo(900, 600); x.lineTo(0, 600); x.fill();
  })();
  const userImg = ${JSON.stringify(q.get("img") || "")};
  const imgData = (buf, w, h, c) => ({ width: w, height: h, components: c, componentSize: 8, getData: async () => buf, dispose: () => {} });
  const layer = { id: 2, name: "Sunset", kind: "pixel", visible: true, bounds: { left: 0, top: 0, right: W, bottom: H }, boundsNoEffects: { left: 0, top: 0, right: W, bottom: H } };
  const doc = { id: 1, name: "Poster.psd", title: "Poster.psd", width: W, height: H, resolution: 72, mode: "RGBColorMode", bitsPerChannel: "bitDepth8", layers: [layer], activeLayers: [layer] };
  const families = [["Courier New", "CourierNewPSMT"], ["DejaVu Sans Mono", "DejaVuSansMono"], ["Liberation Mono", "LiberationMono"], ["Archivo Black", "ArchivoBlack-Regular"], ["Inter", "Inter-Regular"], ["Inter", "Inter-Bold", "Bold"], ["DejaVu Serif", "DejaVuSerif"], ["Liberation Serif", "LiberationSerif"]];
  const fake = {
    app: { activeDocument: doc, documents: [doc], version: "test", fonts: families.map(([fam, ps, st]) => ({ name: fam + (st ? " " + st : ""), postScriptName: ps, family: fam, style: st || "Regular" })) },
    core: { executeAsModal: async (fn) => fn({ hostControl: { suspendHistory: async () => 1, resumeHistory: async () => {} } }) },
    action: { batchPlay: async () => [{}], addNotificationListener: () => {} }, constants: { ElementPlacement: {} },
    imaging: {
      createImageDataFromBuffer: async (buf, o) => imgData(buf, o.width, o.height, o.components),
      encodeImageData: async ({ imageData: d }) => {
        const c = document.createElement("canvas"); c.width = d.width; c.height = d.height;
        const g = c.getContext("2d"), id = g.createImageData(d.width, d.height), src = await d.getData();
        for (let i = 0; i < d.width * d.height; i++) for (let k = 0; k < 4; k++) id.data[i * 4 + k] = k < 3 ? src[i * d.components + k] : (d.components === 4 ? src[i * 4 + 3] : 255);
        g.putImageData(id, 0, 0); return c.toDataURL("image/jpeg", 0.92).split(",")[1];
      },
      getPixels: async (o) => {
        const sb = o.sourceBounds || { left: 0, top: 0, right: W, bottom: H }, sw = sb.right - sb.left, sh = sb.bottom - sb.top;
        const tw = o.targetSize ? o.targetSize.width : sw, th = o.targetSize ? o.targetSize.height : sh;
        const c = document.createElement("canvas"); c.width = tw; c.height = th;
        const g = c.getContext("2d"); g.drawImage(art, sb.left, sb.top, sw, sh, 0, 0, tw, th);
        return { imageData: imgData(new Uint8Array(g.getImageData(0, 0, tw, th).data.buffer), tw, th, 4), sourceBounds: sb };
      },
    },
  };
  if (userImg) { const im = new Image(); im.onload = () => { const x = art.getContext("2d"); x.clearRect(0, 0, W, H); const k = Math.max(W / im.width, H / im.height); x.drawImage(im, (W - im.width * k) / 2, (H - im.height * k) / 2, im.width * k, im.height * k); }; im.src = userImg; }
  // glyphs with a canvas: alpha bitmap from the pen point on the baseline
  window.__canvasAtlas = (font, ch, px) => {
    const S = Math.ceil(px * 2.2), c = document.createElement("canvas"); c.width = S; c.height = S;
    const g = c.getContext("2d"); g.font = (/bold/i.test(font.style) ? "bold " : "") + px + "px '" + font.family + "', monospace"; g.fillStyle = "#000"; g.textBaseline = "alphabetic";
    const X = Math.round(px * 0.5), Y = Math.round(px * 1.4); g.fillText(ch, X, Y);
    const d = g.getImageData(0, 0, S, S).data;
    let x0 = S, y0 = S, x1 = -1, y1 = -1;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (d[(y * S + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    if (x1 < 0) return { w: 0, h: 0, x0: 0, y0: 0, a: new Uint8Array(0) };
    const w = x1 - x0 + 1, h = y1 - y0 + 1, a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = d[((y0 + y) * S + x0 + x) * 4 + 3];
    return { w, h, x0: x0 - X, y0: y0 - Y, a };
  };
  const uxp = { storage: { localFileSystem: { getDataFolder: async () => ({ createFile: async () => ({ write: async () => {} }), getEntry: async () => { throw 1; } }) } }, entrypoints: { setup: () => {} } };
  window.require = (n) => {
    if (n === "photoshop") return fake;
    if (n === "uxp") return uxp;
    const k = n.replace("./", "");
    if (window.__cache[k]) return window.__cache[k].exports;
    const module = { exports: {} }; window.__cache[k] = module;
    window.__defs[k](module, module.exports, window.require);
    return module.exports;
  };
  ` + SCRIPT_END;
  const page = html
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, h) => `<link rel="stylesheet" href="${base}${h}">`)
    .replace("</head>", () => stub + "</head>")
    .replace('<script src="main.js"></' + 'script>', () => "<script>" + main + SCRIPT_END);
  f.srcdoc = page;
})();
