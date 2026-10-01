import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const hash = content => createHash("sha256").update(content).digest("hex").slice(0, 12);
await mkdir("public/assets", { recursive: true });
const built = new Map();
const interfaceStyles = ['style.css','v3-modern.css','v2-community.css','v4-polish.css','audit-fixes.css','premium-benefits.css','social.css','surprise.css','city-autocomplete.css','welcome.css','admin.css','community.css','v3-experience.css'];
const styles = await Promise.all(interfaceStyles.map(async name => `/* Component: ${name} */\n${await readFile(`public/${name}`, 'utf8')}`));
await writeFile('public/interface.css', styles.join('\n'));

async function build(name) {
  name = name.split("?")[0].replace(/^\//, "");
  if (built.has(name)) return built.get(name);
  if (!/^[\w.-]+\.(?:js|css|svg|ico|png)$/.test(name)) throw new Error(`Unexpected asset: ${name}`);
  let content = await readFile(`public/${name}`);
  if (name.endsWith(".js")) {
    let code = content.toString();
    for (const match of [...code.matchAll(/from\s+["']\.\/([\w.-]+\.js)(?:\?[^"']*)?["']/g)]) {
      const output = await build(match[1]);
      code = code.replace(match[0], `from "./${path.basename(output)}"`);
    }
    content = Buffer.from(code);
  }
  const ext = path.extname(name), out = `assets/${name.slice(0, -ext.length)}.${hash(content)}${ext}`;
  await writeFile(`public/${out}`, content); built.set(name, out); return out;
}
let html = await readFile("templates/index.html", "utf8");
let insertedStyles = false;
html = html.replace(/<link rel="stylesheet" href="([^"?]+)(?:\?[^" ]*)?"\s*\/?\s*>/g, (tag, name) => {
  if (!interfaceStyles.includes(name)) return tag;
  if (insertedStyles) return '';
  insertedStyles = true; return '<link rel="stylesheet" href="interface.css">';
});
for (const match of [...html.matchAll(/(?:src|href)="(\/?[\w.-]+\.(?:js|css|svg|ico|png)(?:\?[^" ]*)?)"/g)]) {
  const output = await build(match[1]);
  html = html.replace(match[0], match[0].replace(match[1], `/${output}`));
}
html = html.replace(/[ \t]+$/gm, '');
await writeFile("public/index.html", html);
const shell = ["/", "/index.html", ...[...built.values()].map(v => `/${v}`), "/manifest.webmanifest", "/icon.svg"];
let sw = await readFile("templates/service-worker.js", "utf8");
sw = `const CACHE = "letchat-shell-${hash(html)}";\nconst SHELL = ${JSON.stringify(shell)};\n${sw}`;
await writeFile("public/service-worker.js", sw);
console.log(`Built ${built.size} fingerprinted public assets.`);
