import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import { createPublicAdvertising } from "./adsense-public.js";

const auth = getAuth(initializeApp({
  apiKey: "AIzaSyCfOel5JKgjxmVslddn_Xdar1XR_vb2Cgs",
  authDomain: "www.letchat.fr",
  projectId: "letchat-1d79d",
  appId: "1:289359647477:web:893d579c6bf94b98226bbc"
}));

async function json(url, token) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Session indisponible");
  return response.json();
}

async function checkEligibility() {
  if ((await json("/api/public-config")).advertisingEnabled !== true) return false;
  // Wait for persisted Google authentication before deciding that a visitor
  // is anonymous. An unavailable session never falls back to free status.
  let timeout;
  try {
    await Promise.race([
      auth.authStateReady(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Session indisponible")), 8000); })
    ]);
  } finally { clearTimeout(timeout); }
  const token = localStorage.getItem("letchatLocalToken") || sessionStorage.getItem("letchatGuestToken") ||
    (auth.currentUser ? await auth.currentUser.getIdToken() : "");
  if (!token) return true;
  return (await json("/api/subscription", token)).premium === false;
}

const advertising = createPublicAdvertising({
  window,
  checkEligibility,
  nonce: document.querySelector('script[src="/discovery-page.js"]')?.nonce
});
advertising.start();

// Re-evaluate account changes without refreshing the page or the ad slot.
window.addEventListener("storage", event => {
  if (event.key === "letchatLocalToken" || event.key === null) advertising.recheck();
});
let firstAuthState = true;
onAuthStateChanged(auth, () => {
  if (firstAuthState) { firstAuthState = false; return; }
  advertising.recheck();
}, () => advertising.stop());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) advertising.suspend();
  else advertising.recheck();
});
window.addEventListener("pagehide", () => advertising.suspend());
window.addEventListener("pageshow", event => { if (event.persisted) advertising.recheck(); });
