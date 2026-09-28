import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import sharp from "sharp";
import { rooms } from "../public/room-catalog.js";

// Exécute le client livré et ses vrais gestionnaires DOM/Socket.IO,
// avec des réponses serveur locales : aucun appel au site public.
async function setup(t) {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"), {
    url: "https://www.letchat.fr", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window, events = new Map();
  t.after(() => w.close());
  w.rooms = rooms;
  w.initializeApp = () => ({}); w.getAuth = () => ({ currentUser: null });
  w.GoogleAuthProvider = class { setCustomParameters() {} };
  w.onAuthStateChanged = () => () => {}; w.getRedirectResult = () => Promise.resolve();
  w.setPersistence = () => Promise.resolve(); w.browserLocalPersistence = {};
  w.signOut = () => Promise.resolve();
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.CSS = { escape: s => s };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLMediaElement.prototype.pause = () => {};
  w.installSocial = () => ({ live: { leave() {} } });
  w.installPremiumBenefitsUI = () => ({ refresh: async () => {} });
  w.installSurpriseUI = () => ({ bind() {} });
  const socket = { connected: true, on: (name, callback) => events.set(name, callback), emit() {},
    disconnect() { this.connected = false; events.get("disconnect")?.(); } };
  w.io = () => socket;
  let profile = { user_id: "self", display_name: "Test Letchat", photo: "", city: "Test", gender: "neutral" };
  w.fetch = async (url, options = {}) => {
    let data = [];
    if (url === "/api/age-status") data = { accepted: false };
    if (url === "/api/public-config") data = { contactEmail: "test@example.invalid" };
    if (url === "/api/profile") {
      if (options.method === "PUT") profile = { ...profile, display_name: JSON.parse(options.body).displayName };
      data = profile;
    }
    return { ok: true, json: async () => data };
  };
  let code = await readFile("public/app-v4-cafe-v2.js", "utf8");
  code = code.replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  w.eval(code + `\nwindow.fixture = {
    activate: data => activateLocalSession(data, "local-test-token", true),
    openProfile, showPrivateMessagesHome, openContactPicker,
    setData: data => {
      user = localUser({ id: "self", name: "Test Letchat", guest: true }, "local-test-token");
      privateConversations = data.conversations || [];
      blockedUsers = new Map((data.blocked || []).map(id => [String(id), {}]));
      friendRelations = new Map((data.friends || []).map(row => [String(row.user_id), row]));
    },
    home: () => { privateHomeOpen = true; renderPrivateMessagesHome(); },
    clearIdentity: () => { user = null; },
    connect,
  };`);
  w.fixture.setData({}); w.fixture.connect();
  return {
    w, document: w.document, fixture: w.fixture,
    emit: (name, data) => events.get(name)(data),
    disconnect: () => socket.disconnect(),
  };
}

const member = (id, extra = {}) => ({ id, name: `Membre ${id}`, photo: "", gender: "neutral", availability: "available", ...extra });
const conversation = id => ({ user_id: id, display_name: `Membre ${id}`, last_body: "Bonjour", last_message_at: "2026-09-28T10:00:00Z" });
const card = (doc, id) => doc.querySelector(`[data-home-private="${id}"]`);
const avatarSvg = img => decodeURIComponent(img.src.slice(img.src.indexOf(",") + 1));

test("guest without a photo gets a renderable avatar in the sidebar and profile", async t => {
  const s = await setup(t);
  await s.fixture.activate({ id: "self", name: "Test Letchat", guest: true });
  s.fixture.openProfile({ display_name: "Test Letchat", photo: "" });
  for (const id of ["mePhoto", "profilePhotoPreview"]) {
    const img = s.document.getElementById(id);
    assert.match(img.src, /^data:image\/svg\+xml/);
    assert.match(avatarSvg(img), />TL<\/text>/);
    const rendered = await sharp(Buffer.from(avatarSvg(img))).png().toBuffer();
    assert.equal((await sharp(rendered).metadata()).width, 96);
  }
});

test("existing photos are kept; broken photos fall back once and initials are escaped", async t => {
  const s = await setup(t);
  await s.fixture.activate({ id: "self", name: "< &", photo: "https://www.letchat.fr/photo-test.jpg" });
  const img = s.document.getElementById("mePhoto");
  assert.equal(img.src, "https://www.letchat.fr/photo-test.jpg");
  img.dispatchEvent(new s.w.Event("error"));
  const svg = avatarSvg(img);
  const parsed = new s.w.DOMParser().parseFromString(svg, "image/svg+xml");
  assert.equal(parsed.querySelector("parsererror"), null);
  assert.equal(parsed.querySelector("text").textContent, "<&");
  assert.equal(parsed.querySelectorAll("script").length, 0);
  assert.equal(img.onerror, null, "a fallback failure cannot loop");
  const source = img.src;
  img.dispatchEvent(new s.w.Event("error"));
  assert.equal(img.src, source);
});

