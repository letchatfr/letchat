import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { consentAllowsAds, createPublicAdvertising } from "../public/adsense-public.js";

const accepted = {
  cmpStatus: "loaded", eventStatus: "useractioncomplete", gdprApplies: true,
  purpose: { consents: { 1: true } }, vendor: { consents: { 755: true } }
};
const html = await readFile("templates/decouvrir.html", "utf8");

function setup(t, checkEligibility = async () => true, pathname = "/decouvrir.html") {
  const dom = new JSDOM(html, { url: `https://www.letchat.fr${pathname}` });
  const w = dom.window;
  const controller = createPublicAdvertising({ window: w, checkEligibility, nonce: "test-nonce" });
  t.after(() => { controller.stop(); w.close(); });
  let listener, revocations = 0;
  return {
    w, controller,
    ready() {
      w.__tcfapi = (command, version, callback) => {
        assert.equal(command, "addEventListener"); assert.equal(version, 2); listener = callback;
      };
      w.googlefc.showRevocationMessage = () => { revocations++; };
      const queued = [...w.googlefc.callbackQueue];
      w.googlefc.callbackQueue.push = item => item.CONSENT_API_READY();
      queued.forEach(item => item.CONSENT_API_READY());
    },
    emit(data = accepted, success = true) { listener(data, success); },
    get revocations() { return revocations; },
    get scripts() { return w.document.querySelectorAll('script[src*="pagead2.googlesyndication.com"]').length; },
    get ads() { return w.document.querySelectorAll("ins.adsbygoogle"); },
    get panel() { return w.document.getElementById("publicAdvertising"); }
  };
}

test("TCF failures, unknown scope, refusal and missing Google consent fail closed", () => {
  assert.equal(consentAllowsAds(accepted, true), true);
  for (const data of [null, {}, { ...accepted, cmpStatus: "error" },
    { ...accepted, gdprApplies: undefined }, { ...accepted, eventStatus: "cmpuishown" },
    { ...accepted, purpose: { consents: { 1: false } } },
    { ...accepted, vendor: { consents: { 755: false } } }]) {
    assert.equal(consentAllowsAds(data, true), false);
  }
  assert.equal(consentAllowsAds(accepted, false), false);
  assert.equal(consentAllowsAds({ ...accepted, gdprApplies: false }, true), true);
});

test("no ad request before consent; acceptance uses the correct slot once", async t => {
  const s = setup(t);
  await s.controller.start();
  assert.equal(s.scripts, 0);
  assert.ok(s.w.document.getElementById("letchatConsent"), "consent loader starts first");
  assert.equal(s.ads.length, 0);
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
  assert.equal(s.w.adsbygoogle.length, 0);
  assert.equal(s.w.document.getElementById("letchatConsent").nonce, "test-nonce");
  s.ready();
  s.emit({ ...accepted, purpose: { consents: {} } });
  assert.equal(s.ads.length, 0);
  s.emit(); s.emit();
  assert.equal(s.scripts, 1);
  const loader = s.w.document.getElementById("letchatAdSense");
  assert.equal(loader.nonce, "test-nonce");
  assert.equal(loader.dataset.privacyTreatments, "disablePersonalization");
  assert.equal(s.ads.length, 1);
  assert.equal(s.ads[0].dataset.adClient, "ca-pub-3317597986908171");
  assert.equal(s.ads[0].dataset.adSlot, "1411415827");
  assert.equal(s.w.adsbygoogle.length, 1);
  assert.equal(s.w.adsbygoogle[0].params.google_privacy_treatments, "disablePersonalization");
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 0);
});

test("Premium and subscription errors never load Google automatically", async t => {
  for (const eligibility of [async () => false, async () => { throw new Error("offline"); }]) {
    const s = setup(t, eligibility);
    await s.controller.start();
    assert.equal(s.scripts, 0);
    assert.equal(s.ads.length, 0);
    assert.equal(s.w.adsbygoogle, undefined);
  }
});

test("advertising controller cannot run on chat or legal pages", async t => {
  for (const pathname of ["/", "/index.html", "/confidentialite.html"]) {
    const s = setup(t, async () => { throw new Error("must not be called"); }, pathname);
    await s.controller.start();
    s.w.document.getElementById("manageConsent").click();
    assert.equal(s.scripts, 0); assert.equal(s.ads.length, 0);
  }
});

test("reopening consent removes ads immediately and stale consent cannot resume them", async t => {
  const s = setup(t); await s.controller.start(); s.ready(); s.emit();
  s.w.document.getElementById("manageConsent").click();
  assert.equal(s.revocations, 1);
  assert.equal(s.ads.length, 0);
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
  s.emit({ ...accepted, eventStatus: "tcloaded" });
  assert.equal(s.ads.length, 0);
  s.emit({ ...accepted, purpose: { consents: { 1: false } } });
  assert.equal(s.ads.length, 0);
  s.emit();
  assert.equal(s.w.adsbygoogle.length, 1, "never refreshes the previously consumed slot");
});

test("Premium member can explicitly reopen consent without receiving an ad", async t => {
  const s = setup(t, async () => false);
  await s.controller.start();
  s.w.document.getElementById("manageConsent").click();
  assert.equal(s.scripts, 0);
  assert.ok(s.w.document.getElementById("letchatConsent"));
  s.ready(); s.emit();
  assert.equal(s.scripts, 0, "Premium never loads the ad script");
  assert.equal(s.revocations, 1);
  assert.equal(s.ads.length, 0);
  assert.equal(s.w.adsbygoogle.length, 0);
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
});

