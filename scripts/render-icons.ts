// Renders every PNG icon in src/web/ui/public/ from icon.svg, once per accent
// preset: the favicon, the manifest's 192/512, the square apple-touch and the
// maskable. Run with `just icons` after changing icon.svg or ACCENTS; the
// renderer is fetched by npx, not a dependency.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ACCENTS, DEFAULT_ACCENT, ICON_PLATE } from "../src/settings.ts";

// npx puts its install on PATH, not on this file's resolution path: resolve
// the renderer from the `.bin` directory tsx itself was launched from.
const bin = process.env.PATH?.split(":").find((p) => p.includes("_npx"));
if (!bin) throw new Error("run via `just icons` (npx -p @resvg/resvg-js -p tsx)");
type ResvgCtor = new (svg: string, opts: { fitTo: { mode: "width"; value: number } }) => { render(): { asPng(): Buffer } };
const { Resvg } = createRequire(bin + "/")("@resvg/resvg-js") as { Resvg: ResvgCtor };

const pub = new URL("../src/web/ui/public/", import.meta.url);
const svg = readFileSync(new URL("icon.svg", pub), "utf8");
const squircle = new RegExp(`<path fill="${ICON_PLATE}"\\s+d="[^"]+" />`);
if (!squircle.test(svg)) throw new Error(`icon.svg has no plate at ${ICON_PLATE}`);

const render = (markup: string, size: number): Buffer =>
  new Resvg(markup, { fitTo: { mode: "width", value: size } }).render().asPng();
const write = (name: string, png: Buffer): void => writeFileSync(new URL(name, pub), png);

for (const [name, hex] of Object.entries(ACCENTS)) {
  const suffix = name === DEFAULT_ACCENT ? "" : `-${name}`;
  const plated = svg.replace(`fill="${ICON_PLATE}"`, `fill="${hex}"`);
  write(`icon-32${suffix}.png`, render(plated, 32));
  write(`icon-192${suffix}.png`, render(plated, 192));
  write(`icon-512${suffix}.png`, render(plated, 512));
  // Platforms that apply their own mask get a full-bleed square, not the squircle.
  const square = svg.replace(squircle, `<rect width="64" height="64" fill="${hex}" />`);
  write(`icon-touch-192${suffix}.png`, render(square, 192));
  // The mark at 0.9: the largest scale whose bounding box clears the 80% safe circle.
  const maskable = square
    .replace(/(<rect [^>]*\/>)/, '$1<g transform="translate(32 32) scale(0.9) translate(-32 -32)">')
    .replace("</svg>", "</g></svg>");
  write(`icon-maskable-512${suffix}.png`, render(maskable, 512));
}
console.log(`rendered ${Object.keys(ACCENTS).length * 5} icons`);
