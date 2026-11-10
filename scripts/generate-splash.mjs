import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const sizes = [
  [640, 1136], [750, 1334], [828, 1792], [1080, 2340],
  [1125, 2436], [1170, 2532], [1179, 2556], [1206, 2622],
  [1242, 2688], [1284, 2778], [1290, 2796], [1320, 2868],
];

const themes = [
  { name: "light", background: "#f4f1eb", halo: "#d7ebfb", card: "#fbfaf6", shadow: "#cbd9e3" },
  { name: "dark", background: "#101512", halo: "#153653", card: "#17211e", shadow: "#080b09" },
];

await mkdir(new URL("../public/splash/", import.meta.url), { recursive: true });

for (const [width, height] of sizes) {
  for (const theme of themes) {
    const scale = width / 1179;
    const logoSize = Math.round(150 * scale);
    const cardSize = Math.round(202 * scale);
    const gap = Math.max(5, Math.round(10 * scale));
    const padding = Math.round(23 * scale);
    const radius = Math.round(42 * scale);
    const tileRadius = Math.round(18 * scale);
    const cardX = Math.round((width - cardSize) / 2);
    const cardY = Math.round(height * 0.43 - cardSize / 2);
    const logoX = cardX + padding;
    const logoY = cardY + padding;
    const large = Math.round((logoSize - gap) * 0.58);
    const small = logoSize - gap - large;
    const svg = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="halo"><stop stop-color="${theme.halo}" stop-opacity=".75"/><stop offset="1" stop-color="${theme.halo}" stop-opacity="0"/></radialGradient>
          <filter id="shadow" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="${Math.round(18 * scale)}" stdDeviation="${Math.round(25 * scale)}" flood-color="${theme.shadow}" flood-opacity=".3"/></filter>
        </defs>
        <rect width="${width}" height="${height}" fill="${theme.background}"/>
        <circle cx="${Math.round(width / 2)}" cy="${Math.round(height * 0.43)}" r="${Math.round(330 * scale)}" fill="url(#halo)"/>
        <rect x="${cardX}" y="${cardY}" width="${cardSize}" height="${cardSize}" rx="${radius}" fill="${theme.card}" filter="url(#shadow)"/>
        <rect x="${logoX}" y="${logoY}" width="${large}" height="${large}" rx="${tileRadius}" fill="#2e9eff"/>
        <rect x="${logoX + large + gap}" y="${logoY}" width="${small}" height="${small}" rx="${tileRadius}" fill="#0c79d8"/>
        <rect x="${logoX}" y="${logoY + large + gap}" width="${small}" height="${small}" rx="${tileRadius}" fill="#0c79d8"/>
        <rect x="${logoX + small + gap}" y="${logoY + small + gap}" width="${large}" height="${large}" rx="${tileRadius}" fill="#68c4ff"/>
      </svg>`;
    const prefix = theme.name === "dark" ? "launch-dark" : "launch";
    const outputPath = fileURLToPath(new URL(`../public/splash/${prefix}-${width}x${height}.png`, import.meta.url));
    await sharp(Buffer.from(svg)).flatten({ background: theme.background }).png({ compressionLevel: 9 }).toFile(outputPath);
  }
}

console.log(`[assets] generated ${sizes.length * themes.length} adaptive iPhone startup screens`);
