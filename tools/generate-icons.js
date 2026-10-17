/* Regenerates every PWA icon + iOS splash image from the SVG sources below.
   Dev-only helper (needs `npm i --no-save sharp`); the generated PNGs are committed in public/icons and public/splash. */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, "..", "public");

// Diya mark (same shape as the in-app sprite), drawn on a 512 canvas.
// `scale` shrinks the artwork so maskable icons keep it inside the safe zone.
function mark(scale = 1, flame = "#ffb74d", bowl = "#ffffff") {
  const s = 512 / 32 * 19 * scale;               // 15 units of the 32-unit glyph box → artwork size
  const k = s / 32;
  const tx = (512 - 32 * k) / 2, ty = (512 - 32 * k) / 2 + 6 * scale;
  return `<g transform="translate(${tx} ${ty}) scale(${k})">
    <path d="M16 3c2.6 3 4 5.2 4 7.6A4 4 0 0 1 16 14.5a4 4 0 0 1-4-3.9C12 8.2 13.4 6 16 3z" fill="${flame}"/>
    <path d="M4 18h24c0 5.2-4.7 9-12 9S4 23.2 4 18z" fill="${bowl}"/>
  </g>`;
}
const bg = (r) => `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f8a83"/><stop offset="1" stop-color="#053a37"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".42" r=".5"><stop offset="0" stop-color="#ffb74d" stop-opacity=".28"/><stop offset="1" stop-color="#ffb74d" stop-opacity="0"/></radialGradient></defs>
  <rect width="512" height="512" rx="${r}" fill="url(#g)"/><rect width="512" height="512" rx="${r}" fill="url(#glow)"/>`;
const svg = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${inner}</svg>`);

const iconAny = svg(bg(112) + mark(1.0));          // rounded, for "any"
const iconFull = svg(bg(0) + mark(1.0));           // square, no transparency (apple-touch)
const iconMask = svg(bg(0) + mark(0.78));          // maskable: artwork inside the central 80% safe zone
const monochrome = svg(`<rect width="512" height="512" fill="none"/>` + mark(0.9, "#000", "#000"));

async function png(buf, size, file) {
  await sharp(buf, { density: 300 }).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(out, file));
}
async function splash(w, h, file) {
  const iconSize = Math.round(Math.min(w, h) * 0.26);
  const icon = await sharp(iconAny, { density: 300 }).resize(iconSize, iconSize).png().toBuffer();
  const fs1 = Math.round(Math.min(w, h) * 0.045);
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${Math.round(fs1 * 3)}">
    <text x="50%" y="${fs1 * 1.3}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${fs1}" fill="#e3f3f0">Navaratri Pass Tracker</text></svg>`);
  const bgSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4a46"/><stop offset="1" stop-color="#041f1d"/></linearGradient>
    <radialGradient id="r" cx=".5" cy=".42" r=".55"><stop offset="0" stop-color="#ffb74d" stop-opacity=".16"/><stop offset="1" stop-color="#ffb74d" stop-opacity="0"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/></svg>`);
  const top = Math.round(h / 2 - iconSize / 2 - fs1);
  await sharp(bgSvg).composite([
    { input: icon, left: Math.round((w - iconSize) / 2), top },
    { input: label, left: 0, top: top + iconSize + Math.round(fs1 * 0.8) }
  ]).png({ compressionLevel: 9 }).toFile(path.join(out, "splash", file));
}

(async () => {
  fs.mkdirSync(path.join(out, "icons"), { recursive: true });
  fs.mkdirSync(path.join(out, "splash"), { recursive: true });
  fs.writeFileSync(path.join(out, "icons", "icon.svg"), iconAny);
  fs.writeFileSync(path.join(out, "icons", "favicon.svg"), iconAny);
  for (const s of [48, 72, 96, 128, 144, 192, 256, 384, 512]) await png(iconAny, s, `icons/icon-${s}.png`);
  for (const s of [192, 512]) await png(iconMask, s, `icons/maskable-${s}.png`);
  await png(monochrome, 512, "icons/monochrome-512.png");
  await png(iconFull, 180, "icons/apple-touch-icon.png");
  await png(iconFull, 167, "icons/apple-touch-icon-167.png");
  await png(iconFull, 152, "icons/apple-touch-icon-152.png");
  await png(iconAny, 32, "icons/favicon-32.png");
  await png(iconAny, 16, "icons/favicon-16.png");
  await png(iconAny, 96, "icons/shortcut-96.png");
  const sizes = [[1320,2868],[1206,2622],[1290,2796],[1179,2556],[1284,2778],[1170,2532],[1125,2436],[1242,2688],[828,1792],[1242,2208],[750,1334],[640,1136],[2048,2732],[1668,2388],[1668,2224],[1640,2360],[1620,2160],[1536,2048]];
  for (const [w, h] of sizes) await splash(w, h, `splash-${w}x${h}.png`);
  console.log("done");
})();
