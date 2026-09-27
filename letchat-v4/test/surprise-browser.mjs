import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

export async function runSurpriseBrowserQA({ origin, users, request, check }) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(require.resolve("playwright", { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
  const custom = process.env.LETCHAT_CHROMIUM_MODULE ? (await import(process.env.LETCHAT_CHROMIUM_MODULE)).default : null;
  const browser = await chromium.launch({ headless: true, ...(custom ? {executablePath: await custom.executablePath()} : {}), args: [...(custom?.args || []).filter(a => !["--single-process", "--disable-web-security", "--allow-running-insecure-content"].includes(a)), "--no-sandbox"] });
  const pages = [], errors = [];
  const output = process.env.LETCHAT_QA_OUTPUT || "/tmp/letchat-surprise-qa";
  await mkdir(output, { recursive: true });
  const firebase = `export const initializeApp=()=>({}); export const getAuth=()=>({currentUser:null});
    export class GoogleAuthProvider {setCustomParameters(){}}; export const browserLocalPersistence={};
    export const setPersistence=async()=>{}; export const getRedirectResult=async()=>null;
    export const onAuthStateChanged=(a,cb)=>{setTimeout(()=>cb(null),0);return ()=>{}};
    export const signInWithPopup=async()=>{};export const signInWithRedirect=async()=>{};export const signOut=async()=>{};export const deleteUser=async()=>{};`;
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: i ? { width: 390, height: 844 } : { width: 1365, height: 900 }, serviceWorkers: "block" });
      const page = await context.newPage(); pages.push(page);
      page.on("pageerror", error => errors.push(error.message));
      await page.route("https://www.gstatic.com/firebasejs/**", route => route.fulfill({ status: 200, contentType: "text/javascript", body: firebase }));
      await page.addInitScript(({ token, theme }) => { localStorage.setItem("letchatLocalToken", token); localStorage.setItem("letchat-theme", theme); }, { token: users[i].token, theme: i ? "dark" : "light" });
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator(".social-toolbar").waitFor({ state: "visible" });
      if (await page.locator("#profileModal").isVisible()) await page.locator("#closeProfile").click();
      await page.waitForFunction(() => document.querySelector("#connectionStatus")?.dataset.state === "online");
    }
    const [a, b] = pages;
    await a.locator("#surpriseLink").click();
    await a.locator(".surprise-dialog").waitFor({ state: "visible" });
    check(await a.locator("[data-start]").isEnabled(), "desktop menu opens the voluntary search dialog");
    await a.screenshot({ path: output + "/desktop-start.png" });
    await a.locator("[data-start]").click();
    await a.locator(".surprise-status").filter({ hasText: "Recherche en cours" }).waitFor();
    check(await a.locator(".surprise-bar").isVisible(), "waiting state remains visible outside the dialog");
    check((await a.locator(".surprise-status").textContent()).includes("seule personne"), "waiting state explains that only one account is searching");
    await a.locator(".surprise-dialog [data-close]").click();
    await b.locator("#mobileNavRooms").click();
    await b.locator("#surpriseLink").click();
    await b.locator(".surprise-dialog").waitFor({ state: "visible" });
    await b.screenshot({ path: output + "/mobile-dark-start.png" });
    await b.locator("[data-start]").click();
    await a.locator(".surprise-bar [data-status]").filter({ hasText: users[1].user.name }).waitFor();
    await b.locator(".surprise-bar [data-status]").filter({ hasText: users[0].user.name }).waitFor();
    check(!await a.locator(".surprise-dialog").isVisible() && !await b.locator(".surprise-dialog").isVisible(), "match automatically opens private chat on both devices");
    await a.locator("#input").fill("Bonjour depuis la rencontre surprise !");
    await a.locator("#send").click();
    await b.locator("#messages").getByText("Bonjour depuis la rencontre surprise !", { exact: true }).waitFor();
    check(true, "two real browser sessions exchange a private message");
    for (const page of pages) {
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page has no horizontal overflow");
      for (const action of ["next", "leave", "block", "report"]) check(await page.locator(`.surprise-bar [data-${action}]`).isVisible(), `encounter control ${action} is visible`);
    }
    await a.screenshot({ path: output + "/desktop-matched.png" });
    await b.screenshot({ path: output + "/mobile-dark-matched.png" });
    for (let round=0; round<3; round++) {
      await a.locator(".surprise-bar [data-leave]").click();
      await a.locator(".surprise-bar").waitFor({state:"hidden"});
      await b.locator(".surprise-bar").waitFor({state:"hidden"});
      await a.locator("#surpriseLink").click();
      await a.locator("[data-start]").click();
      await b.locator("#mobileNavRooms").click();
      await b.locator("#surpriseLink").click();
      await b.locator("[data-start]").click();
      await a.locator(".surprise-bar [data-status]").filter({hasText:users[1].user.name}).waitFor();
      await b.locator(".surprise-bar [data-status]").filter({hasText:users[0].user.name}).waitFor();
      check(true,`same two browser accounts can start a new encounter immediately, round ${round+1}`);
    }
    await b.locator(".surprise-bar [data-report]").click();
    await b.locator("#reportModal").waitFor({ state: "visible" });
    check((await b.locator("#reportTarget").textContent()).includes(users[0].user.name), "report form targets the matched member");
    const reason = await b.locator("#reportReason option").evaluateAll(options => options.find(o => o.value)?.value);
    await b.locator("#reportReason").selectOption(reason);
    await b.locator("#reportDetails").fill("Vérification locale de Rencontre Surprise.");
    await b.locator("#reportForm button[type=submit]").click();
    await b.locator("#reportModal").waitFor({ state: "hidden" });
    check(true, "report can be submitted to existing moderation");
    b.once("dialog", d => d.accept());
    await b.locator(".surprise-bar [data-block]").click();
    await a.locator(".surprise-bar").waitFor({ state: "hidden" });
    await b.locator(".surprise-bar").waitFor({ state: "hidden" });
    check((await request(`/api/blocks`, users[1].token)).data.some(x => x.user_id === users[0].user.id), "mobile block is persisted and ends the encounter");
    await request(`/api/blocks/${users[0].user.id}`, users[1].token, "DELETE");
    await a.locator("#surpriseLink").click();
    await a.locator("[data-start]").click();
    await a.locator(".surprise-status").filter({ hasText: "Recherche en cours" }).waitFor();
    await a.locator(".surprise-dialog [data-stop]").click();
    await a.locator(".surprise-status").filter({ hasText: "quitté" }).waitFor();
    check(await a.locator("[data-start]").isVisible(), "cancel returns to a usable start state");
    check(errors.length === 0, `no browser JavaScript errors: ${errors.join("; ")}`);
  } finally { await browser.close(); }
}
