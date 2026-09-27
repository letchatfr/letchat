import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { rooms } from "../public/room-catalog.js";

test("client initializes against the delivered HTML and recovery dialogs are reachable", async () => {
  const html = await readFile("public/index.html", "utf8");
  const dom = new JSDOM(html, { url:"https://www.letchat.fr", runScripts:"outside-only", pretendToBeVisual:true });
  const w=dom.window;
  try {
    const selectors = [...w.document.querySelectorAll("[id]")].map(e=>e.id);
    assert.equal(new Set(selectors).size,selectors.length,"HTML IDs must remain unique");
    w.rooms=rooms;
    w.initializeApp=()=>({});w.getAuth=()=>({currentUser:null});
    w.GoogleAuthProvider=class {setCustomParameters(){}};
    w.onAuthStateChanged=()=>()=>{};w.getRedirectResult=()=>Promise.resolve();
    w.setPersistence=()=>Promise.resolve();w.browserLocalPersistence={};w.signOut=()=>Promise.resolve();
    w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
    w.fetch=async()=>({ok:true,json:async()=>({contactEmail:"letchat@letchat.fr",premiumConfigured:false})});
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
    w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event("close"))};
    let code=await readFile("public/app-v4-cafe-v2.js","utf8");
    code=code.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gm,"");
    const socialModules = await Promise.all(["social-voice.js", "social-live.js", "social-album.js", "social.js", "premium-benefits.js", "surprise.js"].map(file => readFile(`public/${file}`, "utf8")));
    const socialCode = socialModules.map(source => source.replace(/^import\s+.*?;\s*$/gm, "").replace(/^export\s+/gm, "")).join("\n");
    w.eval(socialCode + "\n" + code);
    w.document.querySelector("#forgotPassword").click();
    assert.equal(w.document.querySelector("#recoverDialog").open,true);
    w.document.querySelector('[data-close-dialog="recoverDialog"]').click();
    assert.equal(w.document.querySelector("#recoverDialog").open,false);
    assert.equal(w.document.querySelectorAll("[onclick]").length,0,"CSP-blocked inline handlers removed");
    assert.ok(w.document.querySelector("#googleRedirect").onclick,"Google redirect fallback is bound");
    assert.ok(w.document.querySelector("#recoverForm").onsubmit,"password recovery form is bound");
    assert.ok(w.document.querySelector("#recoverySettingsForm").onsubmit,"recovery rotation form is bound");
    assert.equal(code.includes("?t=${encodeURIComponent(token)}"),false);
  } finally { w.close(); }
});
