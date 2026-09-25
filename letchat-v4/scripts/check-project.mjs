import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const required = [
  "server.js", "public/app.js", "public/index.html", "public/style.css",
  "public/v3-modern.css", "public/v3-theme.js", "public/service-worker.js",
  "public/manifest.webmanifest"
];
for (const file of required) {
  if (!existsSync(file)) throw new Error(`Fichier obligatoire manquant : ${file}`);
}

for (const file of ["server.js", "public/app.js", "public/v3-theme.js", "public/service-worker.js"]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const html = readFileSync("public/index.html", "utf8");
const app = readFileSync("public/app.js", "utf8");
const server = readFileSync("server.js", "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Identifiants HTML dupliqués : ${[...new Set(duplicates)].join(", ")}`);

const dynamicIds = new Set(["adminProfileSearch", "adminProfileSearchButton", "adminProfilesResults"]);
const htmlIds = new Set(ids);
const referencedIds = [...app.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map(match => match[1]);
const missing = [...new Set(referencedIds.filter(id => !htmlIds.has(id) && !dynamicIds.has(id)))];
if (missing.length) throw new Error(`Éléments HTML manquants : ${missing.join(", ")}`);

for (const [label, source] of [["client", app], ["serveur", server]]) {
  if (/\b(?:sk_live|rk_live|whsec)_[A-Za-z0-9]+/.test(source)) {
    throw new Error(`Secret Stripe détecté dans le ${label}`);
  }
}

const css = readFileSync("public/v3-modern.css", "utf8");
const balance = [...css].reduce((count, character) => count + (character === "{" ? 1 : character === "}" ? -1 : 0), 0);
if (balance !== 0) throw new Error("Accolades CSS déséquilibrées");

console.log(`Contrôles réussis : ${required.length} fichiers, ${ids.length} identifiants HTML, syntaxe JS et CSS valides.`);
