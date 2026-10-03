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
    const socialModules = await Promise.all(["social-voice.js", "social-live.js", "social-album.js", "social.js", "premium-benefits.js", "interests.js", "surprise.js", "community.js"].map(file => readFile(`public/${file}`, "utf8")));
    const socialCode = socialModules.map(source => source.replace(/^import\s+.*?;\s*$/gm, "").replace(/^export\s+/gm, "")).join("\n");
    for (const [file, exported] of [["spaces.js", "installSpacesUI"], ["v3-tools.js", "installV3Tools"]]) {
      const source = (await readFile(`public/${file}`, "utf8")).replace(/^import.*;$/gm, "").replace(/^export /gm, "");
      w.eval(`{${source}\nwindow.${exported}=${exported};}`);
    }
    w.eval((await readFile("public/admin.js", "utf8")).replace(/^export /gm, "") + "\n" + socialCode + "\n" + code + `
      window.testAccount = {
        setUser(data) { user = localUser(data, "test-token"); localSessionToken = "test-token"; },
        openProfile,
        loadMessageMedia,
        async refusedPrivateSend() {
          currentPrivate = { id: "local:deleted-test", name: "Ancien membre" };
          privateHomeOpen = false;
          return send();
        }
      };
    `);
    w.document.querySelector("#forgotPassword").click();
    assert.equal(w.document.querySelector("#recoverDialog").open,true);
    w.document.querySelector('[data-close-dialog="recoverDialog"]').click();
    assert.equal(w.document.querySelector("#recoverDialog").open,false);
    assert.equal(w.document.querySelectorAll("[onclick]").length,0,"CSP-blocked inline handlers removed");
    assert.ok(w.document.querySelector("#googleRedirect").onclick,"Google redirect fallback is bound");
    assert.ok(w.document.querySelector("#recoverForm").onsubmit,"password recovery form is bound");
    assert.ok(w.document.querySelector("#recoverySettingsForm").onsubmit,"recovery rotation form is bound");
    assert.equal(code.includes("?t=${encodeURIComponent(token)}"),false);
    for (const id of ["recoverDialog", "recoverySettingsDialog", "recoveryCodeDialog"]) {
      const dialog = w.document.getElementById(id);
      assert.ok(w.document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent);
    }
    w.testAccount.setUser({id:"local:test",name:"Nouveau Nom",loginUsername:"Identifiant Original",guest:false});
    w.testAccount.openProfile({display_name:"Nouveau Nom",loginUsername:"Identifiant Original"});
    assert.equal(w.document.getElementById("profileName").value,"Nouveau Nom");
    assert.equal(w.document.getElementById("profileLoginUsername").value,"Identifiant Original");
    assert.equal(w.document.getElementById("profileLoginIdentity").hidden,false);
    let downloaded;
    w.URL.createObjectURL = blob => { downloaded = blob; return "blob:local-test"; };
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = () => {};
    w.fetch = async route => {
      assert.equal(route,"/api/account/recovery-code");
      return {ok:true,json:async()=>({recoveryCode:"RECOVERY-TEST",loginUsername:"Identifiant Original"})};
    };
    w.document.getElementById("recoveryCurrentPassword").value="password-test";
    await w.document.getElementById("recoverySettingsForm").onsubmit({preventDefault(){},submitter:{}});
    assert.equal(w.document.getElementById("recoveryCodeDialog").open,true);
    w.document.getElementById("downloadRecoveryCode").click();
    const fileText = await new Promise((resolve,reject)=>{
      const reader = new w.FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=reject; reader.readAsText(downloaded);
    });
    assert.match(fileText,/Identifiant de connexion : Identifiant Original/);
    assert.match(fileText,/Code : RECOVERY-TEST/);
    assert.equal(fileText.includes("Nouveau Nom"),false);
    w.testAccount.setUser({id:"local:test",name:"Expéditeur",loginUsername:"Expéditeur",guest:false});
    const input=w.document.getElementById("input");
    input.value="Brouillon à conserver après refus";
    const messageCount=w.document.getElementById("messages").children.length;
    w.fetch=async route=>{
      assert.equal(route,"/api/private");
      return {ok:false,status:404,json:async()=>({error:"Ce compte n’existe plus. Votre message n’a pas été envoyé."})};
    };
    await w.testAccount.refusedPrivateSend();
    assert.equal(input.value,"Brouillon à conserver après refus");
    assert.equal(w.document.getElementById("messages").children.length,messageCount);
    assert.equal(w.document.getElementById("send").disabled,false);
    assert.match(w.document.body.textContent,/Ce compte n’existe plus/);
    const video = w.document.createElement("video");
    video.dataset.mediaPath = "/api/media/legacy-video";
    w.document.getElementById("messages").append(video);
    const mediaRequests = [], revoked = [];
    w.URL.revokeObjectURL = url => revoked.push(url);
    w.URL.createObjectURL = () => `blob:media-${mediaRequests.length}`;
    w.fetch = async route => { mediaRequests.push(route); return { ok: true, blob: async () => new w.Blob(["video"]) }; };
    await w.testAccount.loadMessageMedia(video, "local:test");
    assert.equal(video.src, "blob:media-1");
    video.dispatchEvent(new w.Event("error"));
    for (let i = 0; i < 10 && video.src !== "blob:media-2"; i++) await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(mediaRequests, ["/api/media/legacy-video", "/api/media/legacy-video?compatible=1"]);
    assert.ok(revoked.includes("blob:media-1"));
    video.dispatchEvent(new w.Event("error"));
    assert.equal(video.isConnected, false);
    assert.equal(mediaRequests.length, 2, "failed playback does not create a conversion retry loop");
    assert.match(w.document.getElementById("messages").textContent, /ne peut pas être lu/);
    w.testAccount.setUser({id:"guest:test",name:"Invité",guest:true});
    w.testAccount.openProfile(null);
    assert.equal(w.document.getElementById("profileLoginIdentity").hidden,true);

  } finally { w.close(); }
});