test("saving a profile without a photo preserves the fallback with the new initials", async t => {
  const s = await setup(t);
  s.fixture.openProfile({ display_name: "Test Letchat", photo: "" });
  s.document.getElementById("profileName").value = "Nouveau Nom";
  await s.document.getElementById("profileForm").onsubmit({ preventDefault() {} });
  assert.equal(s.document.getElementById("meName").textContent, "Nouveau Nom");
  assert.match(avatarSvg(s.document.getElementById("mePhoto")), />NN<\/text>/);
  assert.ok(s.document.getElementById("profileModal").classList.contains("hidden"));
});

test("members in other rooms appear online without exposing call identifiers", async t => {
  const s = await setup(t);
  s.fixture.setData({ conversations: [conversation("other"), conversation("offline")] });
  s.emit("presence", [member("self"), member("same", { socketId: "same-room-socket" })]);
  s.fixture.home();
  s.emit("online-members", [member("self"), member("same"), member("other"), member("newcomer")]);
  assert.equal(s.document.querySelector('[data-home-private="other"] small').textContent, "Bonjour");
  assert.equal(s.document.querySelectorAll('[data-home-private="other"]')[1].querySelector("small").textContent, "En ligne");
  assert.equal(card(s.document, "newcomer").querySelector("small").textContent, "En ligne");
  s.fixture.openContactPicker("message");
  const other = s.document.querySelector('[data-contact-id="other"]');
  assert.equal(other.querySelector("small").textContent, "En ligne");
  assert.equal(other.dataset.contactSocket, "");
  assert.equal(s.document.querySelector('[data-contact-id="offline"] small').textContent, "Hors ligne");
  s.fixture.openContactPicker("call");
  assert.equal(s.document.querySelector('[data-contact-id="other"]'), null);
  assert.equal(s.document.querySelector('[data-contact-id="same"]').dataset.contactSocket, "same-room-socket");
});

test("global departures refresh open lists and friends despite stale room presence", async t => {
  const s = await setup(t);
  s.fixture.setData({ conversations: [conversation("other")], friends: [{ user_id: "other", display_name: "Membre other", status: "accepted" }] });
  s.emit("presence", [member("self"), member("other", { socketId: "stale-socket" })]);
  s.emit("online-members", [member("self"), member("other")]);
  s.fixture.home(); s.fixture.openContactPicker("message");
  s.document.querySelector('[data-contact-id="other"]').focus();
  s.emit("online-members", [member("self")]);
  assert.equal(s.document.querySelector('[data-contact-id="other"] small').textContent, "Hors ligne");
  assert.equal(s.document.activeElement.dataset.contactId, "other");
  assert.equal(s.document.querySelector(".friend-open .online-dot").classList.contains("online"), false);
  assert.equal(s.document.querySelectorAll('[data-home-private="other"]')[1].querySelector("small").textContent, "Hors ligne");
  s.fixture.openContactPicker("call");
  assert.equal(s.document.querySelector('[data-contact-id="other"]'), null);
});

test("blocked members, self and stale hidden presence stay excluded; multiple tabs deduplicate", async t => {
  const s = await setup(t);
  s.fixture.setData({ blocked: ["blocked"], conversations: [conversation("blocked")] });
  s.emit("presence", [member("self"), member("hidden", { socketId: "old-socket" }), member("other"), member("other")]);
  s.emit("online-members", [member("self"), member("blocked"), member("other")]);
  s.fixture.home(); s.fixture.openContactPicker("message");
  for (const id of ["blocked", "self", "hidden"]) {
    assert.equal(s.document.querySelector(`[data-contact-id="${id}"]`), null);
  }
  assert.equal(s.document.querySelectorAll('[data-contact-id="other"]').length, 1);
});

test("disconnect removes stale online status and a fresh directory restores it", async t => {
  const s = await setup(t);
  s.fixture.setData({ conversations: [conversation("other")] });
  s.emit("presence", [member("self"), member("other", { socketId: "old-socket" })]);
  s.emit("online-members", [member("self"), member("other")]);
  s.fixture.openContactPicker("message");
  s.disconnect();
  assert.equal(s.document.querySelector('[data-contact-id="other"] small').textContent, "Hors ligne");
  assert.equal(s.document.getElementById("onlineMembersBadge").textContent, "…");
  s.emit("online-members", [member("self"), member("other")]);
  assert.equal(s.document.querySelector('[data-contact-id="other"] small').textContent, "En ligne");
});

test("sign-out can clear identity before the socket closes without crashing open lists", async t => {
  const s = await setup(t);
  s.emit("presence", [member("self"), member("other")]);
  s.fixture.home(); s.fixture.openContactPicker("message");
  s.fixture.clearIdentity();
  assert.doesNotThrow(() => s.disconnect());
  assert.equal(s.document.querySelectorAll("[data-contact-id]").length, 0);
});
