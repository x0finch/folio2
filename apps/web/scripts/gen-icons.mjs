// PWA 图标生成(一次性,构建期工具,绝不进 Workers 运行时)。
// 从 public/icon.svg 的 Folio 折页标(白底黑标,42×42)产出可安装 App 图标:
//   pwa-192 / pwa-512(purpose any)、pwa-maskable-512(留安全边)、apple-touch-icon-180(实底)。
// 品牌标设计成白底上看(黑路径在上带镂空,白矩形在下),故图标一律白方底 + 标居中留边。
// 改品牌图 = 改下面的 LOGO_PATHS(取自 icon.svg)后重跑:`pnpm --filter @folio/web gen:icons`。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");

// icon.svg 的三条路径(viewBox 0 0 42 42),按原序:白矩形、白矩形、黑折页标(在上、带镂空)。
const LOGO_PATHS = [
  {
    fill: "white",
    d: "M10 12C10 10.8954 10.8954 10 12 10H19C20.1046 10 21 10.8954 21 12V30C21 31.1046 20.1046 32 19 32H12C10.8954 32 10 31.1046 10 30V12Z",
  },
  {
    fill: "white",
    d: "M19 12C19 10.8954 19.8954 10 21 10H30C31.1046 10 32 10.8954 32 12V20C32 21.1046 31.1046 22 30 22H21C19.8954 22 19 21.1046 19 20V12Z",
  },
  {
    fill: "black",
    d: "M31.5344 9.76309V0.822987C31.5344 0.43789 31.2222 0.126465 30.8379 0.126465H11.1622C10.777 0.126465 10.4647 0.438727 10.4655 0.823824L10.4747 10.2813C10.4747 10.4663 10.401 10.6446 10.2704 10.7752L0.330827 20.694C0.200208 20.8246 0.126526 21.0021 0.126526 21.1871V41.1769C0.126526 41.562 0.438839 41.8735 0.823159 41.8735H10.4446C10.6296 41.8735 10.8063 41.7998 10.9369 41.6693L20.879 31.7287C21.0097 31.5981 21.1871 31.5245 21.3714 31.5245H31.1294C31.3143 31.5245 31.4909 31.4506 31.6217 31.3201L41.6683 21.275C41.7989 21.1444 41.8728 20.9669 41.8728 20.7827V11.1561C41.8728 10.771 41.5603 10.4596 41.176 10.4596H32.2312C31.8459 10.4596 31.5344 10.1474 31.5344 9.76309ZM10.854 30.4538V11.5362C10.854 11.1511 11.1663 10.8397 11.5507 10.8397H30.488C30.8731 10.8397 31.1845 11.1519 31.1845 11.5362V20.108C31.1845 20.4922 30.8731 20.8045 30.4887 20.8045L21.5062 20.8129C21.1218 20.8129 20.8104 21.1251 20.8104 21.5094V30.4538C20.8104 30.8388 20.4981 31.1503 20.1137 31.1503H11.5515C11.1663 31.1503 10.8549 30.8378 10.8549 30.4538H10.854Z",
  },
];

const LOGO_BOX = 42; // icon.svg viewBox 边长

// 白方底 + 标居中留边的 SVG 字符串。pad = 单边留白占比(maskable 需更大以进安全区)。
function iconSvg(size, pad) {
  const inner = size * (1 - pad * 2);
  const scale = inner / LOGO_BOX;
  const offset = size * pad;
  const paths = LOGO_PATHS.map((p) => `<path d="${p.d}" fill="${p.fill}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">${paths}</g>` +
    `</svg>`
  );
}

async function render(name, size, pad) {
  const svg = iconSvg(size, pad);
  await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size)
    .png()
    .toFile(join(PUBLIC, name));
  console.log(`  ${name}  ${size}×${size}  pad=${pad}`);
}

console.log("gen-icons → public/");
await render("pwa-192.png", 192, 0.16);
await render("pwa-512.png", 512, 0.16);
await render("pwa-maskable-512.png", 512, 0.22); // maskable 安全区:标在中央 80% 内
await render("apple-touch-icon.png", 180, 0.16); // iOS 自带圆角,实底即可
console.log("done");