test("missing Google message times out, releases the button and keeps ads paused", async t => {
  const s = setup(t); await s.controller.start(); s.ready();
  const timers = [];
  s.w.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  const button = s.w.document.getElementById("manageConsent");
  button.click(); button.click();
  assert.equal(s.revocations, 1, "double clicks cannot queue multiple Google messages");
  assert.equal(button.disabled, true);
  const timeout = timers.find(timer => timer.delay === 20000);
  assert.ok(timeout); timeout.callback();
  assert.equal(button.disabled, false);
  assert.match(s.w.document.getElementById("consentStatus").textContent, /n’est pas disponible/);
  s.emit({ ...accepted, eventStatus: "tcloaded" });
  assert.equal(s.ads.length, 0, "stale stored consent cannot resume ads after timeout");
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
  button.click(); assert.equal(s.revocations, 2, "retry is available");
});

test("Google dialog event clears loading and valid refusal keeps ads blocked", async t => {
  const s = setup(t); await s.controller.start(); s.ready();
  const button = s.w.document.getElementById("manageConsent");
  button.click();
  s.emit({ ...accepted, eventStatus: "cmpuishown" });
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute("aria-busy"), false);
  assert.match(s.w.document.getElementById("consentStatus").textContent, /Choisissez/);
  s.emit({ ...accepted, purpose: { consents: { 1: false } } });
  assert.equal(s.ads.length, 0);
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
});

test("a late Google API ignores expired attempts when the user retries", async t => {
  const s = setup(t); await s.controller.start();
  const timers = [];
  s.w.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  const button = s.w.document.getElementById("manageConsent");
  button.click();
  timers.find(timer => timer.delay === 20000).callback();
  button.click();
  s.ready();
  assert.equal(s.revocations, 1, "only the current attempt can open a dialog");
  assert.equal(s.ads.length, 0);
});

test("revocation exceptions and unavailable API do not leave the button busy", async t => {
  for (const handler of [undefined, () => { throw new Error("unavailable"); }]) {
    const s = setup(t); await s.controller.start(); s.ready();
    s.w.googlefc.showRevocationMessage = handler;
    const button = s.w.document.getElementById("manageConsent"); button.click();
    assert.equal(button.disabled, false);
    assert.match(s.w.document.getElementById("consentStatus").textContent, /n’est pas disponible/);
    assert.equal(s.ads.length, 0);
    assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
  }
});

test("unfilled ads and blocked Google collapse the advertising panel", async t => {
  const s = setup(t); await s.controller.start(); s.ready(); s.emit();
  s.ads[0].dataset.adStatus = "unfilled";
  await Promise.resolve();
  assert.equal(s.panel.hidden, true);
  s.w.document.getElementById("letchatAdSense").dispatchEvent(new s.w.Event("error"));
  assert.equal(s.ads.length, 0);
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);
});

test("account changes cancel in-flight eligibility and switching to Premium removes the ad", async t => {
  let eligible = true;
  const s = setup(t, async () => eligible); await s.controller.start(); s.ready(); s.emit();
  s.controller.suspend();
  assert.equal(s.panel.hidden, true);
  await s.controller.recheck();
  assert.equal(s.w.adsbygoogle.length, 1, "returning to a tab does not refresh advertising");
  eligible = false;
  await s.controller.recheck();
  s.emit();
  assert.equal(s.ads.length, 0);
  assert.equal(s.w.adsbygoogle.pauseAdRequests, 1);

  let resolveOld;
  const pending = setup(t, () => new Promise(resolve => { resolveOld = resolve; }));
  const first = pending.controller.start();
  pending.controller.suspend();
  resolveOld(true); await first;
  assert.equal(pending.scripts, 0, "late old-account result cannot start Google");
});

test("real page bootstrap waits for Google auth, checks the session and rejects uncertain status", async t => {
  const script = (await readFile("public/discovery-page.js", "utf8"))
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  const dom = new JSDOM(html, { url: "https://www.letchat.fr/decouvrir.html", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  let resolveAuth, gate, premium = true;
  const ready = new Promise(resolve => { resolveAuth = resolve; });
  const calls = [];
  w.initializeApp = () => ({});
  w.getAuth = () => ({ currentUser: { getIdToken: async () => "google-test-token" }, authStateReady: () => ready });
  w.onAuthStateChanged = () => () => {};
  w.createPublicAdvertising = options => { gate = options.checkEligibility; return { start() {}, stop() {}, suspend() {}, recheck() {} }; };
  w.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url === "/api/public-config" ? { advertisingEnabled: true } : { premium } };
  };
  w.eval(script);
  const result = gate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.some(call => call.url === "/api/subscription"), false, "waits for persisted auth");
  resolveAuth();
  assert.equal(await result, false);
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer google-test-token");
  premium = false;
  w.localStorage.setItem("letchatLocalToken", "local-test-token");
  assert.equal(await gate(), true);
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer local-test-token");
  premium = undefined;
  assert.equal(await gate(), false);
  w.fetch = async () => ({ ok: false });
  await assert.rejects(gate());
});
