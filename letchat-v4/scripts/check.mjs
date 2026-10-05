import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const files = ["server.js", "public/app-v4-cafe-v2.js", "public/room-catalog.js", "public/v4-interface.js", "public/refonte.js", "public/v3-theme.js", "public/service-worker.js", "public/adsense-public.js", "public/discovery-page.js", "public/social.js", "public/social-live.js", "public/social-voice.js", "public/social-album.js"];
files.push("public/premium-benefits.js", "public/surprise.js", "public/interests.js", "public/community.js", "public/city-search.js", "public/city-autocomplete.js", "public/welcome.js", "public/admin.js", "public/v3-tools.js", "public/spaces.js");
for (const dir of ["lib", "scripts"]) for (const name of await readdir(dir)) if (/\.(js|mjs)$/.test(name)) files.push(`${dir}/${name}`);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`${files.length} JavaScript files checked.`);
