// iOS 主屏启动图生成(一次性,构建期工具,绝不进 Workers 运行时)。
// 从单一源 splash-config.json(logoSize + iosDevices)按每种 iPhone 竖屏的精确像素尺寸产出
// 「folio 折页标居中在 #151515 深色底」的 PNG → public/splash/apple-splash-{pxW}x{pxH}.png。
// logo 尺寸取 config.logoSize(与冷启动闪屏覆盖层的静止 logo 一致 —— 静态→呼吸无缝交接)。
// 改机型清单 / logo 尺寸 = 改 splash-config.json 后重跑:`pnpm --filter @folio/web gen:splash`。
//
// 「多张」不是美术,是 iOS 的尺寸匹配规则:startup-image 的实际像素要与设备匹配才生效,对不上的
// 机型 iOS 忽略、自动降级成「纯深色 + logo」(接缝同底色看不出)。

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const OUT = join(PUBLIC, "splash");
const config = JSON.parse(
  readFileSync(join(HERE, "..", "src", "routes", "-root", "splash-config.json"), "utf8"),
);

// 底色 / logo 色取 splash-config.json 的单一来源(与覆盖层暗色态一致):启动图恒暗底,logo 用亮色。
// 与覆盖层的 `:root.dark #app-splash{background:colorDark;color:colorLight}` 同源 —— 静态→呼吸交接不差色。
const BG = config.colorDark;
const FG = config.colorLight;
const LOGO_BOX = 42; // icon.svg / logo.tsx 的 viewBox 边长
// folio 折页标(单路径,取自 logo.tsx 的 currentColor path)。
const FOLIO_PATH =
  "M31.5344 9.76309V0.822987C31.5344 0.43789 31.2222 0.126465 30.8379 0.126465H11.1622C10.777 0.126465 10.4647 0.438727 10.4655 0.823824L10.4747 10.2813C10.4747 10.4663 10.401 10.6446 10.2704 10.7752L0.330827 20.694C0.200208 20.8246 0.126526 21.0021 0.126526 21.1871V41.1769C0.126526 41.562 0.438839 41.8735 0.823159 41.8735H10.4446C10.6296 41.8735 10.8063 41.7998 10.9369 41.6693L20.879 31.7287C21.0097 31.5981 21.1871 31.5245 21.3714 31.5245H31.1294C31.3143 31.5245 31.4909 31.4506 31.6217 31.3201L41.6683 21.275C41.7989 21.1444 41.8728 20.9669 41.8728 20.7827V11.1561C41.8728 10.771 41.5603 10.4596 41.176 10.4596H32.2312C31.8459 10.4596 31.5344 10.1474 31.5344 9.76309ZM10.854 30.4538V11.5362C10.854 11.1511 11.1663 10.8397 11.5507 10.8397H30.488C30.8731 10.8397 31.1845 11.1519 31.1845 11.5362V20.108C31.1845 20.4922 30.8731 20.8045 30.4887 20.8045L21.5062 20.8129C21.1218 20.8129 20.8104 21.1251 20.8104 21.5094V30.4538C20.8104 30.8388 20.4981 31.1503 20.1137 31.1503H11.5515C11.1663 31.1503 10.8549 30.8378 10.8549 30.4538H10.854Z";

// 深色底 + logo 居中的 SVG(尺寸即输出像素;logo 在 SVG 空间里 scale 到 logoPx,矢量、清晰)。
function splashSvg(pxW, pxH, logoPx) {
  const scale = logoPx / LOGO_BOX;
  const offX = (pxW - logoPx) / 2;
  const offY = (pxH - logoPx) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="0 0 ${pxW} ${pxH}">` +
    `<rect width="${pxW}" height="${pxH}" fill="${BG}"/>` +
    `<g transform="translate(${offX} ${offY}) scale(${scale})"><path d="${FOLIO_PATH}" fill="${FG}"/></g>` +
    `</svg>`
  );
}

mkdirSync(OUT, { recursive: true });
console.log("gen-splash → public/splash/");
for (const { w, h, dpr } of config.iosDevices) {
  const pxW = w * dpr;
  const pxH = h * dpr;
  const logoPx = config.logoSize * dpr;
  const name = `apple-splash-${pxW}x${pxH}.png`;
  await sharp(Buffer.from(splashSvg(pxW, pxH, logoPx)))
    .png()
    .toFile(join(OUT, name));
  console.log(`  ${name}  ${pxW}×${pxH}  logo=${logoPx}`);
}
console.log("done");
