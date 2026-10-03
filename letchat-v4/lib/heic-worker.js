// Keep the HEIC decoder off the web event loop and bound its lifetime in the parent.
import convert from "heic-convert";
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
const [input, output] = process.argv.slice(2);
const jpeg = await convert({ buffer: await readFile(input), format: "JPEG", quality: 0.9 });
const webp = await sharp(Buffer.from(jpeg), { limitInputPixels: 40e6, failOn: "warning" })
  .rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
if (webp.length > 8e6) throw new Error("Image too large");
await writeFile(output, webp, { mode: 0o600 });
