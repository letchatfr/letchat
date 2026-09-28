import { installSurpriseUI } from "./surprise.2309b5900f8a.js";
import { installSocial } from "./social.13a3d4d6555d.js";
import { installPremiumBenefitsUI } from "./premium-benefits.2025742d7f1f.js";
import { rooms } from "./room-catalog.2ef7971ebb04.js";
import { messageDayInfo, shouldSendOnEnter } from "./chat-comfort.bbaf8a24a95b.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signOut,
  deleteUser,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
const config = {
  apiKey: "AIzaSyCfOel5JKgjxmVslddn_Xdar1XR_vb2Cgs",
  authDomain: "www.letchat.fr",
  projectId: "letchat-1d79d",
  storageBucket: "letchat-1d79d.firebasestorage.app",
  messagingSenderId: "289359647477",
  appId: "1:289359647477:web:893d579c6bf94b98226bbc",
  measurementId: "G-L3Z35BP6FG",
};
const auth = getAuth(initializeApp(config)),
  provider = new GoogleAuthProvider(),
  $ = (s) => document.querySelector(s);
let socialFeatures, premiumFeatures, surpriseFeatures;
let localSessionToken = localStorage.getItem("letchatLocalToken") || sessionStorage.getItem("letchatGuestToken") || "";
let user,
  token,
  socket,
  stream,
  installPromptEvent,
  serviceWorkerRegistration,
  peers = new Map(),
  pendingIce = new Map(),
  typingTimer,
  typingActive = false,
  typingTarget = null,
  toastTimer,
  expiryTimers = new Map(),
  unreadPrivate = new Map(),
  blockedUsers = new Map(),
  friendRelations = new Map(),
  privateConversations = [],
  showArchivedConversations = false,
  privateContactStatus = null,
  notifications = [],
  lastPeople = [],
  allOnlineMembers = null,
  lastPublicMessages = [],
  isAdmin = false,
  roomUnread = new Map(),
  pendingAdultSelection = null,
  iceServers = [],
  icePromise,
  mediaStartPromise,
  inVideoCall = false,
  activeCallId = null,
  currentRoom = "cafe",
  currentPrivate = null,
  reportContext = null,
  replyingTo = null,
  voiceRecorder = null,
  voiceStream = null,
  webcamTestStream = null,
  voiceChunks = [],
  voiceInterval = null,
  voiceStartedAt = 0,
  voiceCancelled = false,
  viewOnceEnabled = false,
  pendingProfilePhoto = null,
  viewedProfile = null,
  pendingIncomingCall = null,
  incomingCallTimer = null,
  ringtoneTimer = null,
  ringtoneContext = null,
  callTimer = null,
  callStartedAt = 0,
  privateHomeOpen = false,
  contactPickerMode = "message",
  sessionStarted = false;
// Brouillons éphémères : supprimés à la déconnexion et au rechargement.
const conversationDrafts = new Map();
let sendingMessage = false, renderedConversation = "", loadVersion = 0;
function conversationKey() {
  return privateHomeOpen ? "home" : currentPrivate ? `private:${currentPrivate.id}` : `room:${currentRoom}`;
}
function saveDraft() {
  if (privateHomeOpen) return;
  const value = $("#input").value;
  if (value) conversationDrafts.set(conversationKey(), value);
  else conversationDrafts.delete(conversationKey());
}
function restoreDraft() {
  $("#input").value = privateHomeOpen ? "" : conversationDrafts.get(conversationKey()) || "";
  $("#input").dispatchEvent(new Event("input"));
  $("#jumpLatest")?.classList.add("hidden");
}
function connectionStatus(label, state) {
  const indicator = $("#connectionStatus");
  if (indicator) { indicator.textContent = label; indicator.dataset.state = state; }
}
const fallbackIceServers = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const mediaUrls = new Map();
const mediaObserver = new IntersectionObserver(entries => {
  for (const { target: element, isIntersecting } of entries) if (isIntersecting) {
    mediaObserver.unobserve(element);
    const owner = user?.uid;
    api(element.dataset.mediaPath).then(response => response.blob()).then(blob => {
      if (!element.isConnected || user?.uid !== owner) return;
      const url = URL.createObjectURL(blob);
      mediaUrls.set(element, url); element.src = url;
    }).catch(() => {
      if (!element.isConnected) return;
      element.replaceWith(Object.assign(document.createElement("p"), { className: "media-unavailable", textContent: "Média indisponible ou expiré" }));
    });
  }
}, { rootMargin: "400px" });
new MutationObserver(() => {
  for (const [element, url] of mediaUrls) if (!element.isConnected) {
    URL.revokeObjectURL(url); mediaUrls.delete(element);
  }
}).observe($("#messages"), { childList: true, subtree: true });

let recoveryOwner = "";
function showRecoveryCode(code, username = "") {
  recoveryOwner = username;
  $("#recoveryCodeValue").value = code;
  $("#recoveryCodeDialog").showModal();
}
$("#recoveryCodeDialog").addEventListener("close", () => { $("#recoveryCodeValue").value = ""; recoveryOwner = ""; });
$("#closeRecoveryCode").onclick = () => $("#recoveryCodeDialog").close();
$("#downloadRecoveryCode").onclick = () => {
  const blob = new Blob([`Letchat — Code de récupération\nPseudonyme : ${recoveryOwner}\nCode : ${$("#recoveryCodeValue").value}\n\nConservez ce fichier en lieu sûr. Ne partagez pas ce code.\nUn code utilisé ou remplacé ne fonctionne plus.\nRécupération : https://www.letchat.fr/\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "letchat-code-recuperation.txt"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.querySelectorAll("[data-close-dialog]").forEach(button => {
  button.onclick = () => document.getElementById(button.dataset.closeDialog).close();
});
$("#forgotPassword").onclick = () => { $("#recoverForm").reset(); $("#recoverError").textContent = ""; $("#recoverDialog").showModal(); };
$("#recoverForm").onsubmit = async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    const username = $("#recoverUsername").value;
    const response = await fetch("/api/auth/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      username, recoveryCode: $("#recoverCode").value, password: $("#recoverPassword").value
    }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Récupération impossible");
    $("#recoverForm").reset(); $("#recoverDialog").close();
    $("#localLoginName").value = username;
    loginError("Mot de passe changé. Connectez-vous avec votre nouveau mot de passe.");
    showRecoveryCode(data.recoveryCode, username);
  } catch (error) { $("#recoverError").textContent = error.message; }
  finally { button.disabled = false; }
};
$("#recoverySettings").onclick = () => { $("#recoverySettingsForm").reset(); $("#recoverySettingsError").textContent = ""; $("#recoverySettingsDialog").showModal(); };
$("#recoverySettingsForm").onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const data = await (await api("/api/account/recovery-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#recoveryCurrentPassword").value }) })).json();
    $("#recoverySettingsForm").reset(); $("#recoverySettingsDialog").close();
    showRecoveryCode(data.recoveryCode, user.displayName);
  } catch (error) { $("#recoverySettingsError").textContent = error.message; }
  finally { button.disabled = false; }
};

provider.setCustomParameters({ prompt: "select_account" });
const useGoogleRedirect = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
function loginError(message) {
  const box = $("#loginError");
  box.textContent = message;
  box.classList.remove("hidden");
}
$("#googleLogin").onclick = async () => {
  const button = $("#googleLogin");
  button.disabled = true;
  $("#loginError").classList.add("hidden");
  try {
    await setPersistence(auth, browserLocalPersistence);
    button.textContent = "Ouverture de Google…";
    if (useGoogleRedirect) {
      await signInWithRedirect(auth, provider);
      return;
    }
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (["auth/popup-blocked", "auth/popup-closed-by-user"].includes(error.code)) {
      $("#googleRedirect").classList.remove("hidden");
      return loginError("La connexion Google n’a pas abouti. Vous pouvez la poursuivre dans cet onglet.");
    }
    if (error.code === "auth/popup-blocked")
      return loginError("Chrome bloque la fenêtre Google. Autorisez les fenêtres pop-up pour www.letchat.fr, puis réessayez.");
    if (error.code === "auth/unauthorized-domain")
      return loginError("Le domaine www.letchat.fr doit être autorisé dans Firebase Authentication.");
    loginError(`Connexion Google impossible (${error.code || "erreur"}) : ${error.message}`);
  } finally {
    button.disabled = false;
    if (document.body.contains(button))
      button.innerHTML = '<span>G</span> Continuer avec Google';
  }
};
$("#googleRedirect").onclick = async () => {
  try { await setPersistence(auth, browserLocalPersistence); await signInWithRedirect(auth, provider); }
  catch { loginError("Google est temporairement indisponible. Réessayez plus tard."); }
};
$("#backToLogin").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
window.addEventListener("storage", event => {
  if (event.key === "letchatLocalToken" && localSessionToken && event.newValue !== localSessionToken) {
    socket?.disconnect(); location.reload();
  }
});
function logoutSession() {
  hang();
  socket?.disconnect();
  conversationDrafts.clear();
  $("#input").value = "";
  if (localSessionToken) {
    localStorage.removeItem("letchatLocalToken");
    sessionStorage.removeItem("letchatGuestToken");
    localSessionToken = "";
    location.reload();
    return;
  }
  signOut(auth);
}
$("#logout").onclick = logoutSession;
getRedirectResult(auth).catch((error) =>
  loginError(`Retour Google impossible (${error.code || "erreur"}) : ${error.message}`),
);
function localUser(data, sessionToken) {
  return { uid:data.id, displayName:data.name, email:"", photoURL:data.photo || "", guest:Boolean(data.guest), local:true, getIdToken:async()=>sessionToken };
}
async function activateLocalSession(data, sessionToken, guest = false) {
  localSessionToken = sessionToken;
  if (guest) { sessionStorage.setItem("letchatGuestToken",sessionToken); localStorage.removeItem("letchatLocalToken"); }
  else { localStorage.setItem("letchatLocalToken",sessionToken); sessionStorage.removeItem("letchatGuestToken"); }
  user = localUser(data,sessionToken); token = sessionToken;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#meName").textContent = data.name;
  setProfileAvatar($("#mePhoto"), data.name, data.photo);
  if (await checkAge()) await beginSession();
}
async function restoreLocalSession() {
  if (!localSessionToken) return false;
  try {
    const response = await fetch("/api/auth/me",{headers:{Authorization:`Bearer ${localSessionToken}`}});
    if (!response.ok) throw new Error();
    const data = await response.json();
    await activateLocalSession(data.user,localSessionToken,Boolean(data.user.guest));
    return true;
  } catch { localStorage.removeItem("letchatLocalToken"); sessionStorage.removeItem("letchatGuestToken"); localSessionToken=""; return false; }
}
const localRestorePromise = restoreLocalSession();
onAuthStateChanged(auth, async (u) => {
  if (await localRestorePromise) return;
  if (!u) {
    conversationDrafts.clear();
    $("#input").value = "";
    allOnlineMembers = null;
    $("#onlineMembersModal").classList.add("hidden");
    renderOnlineMembers();
    user = null;
    token = null;
    sessionStarted = false;
    $("#login").classList.remove("hidden");
    $("#app").classList.add("hidden");
    $("#ageModal").classList.add("hidden");
    socket?.disconnect();
    return;
  }
  user = u;
  token = await u.getIdToken();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#meName").textContent = u.displayName || u.email;
  setProfileAvatar($("#mePhoto"), u.displayName || u.email, u.photoURL);
  if (await checkAge()) await beginSession();
});
document.querySelectorAll("[data-auth-tab]").forEach(button => button.onclick=()=>{
  document.querySelectorAll("[data-auth-tab]").forEach(item=>item.classList.toggle("active",item===button));
  $("#localLoginForm").classList.toggle("hidden",button.dataset.authTab!=="login");
  $("#localRegisterForm").classList.toggle("hidden",button.dataset.authTab!=="register");
  $("#guestLoginForm").classList.toggle("hidden",button.dataset.authTab!=="guest");
  $("#loginError").classList.add("hidden");
});
async function submitLocalAuth(path,payload,guest=false) {
  const response = await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const data = await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Connexion impossible");
  await activateLocalSession(data.user,data.token,guest);
  if (data.recoveryCode) showRecoveryCode(data.recoveryCode, data.user.name);
}
$("#localLoginForm").onsubmit=async event=>{event.preventDefault();try{await submitLocalAuth("/api/auth/login",{username:$("#localLoginName").value,password:$("#localLoginPassword").value});}catch(e){loginError(e.message)}};
$("#localRegisterForm").onsubmit=async event=>{event.preventDefault();try{await submitLocalAuth("/api/auth/register",{username:$("#localRegisterName").value,password:$("#localRegisterPassword").value,age:Number($("#localRegisterAge").value),gender:$("#localRegisterGender").value,city:$("#localRegisterCity").value});}catch(e){loginError(e.message)}};
$("#guestLoginForm").onsubmit=async event=>{event.preventDefault();try{await submitLocalAuth("/api/auth/guest",{username:$("#guestName").value,age:Number($("#guestAge").value),gender:$("#guestGender").value,city:$("#guestCity").value},true);}catch(e){loginError(e.message)}};
async function getAuthenticatedUser() {
  const current = localSessionToken ? user : auth.currentUser || user;
  if (current) return current;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Connexion en cours. Réessayez dans quelques secondes"));
    }, 5000);
    unsubscribe = onAuthStateChanged(auth, activeUser => {
      if (!activeUser) return;
      clearTimeout(timeout);
      unsubscribe();
      user = activeUser;
      resolve(activeUser);
    });
  });
}
const api = async (path, opt = {}) => {
  const activeUser = await getAuthenticatedUser();
  token = await activeUser.getIdToken();
  opt.headers = { ...opt.headers, Authorization: `Bearer ${token}` };
  const r = await fetch(path, opt);
  if (!r.ok) {
    let message = `Erreur serveur (${r.status})`;
    try {
      const data = await r.json();
      if (data?.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
  return r;
};
async function beginSession() {
  if (sessionStarted) return;
  sessionStarted = true;
  try {
    await checkRules();
    await loadBlocks();
    await loadFriends();
    await loadPrivateConversations();
    await loadNotifications();
    await checkAdmin();
    await loadSubscription();
    connect();
    load();
    loadProfile();
    loadContactEmail();
    setupAppFeatures();
  } catch (error) {
    sessionStarted = false;
    showError(error.message);
  }
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPromptEvent = event;
  $("#installApp")?.classList.remove("hidden");
});
window.addEventListener("appinstalled", () => {
  installPromptEvent = null;
  $("#installApp")?.classList.add("hidden");
  if ($("#appFeatureStatus")) $("#appFeatureStatus").textContent = "Letchat est installé sur cet appareil.";
});

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

async function setupAppFeatures() {
  const status = $("#appFeatureStatus"), pushButton = $("#enablePush");
  if (!("serviceWorker" in navigator)) {
    status.textContent = "Ce navigateur ne permet pas l’installation ou les notifications.";
    pushButton.disabled = true;
    return;
  }
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("/service-worker.js");
    const config = await (await fetch("/api/public-config")).json();
    if (!config.pushConfigured || !("PushManager" in window)) {
      pushButton.disabled = true;
      status.textContent = "L’application est installable. Les notifications doivent encore être configurées sur le serveur.";
      return;
    }
    // Conserver la clé pendant tout le cycle activation/désactivation.
    pushButton.dataset.vapidKey = config.vapidPublicKey;
    const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
    if (subscription) {
      pushButton.textContent = "Désactiver les notifications";
      pushButton.disabled = false;
      pushButton.dataset.pushEnabled = "true";
      status.textContent = "Vous recevrez les nouveaux messages même lorsque Letchat est fermé.";
    } else if (Notification.permission === "denied") {
      pushButton.textContent = "Notifications bloquées";
      pushButton.disabled = true;
      status.textContent = "Autorisez les notifications dans les réglages de votre navigateur.";
    } else {
      pushButton.textContent = "Activer les notifications";
      pushButton.disabled = false;
      pushButton.dataset.pushEnabled = "false";
    }
  } catch (error) {
    status.textContent = "Impossible de préparer l’application : " + error.message;
  }
}

$("#installApp").onclick = async () => {
  if (!installPromptEvent) return;
  await installPromptEvent.prompt();
  await installPromptEvent.userChoice;
  installPromptEvent = null;
  $("#installApp").classList.add("hidden");
};

$("#enablePush").onclick = async () => {
  const button = $("#enablePush"), status = $("#appFeatureStatus");
  button.disabled = true;
  try {
    const currentSubscription = await serviceWorkerRegistration.pushManager.getSubscription();
    if (currentSubscription) {
      await api("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: currentSubscription.endpoint })
      });
      await currentSubscription.unsubscribe();
      button.dataset.pushEnabled = "false";
      button.textContent = "Activer les notifications";
      status.textContent = "Les notifications sont désactivées sur cet appareil.";
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Autorisation refusée");
    const subscription = await serviceWorkerRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(button.dataset.vapidKey)
    });
    await api("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON())
    });
    button.dataset.pushEnabled = "true";
    button.textContent = "Désactiver les notifications";
    status.textContent = "Vous recevrez les nouveaux messages même lorsque Letchat est fermé.";
  } catch (error) {
    status.textContent = "Impossible de modifier les notifications : " + error.message;
  } finally {
    button.disabled = false;
  }
};
async function checkAge() {
  try {
    const status = await (await api("/api/age-status")).json();
    $("#ageModal").classList.toggle("hidden", status.accepted);
    return status.accepted;
  } catch (e) {
    showError(e.message);
    return false;
  }
}
$("#ageForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#ageForm button[type=submit]");
  button.disabled = true;
  $("#ageError").textContent = "";
  try {
    await api("/api/age-accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ over18: $("#ageAccepted").checked }),
    });
    $("#ageModal").classList.add("hidden");
    await beginSession();
  } catch (e) {
    $("#ageError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#ageLeave").onclick = logoutSession;
async function load() {
  if (!user) return;
  const version = ++loadVersion;
  if (!privateHomeOpen && renderedConversation !== conversationKey()) {
    $("#messages").innerHTML = '<div class="empty" role="status"><h2>Chargement des messages…</h2></div>';
    $("#roomFeature").classList.add("hidden");
  }
  try {
    if (privateHomeOpen) {
      renderPrivateMessagesHome();
      return;
    }
    if (currentPrivate) {
      const selected = currentPrivate,
        rows = await (
          await api(`/api/private/${encodeURIComponent(selected.id)}`)
        ).json();
      if (version === loadVersion && !privateHomeOpen && currentPrivate?.id === selected.id) render(rows);
      if (currentPrivate?.id === selected.id && document.visibilityState === "visible") markPrivateRead(selected.id);
      return;
    }
    const room = currentRoom,
      rows = await (
        await api(`/api/messages?room=${encodeURIComponent(room)}`)
      ).json();
    if (version === loadVersion && !privateHomeOpen && !currentPrivate && room === currentRoom) render(rows);
  } catch (e) {
    showError(e.message);
  }
}
function render(rows) {
  expiryTimers.forEach(clearTimeout);
  expiryTimers.clear();
  const box = $("#messages");
  const key = conversationKey(), previousTop = box.scrollTop;
  const preservePosition = renderedConversation === key && box.scrollHeight - box.scrollTop - box.clientHeight > 100;
  renderedConversation = key;
  if (!currentPrivate) lastPublicMessages = rows;
  box.classList.toggle("media-gallery", !currentPrivate && currentRoom === "amateurs");
  updateRoomFeature();
  if (currentPrivate) {
    box.innerHTML = rows.length
      ? ""
      : `<div class="empty"><b>✉</b><h2>Discussion avec ${memberLink(currentPrivate.id, currentPrivate.name)}</h2><p>Messages privés supprimés après 48 heures.</p></div>`;
  } else {
    const info = rooms[currentRoom];
    box.innerHTML = rows.length
      ? ""
      : `<div class="empty"><b>${info.title.split(" ")[0]}</b><h2>${info.welcome}</h2><p>Envoyez le premier message.</p></div>`;
  }
  rows.forEach((m) => addMessage(m, true, false));
  syncMessageDates();
  box.scrollTop = preservePosition ? previousTop : box.scrollHeight;
}
function syncMessageDates() {
  const box = $("#messages");
  box.querySelectorAll(":scope > .message-day").forEach(node => node.remove());
  let previousDay = null;
  const now = new Date();
  box.querySelectorAll(":scope > .message").forEach(article => {
    const day = messageDayInfo(article.dataset.createdAt, now);
    if (!day || day.key === previousDay) return;
    const divider = document.createElement("div"), label = document.createElement("time");
    divider.className = "message-day";
    label.dateTime = day.key;
    label.textContent = day.label;
    divider.append(label);
    article.before(divider);
    previousDay = day.key;
  });
}
function safe(v) {
  const d = document.createElement("div");
  d.textContent = v;
  return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Les identités utilisent toujours l’identifiant du compte, jamais le pseudonyme.
function memberLink(id, name, content = safe(name || "Utilisateur"), className = "") {
  if (id === null || id === undefined || !String(id).trim()) return `<span>${content}</span>`;
  const label = String(id) === String(user?.uid) ? "Ouvrir mon profil" : `Écrire en privé à ${name || "ce membre"}`;
  return `<button type="button" class="member-link ${safe(className)}" data-private-user="${safe(id)}" data-private-name="${safe(name || "Utilisateur")}" title="${safe(label)}" aria-label="${safe(label)}">${content}</button>`;
}
document.addEventListener("click", event => {
  const link = event.target.closest?.("button[data-private-user]");
  if (!link || link.disabled) return;
  event.preventDefault();
  openPrivate(link.dataset.privateUser, link.dataset.privateName);
});
function initials(n) {
  return n
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();
}
// Un avatar local reste lisible sans photo, ou si son chargement échoue.
function setProfileAvatar(image, name, photo) {
  const letters = safe(initials(String(name || "").trim()) || "?");
  const fallback = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#315b76"/><text x="48" y="49" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="36" font-weight="700" fill="#fff">${letters}</text></svg>`)}`;
  image.onerror = () => {
    image.onerror = null;
    image.src = fallback;
  };
  image.src = typeof photo === "string" && photo.trim() ? photo.trim() : fallback;
}
function messageKey(m) {
  return `${m.private ? "p" : "m"}-${m.id}`;
}
function removeMessage(id, isPrivate = false) {
  const key = `${isPrivate ? "p" : "m"}-${id}`;
  document.querySelector(`[data-key="${key}"]`)?.remove();
  syncMessageDates();
  const timer = expiryTimers.get(key);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(key);
}
function scheduleExpiry(m) {
  if (!m.expires_at) return;
  const key = messageKey(m),
    delay = new Date(m.expires_at).getTime() - Date.now();
  if (delay <= 0) return removeMessage(m.id, m.private);
  const old = expiryTimers.get(key);
  if (old) clearTimeout(old);
  expiryTimers.set(
    key,
    setTimeout(
      () => removeMessage(m.id, m.private),
      Math.min(delay, 2147483647),
    ),
  );
}
function reactionHtml(reactions = {}, mine = []) {
  return Object.entries(reactions)
    .filter(([, count]) => Number(count) > 0)
    .map(
      ([emoji, count]) =>
        `<button class="reaction-chip ${mine.includes(emoji) ? "active" : ""}" data-reaction="${emoji}">${emoji} <span>${count}</span></button>`,
    )
    .join("");
}
function setReply(m) {
  replyingTo = {
    id: String(m.id),
    private: Boolean(m.private),
    author: m.user_id === user.uid ? "Vous" : m.author,
    body: m.body || "Média",
  };
  $("#replyPreviewAuthor").innerHTML = `Répondre à ${memberLink(m.user_id, m.author, safe(replyingTo.author))}`;
  $("#replyPreviewText").textContent = replyingTo.body;
  $("#replyPreview").classList.remove("hidden");
  $("#input").focus();
}
function clearReply() {
  replyingTo = null;
  $("#replyPreview").classList.add("hidden");
  $("#replyPreviewAuthor").textContent = "";
  $("#replyPreviewText").textContent = "";
}
$("#cancelReply").onclick = clearReply;
function updateMessageReactions(payload) {
  const key = `${payload.private ? "p" : "m"}-${payload.id}`,
    article = document.querySelector(`[data-key="${key}"]`);
  if (!article) return;
  const box = article.querySelector(".reaction-summary"),
    mine = JSON.parse(article.dataset.myReactions || "[]");
  if (payload.emoji) {
    const index = mine.indexOf(payload.emoji);
    if (payload.active && index < 0) mine.push(payload.emoji);
    if (!payload.active && index >= 0) mine.splice(index, 1);
    article.dataset.myReactions = JSON.stringify(mine);
  }
  box.innerHTML = reactionHtml(payload.reactions || {}, mine);
  bindReactionChips(article);
}
function bindReactionChips(article) {
  article
    .querySelectorAll(".reaction-chip")
    .forEach(
      (button) =>
        (button.onclick = () =>
          toggleReaction(article, button.dataset.reaction)),
    );
}
async function toggleReaction(article, emoji) {
  try {
    const kind = article.dataset.private === "true" ? "private" : "public",
      id = article.dataset.messageId,
      response = await api(`/api/messages/${kind}/${id}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      });
    updateMessageReactions(await response.json());
  } catch (e) {
    showError(e.message);
  }
}
async function deleteOwnMessage(m) {
  if (!confirm("Supprimer définitivement ce message ?")) return;
  try {
    await api(`/api/messages/${m.private ? "private" : "public"}/${m.id}`, {
      method: "DELETE",
    });
    removeMessage(m.id, m.private);
  } catch (e) {
    showError(e.message);
  }
}
async function togglePinnedMessage(message) {
  try {
    await api(`/api/messages/${encodeURIComponent(message.id)}/pin`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !message.pinned }),
    });
    await load();
  } catch (error) {
    showError(error.message);
  }
}
function receiptText(deliveredAt, readAt) {
  if (readAt) return `✓✓ Lu à ${new Date(readAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  if (deliveredAt) return "✓✓ Reçu";
  return "✓ Envoyé";
}
function updatePrivateReceipts(payload) {
  (payload.messages || []).forEach(item => {
    const status = document.querySelector(`[data-key="p-${item.id}"] .message-status`);
    if (status) status.textContent = receiptText(item.delivered_at, item.read_at);
  });
}
async function markPrivateDelivered(otherId) {
  try { updatePrivateReceipts(await (await api(`/api/private/${encodeURIComponent(otherId)}/delivered`, { method: "PATCH" })).json()) } catch {}
}
async function markPrivateRead(otherId) {
  try {
    await api(`/api/private/${encodeURIComponent(otherId)}/read`, { method: "PATCH" });
    await loadPrivateConversations();
  } catch {}
}
function addMessage(m, force = false, followScroll = true) {
  if (privateHomeOpen) return;
  if (blockedUsers.has(String(m.user_id)) && m.user_id !== user.uid) return;
  if (m.private && !currentPrivate) return;
  if (
    m.private &&
    !force &&
    m.user_id !== currentPrivate.id &&
    m.recipient_id !== currentPrivate.id
  )
    return;
  if (!m.private && currentPrivate) return;
  if (m.room && m.room !== currentRoom) return;
  if (m.expires_at && new Date(m.expires_at).getTime() <= Date.now()) return;
  const key = messageKey(m);
  if (document.querySelector(`[data-key="${key}"]`)) return;
  const messageBox = $("#messages");
  const nearBottom = messageBox.scrollHeight - messageBox.scrollTop - messageBox.clientHeight < 100;
  const empty = $("#messages .empty");
  empty?.remove();
  const a = document.createElement("article"),
    mine = m.user_id === user.uid;
  a.className = "message " + (mine ? "mine" : "");
  a.dataset.key = key;
  a.dataset.messageId = m.id;
  a.dataset.authorId = m.user_id || "";
  a.dataset.authorName = m.author || "Utilisateur";
  a.dataset.createdAt = m.created_at || "";
  a.dataset.private = Boolean(m.private);
  a.dataset.myReactions = JSON.stringify(
    Array.isArray(m.my_reactions) ? m.my_reactions : [],
  );
  const base = m.private ? "/api/private-media" : "/api/media",
    viewOnceUnavailable = m.view_once && !mine && (m.opened_at || !m.has_media),
    media = viewOnceUnavailable
      ? `<div class="view-once-expired">◉ Média déjà ouvert</div>`
      : m.view_once && !mine
        ? `<button class="view-once-open" type="button" data-view-once-id="${m.id}" data-view-once-type="${safe(m.media_type || "")}"><b>①</b><span>Ouvrir ${m.media_type?.startsWith("video/") ? "la vidéo" : "la photo"}</span><small>Visible une seule fois</small></button>`
      : m.has_media
      ? m.media_type?.startsWith("image/")
        ? `<img class="media" data-media-path="${base}/${encodeURIComponent(m.id)}" alt="Photo partagée" loading="lazy">`
        : m.media_type?.startsWith("audio/")
          ? `<audio class="media audio-message" data-media-path="${base}/${encodeURIComponent(m.id)}" controls preload="metadata"></audio>`
          : `<video class="media" data-media-path="${base}/${encodeURIComponent(m.id)}" controls preload="metadata" playsinline></video>`
      : "",
    quote = m.reply_to_id
      ? `<div class="message-quote"><strong>${memberLink(m.reply_user_id, m.reply_author, safe(m.reply_author || "Message supprimé"))}</strong><span>${safe(m.reply_body || "Message original indisponible")}</span></div>`
      : "";
  a.innerHTML = `${memberLink(m.user_id, m.author, m.photo ? `<img src="${safe(m.photo)}" alt="">` : safe(initials(m.author)), "avatar member-avatar-link")}<div class="message-content"><p class="meta"><strong>${memberLink(m.user_id, m.author, mine ? "Vous" : safe(m.author))}</strong><time>${new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time>${m.pinned ? '<span class="pinned-label">📌 Épinglé</span>' : ""}</p>${quote}${m.body ? `<p class="bubble">${safe(m.body)}</p>` : ""}${media}<div class="reaction-summary">${reactionHtml(m.reactions, m.my_reactions || [])}</div>${m.private && mine ? `<div class="message-status">${receiptText(m.delivered_at, m.read_at)}</div>` : ""}<div class="message-actions"><button class="reply-action" title="Répondre">↩ Répondre</button><button class="react-action" title="Réagir">☺</button>${isAdmin && !m.private && m.room === "cafe" ? `<button class="pin-action" title="${m.pinned ? "Désépingler" : "Épingler"}">${m.pinned ? "Désépingler" : "📌 Épingler"}</button>` : ""}${mine ? '<button class="delete-action" title="Supprimer">Supprimer</button>' : '<button class="report-message-action" title="Signaler ce message">⚑ Signaler</button>'}<div class="reaction-picker hidden">${["👍", "❤️", "😂", "😮"].map((emoji) => `<button data-pick-reaction="${emoji}">${emoji}</button>`).join("")}</div></div></div>`;
  const messageDate = messageDayInfo(m.created_at);
  if (messageDate) {
    const time = a.querySelector(".meta time");
    time.dateTime = messageDate.iso;
    time.title = messageDate.full;
    time.setAttribute("aria-label", messageDate.full);
  }
  if (m.body) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-message-action";
    copy.textContent = "Copier";
    copy.title = "Copier le texte du message";
    copy.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      copy.disabled = true;
      try {
        await navigator.clipboard.writeText(m.body);
        copy.textContent = "✓ Copié";
        setTimeout(() => { if (copy.isConnected) copy.textContent = "Copier"; }, 1800);
      } catch {
        showError("La copie automatique est indisponible. Sélectionnez le texte du message pour le copier.");
      } finally {
        copy.disabled = false;
      }
    });
    a.querySelector(".message-actions").append(copy);
  }
  a.querySelector(".reply-action").onclick = () => setReply(m);
  a.querySelector(".react-action").onclick = () =>
    a.querySelector(".reaction-picker").classList.toggle("hidden");
  a.querySelector(".delete-action")?.addEventListener("click", () =>
    deleteOwnMessage(m),
  );
  a.querySelector(".pin-action")?.addEventListener("click", () => togglePinnedMessage(m));
  a.querySelector(".report-message-action")?.addEventListener("click", () =>
    openReport({ id: m.user_id, name: m.author }, m),
  );
  a.querySelector(".view-once-open")?.addEventListener("click", openViewOnceMedia);
  a.querySelectorAll("img.media, video.media").forEach((element) => {
    element.classList.add("gallery-media-open");
    element.setAttribute("tabindex", "0");
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", "Agrandir le média");
    element.addEventListener("click", () => openGalleryMedia(element));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openGalleryMedia(element);
      }
    });
  });
  if (!m.private && currentRoom === "amateurs" && m.has_media) {
    const replyButton = a.querySelector(".reply-action");
    const reactButton = a.querySelector(".react-action");
    if (replyButton) replyButton.textContent = "💬 Commenter";
    if (reactButton) reactButton.textContent = "❤️ J’aime";
  }
  a.querySelectorAll("[data-pick-reaction]").forEach(
    (button) =>
      (button.onclick = () => {
        toggleReaction(a, button.dataset.pickReaction);
        a.querySelector(".reaction-picker").classList.add("hidden");
      }),
  );
  bindReactionChips(a);
  $("#messages").append(a);
  if (followScroll) syncMessageDates();
  a.querySelectorAll("[data-media-path]").forEach(element => mediaObserver.observe(element));
  scheduleExpiry(m);
  if (followScroll && (force || mine || nearBottom)) {
    const context = conversationKey();
    requestAnimationFrame(() => {
      if (context === conversationKey()) messageBox.scrollTop = messageBox.scrollHeight;
    });
  } else if (followScroll) $("#jumpLatest")?.classList.remove("hidden");
}
async function openViewOnceMedia(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await api(`/api/private-media/${encodeURIComponent(button.dataset.viewOnceId)}`);
    const blob = await response.blob(), url = URL.createObjectURL(blob);
    const element = button.dataset.viewOnceType.startsWith("video/")
      ? document.createElement("video") : document.createElement("img");
    element.className = "media view-once-media";
    element.src = url;
    if (element.tagName === "VIDEO") { element.controls = true; element.autoplay = true; element.playsInline = true; }
    element.classList.add("gallery-media-open");
    element.setAttribute("tabindex", "0");
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", "Agrandir le média");
    element.addEventListener("click", () => openGalleryMedia(element));
    element.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Enter" || keyEvent.key === " ") {
        keyEvent.preventDefault();
        openGalleryMedia(element);
      }
    });
    const wrapper = document.createElement("div");
    wrapper.className = "view-once-opened";
    wrapper.append(element);
    const note = document.createElement("small");
    note.textContent = "Ce média disparaîtra en quittant la conversation";
    wrapper.append(note);
    button.replaceWith(wrapper);
  } catch (e) {
    button.replaceWith(Object.assign(document.createElement("div"), { className: "view-once-expired", textContent: "◉ Média déjà ouvert" }));
    showError(e.message);
  }
}
function openGalleryMedia(source) {
  const content = $("#mediaLightboxContent");
  content.innerHTML = "";
  const media = source.tagName === "VIDEO" ? document.createElement("video") : document.createElement("img");
  media.src = source.currentSrc || source.src;
  media.alt = source.alt || "Média publié";
  if (media.tagName === "VIDEO") {
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
  }
  media.title = "Touchez l’image pour afficher sa taille réelle";
  media.addEventListener("click", () => media.classList.toggle("is-zoomed"));
  content.append(media);
  $("#mediaLightbox").classList.remove("hidden");
  $("#mediaLightbox").scrollTo({ top: 0, left: 0 });
}
function closeGalleryMedia() {
  $("#mediaLightbox").classList.add("hidden");
  $("#mediaLightboxContent").innerHTML = "";
}
$("#closeMediaLightbox").onclick = closeGalleryMedia;
$("#mediaLightbox").onclick = (event) => {
  if (event.target === $("#mediaLightbox")) closeGalleryMedia();
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#mediaLightbox").classList.contains("hidden")) closeGalleryMedia();
});
async function send(media) {
  if (sendingMessage || privateHomeOpen) return;
  const input = $("#input"), raw = input.value, body = raw.trim();
  if (!body && !media) return;
  if (body.length > 4000) return showError("Votre message dépasse 4 000 caractères.");
  const context = conversationKey(), selectedPrivate = currentPrivate, selectedRoom = currentRoom;
  const selectedReply = replyingTo, once = viewOnceEnabled;
  const button = $("#send");
  sendingMessage = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  saveDraft();
  try {
    const path = selectedPrivate ? "/api/private" : "/api/messages";
    const replyToId = selectedReply && selectedReply.private === Boolean(selectedPrivate) ? selectedReply.id : null;
    const payload = selectedPrivate
      ? { ...media, body, recipientId: selectedPrivate.id, replyToId, viewOnce: Boolean(media && once) }
      : { ...media, body, room: selectedRoom, replyToId };
    const m = await (await api(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    })).json();
    if (conversationDrafts.get(context) === raw) conversationDrafts.delete(context);
    if (context === conversationKey()) {
      addMessage(m, true);
      // Ne pas effacer un nouveau message saisi pendant l’envoi.
      if (input.value === raw) input.value = "";
      saveDraft();
      input.dispatchEvent(new Event("input"));
      if (replyingTo === selectedReply) clearReply();
      if (!input.value) stopTyping();
      if (media) { viewOnceEnabled = false; updateViewOnceButton(); }
      input.focus();
    }
    loadPrivateConversations();
  } catch (e) {
    showError(e.message);
  } finally {
    sendingMessage = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}
$("#send").onclick = () => send();
function stopTyping(target = currentPrivate?.id) {
  clearTimeout(typingTimer);
  const activeTarget = target || typingTarget;
  if (activeTarget) socket?.emit("private-typing", { target: activeTarget, active: false });
  else socket?.emit("typing", false);
  typingActive = false;
  typingTarget = null;
}
function announceTyping() {
  clearTimeout(typingTimer);
  const target = currentPrivate?.id;
  if (!$("#input").value.trim()) return stopTyping(target);
  if (!typingActive || String(typingTarget || "") !== String(target || "")) {
    if (typingActive) stopTyping(typingTarget);
    if (target) socket?.emit("private-typing", { target, active: true });
    else socket?.emit("typing", true);
    typingActive = true;
    typingTarget = target || null;
  }
  typingTimer = setTimeout(() => stopTyping(target), 2500);
}
$("#input").addEventListener("input", announceTyping);
$("#input").addEventListener("input", saveDraft);
$("#input").addEventListener("blur", () => { if (typingActive) stopTyping(typingTarget); });
const touchComposer = window.matchMedia("(max-width: 760px) and (pointer: coarse)");
function syncComposerHint() {
  $("#input").setAttribute("enterkeyhint", touchComposer.matches ? "enter" : "send");
  const hint = $("#composerKeyboardHint");
  if (hint) hint.textContent = touchComposer.matches
    ? "Entrée : nouvelle ligne · Flèche : envoyer"
    : "Entrée : envoyer · Maj + Entrée : nouvelle ligne";
}
touchComposer.addEventListener("change", syncComposerHint);
syncComposerHint();
$("#input").onkeydown = (e) => {
  if (shouldSendOnEnter(e, touchComposer.matches)) {
    e.preventDefault();
    send();
  }
};
// Le sélecteur d’emojis est initialisé dans v4-interface.js.
$("#attach").onclick = () => $("#file").click();
$("#cameraBtn").onclick = () => $("#camera").click();
function updateVoiceTimer() {
  const seconds = Math.floor((Date.now() - voiceStartedAt) / 1000);
  $("#voiceTimer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (seconds >= 120) stopVoiceRecording(true);
}
async function startVoiceRecording() {
  if (voiceRecorder?.state === "recording") return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return showError("L’enregistrement vocal n’est pas disponible sur ce navigateur");
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const supported = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
    voiceChunks = [];
    voiceCancelled = false;
    voiceRecorder = supported ? new MediaRecorder(voiceStream, { mimeType: supported }) : new MediaRecorder(voiceStream);
    voiceRecorder.ondataavailable = event => { if (event.data.size) voiceChunks.push(event.data) };
    voiceRecorder.onstop = async () => {
      clearInterval(voiceInterval);
      voiceInterval = null;
      voiceStream?.getTracks().forEach(track => track.stop());
      voiceStream = null;
      $("#voiceRecording").classList.add("hidden");
      $("#voiceBtn").classList.remove("recording");
      if (voiceCancelled || !voiceChunks.length) return;
      const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || "audio/webm" });
      if (blob.size > 8e6) return showError("Message vocal trop long (8 Mo maximum)");
      const mediaBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob) });
      await send({ mediaBase64, mediaType: (blob.type || "audio/webm").split(";")[0] });
    };
    voiceRecorder.start(250);
    voiceStartedAt = Date.now();
    $("#voiceTimer").textContent = "00:00";
    $("#voiceRecording").classList.remove("hidden");
    $("#voiceBtn").classList.add("recording");
    voiceInterval = setInterval(updateVoiceTimer, 500);
  } catch (error) {
    voiceStream?.getTracks().forEach(track => track.stop());
    voiceStream = null;
    showError(error?.name === "NotAllowedError" ? "Autorisez le microphone pour envoyer un message vocal" : "Impossible d’ouvrir le microphone");
  }
}
function stopVoiceRecording(sendRecording) {
  if (!voiceRecorder || voiceRecorder.state !== "recording") return;
  voiceCancelled = !sendRecording;
  voiceRecorder.stop();
}
$("#voiceBtn").onclick = startVoiceRecording;
$("#cancelVoice").onclick = () => stopVoiceRecording(false);
$("#sendVoice").onclick = () => stopVoiceRecording(true);
$("#file").onchange = $("#camera").onchange = async (e) => {
  const f = e.target.files[0], context = conversationKey();
  e.target.value = "";
  if (!f) return;
  if (sendingMessage) return showError("Un envoi est déjà en cours. Réessayez ensuite.");
  if (f.size > 8e6) return showError("8 Mo maximum");
  if (!/^(image|video|audio)\//.test(f.type)) return showError("Choisissez une photo, une vidéo ou un fichier audio.");
  try {
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Impossible de lire ce fichier."));
      reader.readAsDataURL(f);
    });
    if (context !== conversationKey()) return showError("La conversation a changé. Sélectionnez à nouveau votre fichier.");
    await send({ mediaBase64: b64, mediaType: f.type });
  } catch (error) { showError(error.message); }
};
function showError(t) {
  $("#error").textContent = t;
  $("#error").classList.remove("hidden");
  setTimeout(() => $("#error").classList.add("hidden"), 4000);
}
function updateUnread() {
  const total = [...unreadPrivate.values()].reduce(
      (sum, count) => sum + count,
      0,
    ),
    badge = $("#unreadBadge");
  badge.textContent = total > 99 ? "99+" : String(total);
  badge.classList.toggle("hidden", total === 0);
  const navBadge = $("#privateMessagesNavBadge");
  if (navBadge) {
    navBadge.textContent = total > 99 ? "99+" : String(total);
    navBadge.classList.toggle("hidden", total === 0);
  }
}
function privatePreview(row) {
  if (row.last_body) return row.last_body;
  if (String(row.last_media_type || "").startsWith("audio/")) return "🎙 Message vocal";
  if (String(row.last_media_type || "").startsWith("image/")) return "📷 Photo";
  if (String(row.last_media_type || "").startsWith("video/")) return "🎬 Vidéo";
  return "Nouveau média";
}
function conversationTime(value) {
  const date = new Date(value), now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}
async function loadPrivateConversations() {
  try {
    privateConversations = await (await api("/api/private-conversations")).json();
    unreadPrivate = new Map(
      privateConversations
        .filter(row => Number(row.unread_count) > 0)
        .map(row => [String(row.user_id), Number(row.unread_count)]),
    );
    updateUnread();
    renderPrivateConversations();
    if (privateHomeOpen) renderPrivateMessagesHome();
  } catch (e) {
    showError(e.message);
  }
}
function renderPrivateConversations() {
  const box = $("#conversationList"), total = $("#conversationTotal");
  if (!box || !total) return;
  const unreadTotal = privateConversations.reduce((sum, row) => sum + Number(row.unread_count || 0), 0);
  total.textContent = unreadTotal > 99 ? "99+" : String(unreadTotal);
  total.classList.toggle("hidden", unreadTotal === 0);
  const query = normalizeSearch($("#conversationSearch")?.value);
  const displayed = privateConversations.filter(row => Boolean(row.archived) === showArchivedConversations && normalizeSearch(row.display_name).includes(query));
  $("#activeConversations")?.classList.toggle("active", !showArchivedConversations);
  $("#archivedConversations")?.classList.toggle("active", showArchivedConversations);
  box.innerHTML = displayed.length
    ? displayed.map(row => {
        const unread = Number(row.unread_count || 0), mine = row.last_sender_id === user.uid;
        return `<div class="conversation-item ${unread ? "unread" : ""} ${currentPrivate?.id === String(row.user_id) ? "active" : ""}">
          <button class="conversation-open" data-conversation-id="${safe(row.user_id)}" data-conversation-name="${safe(row.display_name)}">
            <span class="conversation-avatar ${safe(`gender-${row.gender || "neutral"}`)}">${row.photo ? `<img src="${safe(row.photo)}" alt="">` : safe(initials(row.display_name))}</span>
            <span class="conversation-content"><span class="conversation-line"><strong>${safe(row.display_name)}${row.muted ? " 🔕" : ""}</strong><time>${conversationTime(row.last_message_at)}</time></span><span class="conversation-line"><small>${mine ? "Vous : " : ""}${safe(privatePreview(row))}</small>${unread ? `<b>${unread > 99 ? "99+" : unread}</b>` : ""}</span></span>
          </button>
          <span class="conversation-actions"><button data-mute-conversation="${safe(row.user_id)}" title="${row.muted ? "Réactiver les notifications" : "Mettre en sourdine"}">${row.muted ? "🔔" : "🔕"}</button><button data-archive-conversation="${safe(row.user_id)}" title="${row.archived ? "Désarchiver" : "Archiver"}">${row.archived ? "↥" : "▣"}</button><button data-delete-conversation="${safe(row.user_id)}" data-delete-name="${safe(row.display_name)}" title="Supprimer de ma liste">×</button></span>
        </div>`;
      }).join("")
    : `<div class="list-empty"><p>${query ? "Aucune conversation ne correspond à votre recherche." : showArchivedConversations ? "Vous n’avez aucune conversation archivée." : "Votre prochaine discussion commence ici."}</p><button type="button" data-conversation-empty>${query ? "Effacer la recherche" : showArchivedConversations ? "Voir les conversations actives" : "Commencer une discussion"}</button></div>`;
  box.querySelector("[data-conversation-empty]")?.addEventListener("click", () => {
    if (query) {
      $("#conversationSearch").value = "";
      renderPrivateConversations();
      $("#conversationSearch").focus();
    } else if (showArchivedConversations) $("#activeConversations").click();
    else { $(".people").classList.remove("open"); $(".new").click(); }
  });
  box.querySelectorAll("[data-conversation-id]").forEach(button => {
    button.onclick = () => {
      openPrivate(button.dataset.conversationId, button.dataset.conversationName);
      $(".people").classList.remove("open");
    };
  });
  box.querySelectorAll("[data-mute-conversation]").forEach(button => button.onclick = () => {
    const row = privateConversations.find(item => String(item.user_id) === button.dataset.muteConversation);
    updateConversationPreference(row.user_id, { muted: !row.muted });
  });
  box.querySelectorAll("[data-archive-conversation]").forEach(button => button.onclick = () => {
    const row = privateConversations.find(item => String(item.user_id) === button.dataset.archiveConversation);
    updateConversationPreference(row.user_id, { archived: !row.archived });
  });
  box.querySelectorAll("[data-delete-conversation]").forEach(button => button.onclick = () => {
    deleteConversation(button.dataset.deleteConversation, button.dataset.deleteName);
  });
}
async function updateConversationPreference(id, changes) {
  try {
    await api(`/api/private-conversations/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
    });
    await loadPrivateConversations();
  } catch (e) { showError(e.message); }
}
async function deleteConversation(id, name) {
  if (!confirm(`Retirer votre conversation avec ${name} de votre liste ?\n\nElle restera visible chez l’autre personne.`)) return;
  try {
    await api(`/api/private-conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (currentPrivate?.id === String(id)) {
      selectRoom(roomLinks.find(link => link.dataset.room === currentRoom), currentRoom);
    }
    conversationDrafts.delete(`private:${id}`);
    await loadPrivateConversations();
  } catch (e) { showError(e.message); }
}
$("#activeConversations").onclick = () => { showArchivedConversations = false; renderPrivateConversations(); };
$("#archivedConversations").onclick = () => { showArchivedConversations = true; renderPrivateConversations(); };
function openPrivate(id, name) {
  if (!user || id === null || id === undefined || !String(id).trim()) return;
  id = String(id).trim();
  name = String(name || "Utilisateur");
  closeMemberPanels();
  if (id === String(user.uid)) return showProfile();
  if (blockedUsers.has(id))
    return showError("Cet utilisateur est bloqué");
  if (!privateHomeOpen && currentPrivate?.id === id) {
    focusPrivateComposer(id);
    return;
  }
  saveDraft();
  if (typingActive) stopTyping();
  const previousPrivateId = currentPrivate?.id;
  if (previousPrivateId && previousPrivateId !== String(id)) stopTyping(previousPrivateId);
  clearReply();
  privateHomeOpen = false;
  $(".chat").classList.remove("private-home");
  unreadPrivate.delete(id);
  updateUnread();
  currentPrivate = { id, name };
  restoreDraft();
  $("#privateMessagesLink").classList.add("active");
  roomLinks.forEach(item => { item.classList.remove("active"); item.setAttribute("aria-current", "false"); });
  privateContactStatus = null;
  socket?.emit("watch-private-status", id);
  updateViewOnceButton();
  renderPrivateConversations();
  $("#blockBtn").classList.remove("hidden");
  $("#privateProfileBtn").classList.remove("hidden");
  $("#reportBtn").classList.remove("hidden");
  $(".chat header h1").innerHTML = memberLink(id, name, `✉ ${safe(name)}`);
  $("#roomPresence").classList.add("hidden");
  $("#privateTypingStatus").textContent = "Chargement du statut…";
  $("#privateTypingStatus").classList.remove("hidden", "is-typing");
  $("#typing").textContent = "";
  load();
  focusPrivateComposer(id);
}
function closeMemberPanels() {
  ["#searchModal", "#notificationsModal", "#onlineMembersModal", "#publicProfileModal", "#contactPickerModal", "#adminModal", "#mobileActionsModal"].forEach(selector => $(selector)?.classList.add("hidden"));
  $(".side")?.classList.remove("open");
  $(".people")?.classList.remove("open");
  $("#mobileNavMore")?.setAttribute("aria-expanded", "false");
  viewedProfile = null;
}
function focusPrivateComposer(id) {
  // Passe après le retour de focus des fenêtres qui viennent de se fermer.
  queueMicrotask(() => {
    if (!privateHomeOpen && currentPrivate?.id === id) $("#input").focus({ preventScroll: true });
  });
}
$("#privateProfileBtn").onclick = () => {
  if (currentPrivate) showPublicProfile(currentPrivate.id, currentPrivate.name);
};
function showPrivateNotification(m) {
  loadPrivateConversations();
  if (m.user_id === user.uid || blockedUsers.has(String(m.user_id))) return;
  const senderId = String(m.user_id),
    senderName = m.author || "Nouveau contact";
  const preference = privateConversations.find(row => String(row.user_id) === senderId);
  markPrivateDelivered(senderId);
  if (currentPrivate?.id === senderId) {
    addMessage(m);
    if (document.visibilityState === "visible") markPrivateRead(senderId);
    return;
  }
  unreadPrivate.set(senderId, (unreadPrivate.get(senderId) || 0) + 1);
  updateUnread();
  if (preference?.muted) return;
  const toast = $("#messageToast");
  toast.textContent = `💬 ${senderName} : ${m.body || "Nouveau média"}`;
  toast.classList.remove("hidden");
  toast.onclick = () => {
    toast.classList.add("hidden");
    openPrivate(senderId, senderName);
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 6000);
  if (
    "Notification" in window &&
    Notification.permission === "granted" &&
    document.visibilityState !== "visible"
  )
    try {
      const n = new Notification(`Message de ${senderName}`, {
        body: m.body || "Vous a envoyé un média",
        icon: m.photo || undefined,
        tag: `private-${senderId}`,
      });
      n.onclick = () => {
        window.focus();
        openPrivate(senderId, senderName);
        n.close();
      };
    } catch {}
}
function formatLastSeen(value) {
  if (!value) return "Hors ligne";
  const date = new Date(value), seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Vu à l’instant";
  if (seconds < 3600) return `Vu il y a ${Math.floor(seconds / 60)} min`;
  if (date.toDateString() === new Date().toDateString())
    return `Vu aujourd’hui à ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  return `Vu le ${date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} à ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}
function privateStatusText(status) {
  if (status?.presence_hidden) return "Présence masquée";
  if (!status?.online) return formatLastSeen(status?.lastSeen);
  if (status.availability === "busy") return "Occupé";
  if (status.availability === "away") return "Absent";
  return "En ligne";
}
function renderPrivateContactStatus() {
  if (!currentPrivate) return;
  const status = $("#privateTypingStatus");
  status.textContent = privateStatusText(privateContactStatus);
  status.classList.remove("is-typing");
  status.classList.toggle("is-offline", !privateContactStatus?.online);
  status.classList.toggle("is-busy", privateContactStatus?.online && privateContactStatus.availability === "busy");
  status.classList.toggle("is-away", privateContactStatus?.online && privateContactStatus.availability === "away");
}
setInterval(() => {
  if (currentPrivate && !$("#privateTypingStatus").classList.contains("is-typing")) renderPrivateContactStatus();
}, 30000);
async function requestNotifications() {
  if ("Notification" in window && Notification.permission === "default")
    try {
      await Notification.requestPermission();
    } catch {}
}
async function checkRules() {
  try {
    const status = await (await api("/api/rules-status")).json();
    $("#rulesModal").classList.toggle("hidden", status.accepted);
  } catch (e) {
    showError(e.message);
  }
}
$("#rulesForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#rulesForm button[type=submit]");
  button.disabled = true;
  $("#rulesError").textContent = "";
  try {
    await api("/api/rules-accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: $("#rulesAccepted").checked }),
    });
    $("#rulesModal").classList.add("hidden");
    showError("Règles acceptées. Bienvenue sur Letchat !");
  } catch (e) {
    $("#rulesError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
async function loadNotifications() {
  try {
    notifications = await (await api("/api/notifications")).json();
    updateNotifications();
    renderNotifications();
  } catch (e) {
    showError(e.message);
  }
}
function updateNotifications() {
  const count = notifications.filter((item) => !item.read_at).length,
    badge = $("#notificationsBadge");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("hidden", count === 0);
}
function notificationIcon(type) {
  return (
    {
      friend_request: "👤",
      friend_accepted: "✓",
      private_message: "💬",
      report_update: "🛡",
    }[type] || "🔔"
  );
}
function renderNotifications() {
  const box = $("#notificationsList");
  if (!box) return;
  box.innerHTML = notifications.length
    ? notifications
        .map(
          (item) =>
            `<div class="notification-entry">${item.actor_id ? `<div class="notification-author">${memberLink(item.actor_id, item.actor_name)}</div>` : ""}<button class="notification-item ${item.read_at ? "" : "unread"}" data-notification-id="${item.id}" data-notification-type="${safe(item.type)}" data-actor-id="${safe(item.actor_id || "")}" data-actor-name="${safe(item.actor_name || "Utilisateur")}"><span class="notification-icon">${notificationIcon(item.type)}</span><span><strong>${safe(item.actor_id ? ({ private_message: "Nouveau message privé", friend_request: "Demande d’ami", friend_accepted: "Demande d’ami acceptée" }[item.type] || item.title) : item.title)}</strong><small>${safe(item.body)}</small><time>${new Date(item.created_at).toLocaleString("fr-FR")}</time></span></button></div>`,
        )
        .join("")
    : '<p class="notifications-empty">Aucune notification.</p>';
  box
    .querySelectorAll(".notification-item")
    .forEach((button) => (button.onclick = () => openNotification(button)));
}
async function openNotification(button) {
  const type = button.dataset.notificationType,
    actorId = button.dataset.actorId,
    actorName = button.dataset.actorName;
  $("#notificationsModal").classList.add("hidden");
  if (type === "private_message" && actorId) openPrivate(actorId, actorName);
  else if (type === "friend_request" || type === "friend_accepted") {
    $(".people").classList.add("open");
    await loadFriends();
  }
}
$("#notificationsBtn").onclick = async () => {
  $("#notificationsModal").classList.remove("hidden");
  renderNotifications();
  try {
    await api("/api/notifications/read", { method: "PATCH" });
    notifications = notifications.map((item) => ({
      ...item,
      read_at: item.read_at || new Date().toISOString(),
    }));
    updateNotifications();
    renderNotifications();
  } catch (e) {
    showError(e.message);
  }
};
$("#closeNotifications").onclick = () =>
  $("#notificationsModal").classList.add("hidden");
function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function performSearch() {
  const query = normalizeSearch($("#searchInput").value),
    results = $("#searchResults");
  if (!query) {
    results.innerHTML =
      '<p class="search-empty">Commencez à écrire pour rechercher.</p>';
    return;
  }
  const messages = [...document.querySelectorAll("#messages .message")]
      .filter((article) => normalizeSearch(article.textContent).includes(query))
      .slice(0, 30),
    contacts = new Map();
  lastPeople.forEach((person) =>
    contacts.set(String(person.id), {
      id: String(person.id),
      name: person.name || "Utilisateur",
      photo: person.photo || "",
      detail: person.location?.city || "En ligne",
    }),
  );
  friendRelations.forEach((row) =>
    contacts.set(String(row.user_id), {
      id: String(row.user_id),
      name: row.display_name || "Utilisateur",
      photo: row.photo || "",
      detail: row.status === "accepted" ? "Ami" : "Contact",
    }),
  );
  const contactMatches = [...contacts.values()]
      .filter(
        (contact) =>
          contact.id !== user.uid &&
          normalizeSearch(`${contact.name} ${contact.detail}`).includes(query),
      )
      .slice(0, 30),
    messageHtml = messages
      .map((article) => {
        const author =
            article.querySelector(".meta strong")?.textContent || "Message",
          body =
            article.querySelector(".bubble")?.textContent ||
            article.querySelector(".message-quote span")?.textContent ||
            "Média partagé";
        return `<div class="search-result search-message-result"><span class="search-result-icon">💬</span><div class="search-message-summary"><strong>${memberLink(article.dataset.authorId, article.dataset.authorName, safe(author))}</strong><button type="button" class="search-message-jump" data-search-message="${safe(article.dataset.key)}" title="Retrouver ce message"><small>${safe(body.slice(0, 120))}</small></button></div></div>`;
      })
      .join(""),
    contactHtml = contactMatches
      .map(
        (contact) =>
          `<button class="search-result search-contact-result" data-search-contact="${safe(contact.id)}" data-search-name="${safe(contact.name)}">${contact.photo ? `<img src="${safe(contact.photo)}">` : '<span class="search-result-icon">👤</span>'}<span><strong>${safe(contact.name)}</strong><small>${safe(contact.detail)}</small></span></button>`,
      )
      .join("");
  results.innerHTML = `<section><h3>Messages (${messages.length})</h3>${messageHtml || '<p class="search-empty">Aucun message trouvé.</p>'}</section><section><h3>Contacts (${contactMatches.length})</h3>${contactHtml || '<p class="search-empty">Aucun contact trouvé.</p>'}</section>`;
  results.querySelectorAll("[data-search-message]").forEach(
    (button) =>
      (button.onclick = () => {
        const article = document.querySelector(
          `[data-key="${CSS.escape(button.dataset.searchMessage)}"]`,
        );
        $("#searchModal").classList.add("hidden");
        if (article) {
          article.scrollIntoView({ behavior: "smooth", block: "center" });
          article.classList.add("search-highlight");
          setTimeout(() => article.classList.remove("search-highlight"), 1800);
        }
      }),
  );
  results.querySelectorAll("[data-search-contact]").forEach(
    (button) =>
      (button.onclick = () => {
        $("#searchModal").classList.add("hidden");
        openPrivate(button.dataset.searchContact, button.dataset.searchName);
      }),
  );
}
$("#searchBtn").onclick = () => {
  $("#searchModal").classList.remove("hidden");
  $("#searchInput").value = "";
  performSearch();
  setTimeout(() => $("#searchInput").focus(), 50);
};
$("#closeSearch").onclick = () => $("#searchModal").classList.add("hidden");
$("#searchInput").oninput = performSearch;
$("#searchModal").onclick = (event) => {
  if (event.target === $("#searchModal"))
    $("#searchModal").classList.add("hidden");
};
async function loadFriends() {
  try {
    const rows = await (await api("/api/friends")).json();
    friendRelations = new Map(rows.map((row) => [String(row.user_id), row]));
    renderFriends();
    if (viewedProfile && !$("#publicProfileModal").classList.contains("hidden")) updateProfileFriendButton();
    if (lastPeople.length) renderPeople(lastPeople);
  } catch (e) {
    showError(e.message);
  }
}
function isOnline(id) {
  return !blockedUsers.has(String(id)) && (allOnlineMembers ?? lastPeople)
    .some((person) => String(person.id) === String(id));
}
function refreshContactPresence() {
  renderFriends();
  if (privateHomeOpen) renderPrivateMessagesHome();
  if (!$("#contactPickerModal").classList.contains("hidden")) openContactPicker(contactPickerMode);
}
function renderFriends() {
  const requests = $("#friendRequests"),
    friends = $("#friendsList");
  if (!requests || !friends) return;
  const query = normalizeSearch($("#friendSearch")?.value);
  const rows = [...friendRelations.values()],
    incoming = rows.filter(
      (row) => row.status === "pending" && row.direction === "incoming",
    ),
    accepted = rows.filter((row) => row.status === "accepted" && normalizeSearch(row.display_name).includes(query))
      .sort((a, b) => Number(isOnline(b.user_id)) - Number(isOnline(a.user_id)) || a.display_name.localeCompare(b.display_name, "fr"));
  const outgoing = rows.filter(row => row.status === "pending" && row.direction === "outgoing");
  $("#friendRequestCount").textContent = incoming.length ? ` · ${incoming.length} demande${incoming.length > 1 ? "s" : ""}` : "";
  requests.innerHTML = incoming.length
    ? `<h3>Demandes reçues</h3>${incoming.map((row) => `<div class="friend-card">${memberLink(row.user_id, row.display_name)}<div><button data-accept-friend="${row.id}">Accepter</button><button data-remove-friend="${row.id}">Refuser</button></div></div>`).join("")}`
    : "";
  if (outgoing.length) requests.innerHTML += `<details class="outgoing-requests"><summary>Demandes envoyées (${outgoing.length})</summary>${outgoing.map(row => `<div class="friend-card">${memberLink(row.user_id, row.display_name)}<button type="button" data-remove-friend="${safe(row.id)}">Annuler</button></div>`).join("")}</details>`;
  friends.innerHTML = accepted.length
    ? `<h3>Mes amis</h3>${accepted.map((row) => `<div class="friend-card"><button class="friend-open" data-friend-id="${safe(row.user_id)}" data-friend-name="${safe(row.display_name)}"><span class="online-dot ${isOnline(row.user_id) ? "online" : ""}"></span>${safe(row.display_name)}</button><button class="friend-remove" data-remove-friend="${row.id}" title="Supprimer cet ami">×</button></div>`).join("")}`
    : `<div class="list-empty"><p>${query ? "Aucun ami ne correspond à votre recherche." : "Retrouvez des membres et ajoutez-les à vos amis depuis leur profil."}</p><button type="button" data-friends-empty>${query ? "Effacer la recherche" : "Découvrir les membres"}</button></div>`;
  friends.querySelector("[data-friends-empty]")?.addEventListener("click", () => {
    if (query) {
      $("#friendSearch").value = "";
      renderFriends();
      $("#friendSearch").focus();
    } else $("#onlineMembersLink").click();
  });
  document
    .querySelectorAll("[data-accept-friend]")
    .forEach(
      (button) =>
        (button.onclick = () => acceptFriend(button.dataset.acceptFriend)),
    );
  document
    .querySelectorAll("[data-remove-friend]")
    .forEach(
      (button) =>
        (button.onclick = () => removeFriend(button.dataset.removeFriend)),
    );
  document.querySelectorAll(".friend-open").forEach(
    (button) =>
      (button.onclick = () => {
        openPrivate(button.dataset.friendId, button.dataset.friendName);
        $(".people").classList.remove("open");
      }),
  );
}
async function sendFriendRequest(id) {
  try {
    await api(`/api/friends/${encodeURIComponent(id)}`, { method: "POST" });
    await loadFriends();
    showError("Demande d’ami envoyée");
  } catch (e) {
    showError(e.message);
  }
}
async function acceptFriend(id) {
  try {
    await api(`/api/friends/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    });
    await loadFriends();
    showError("Demande acceptée");
  } catch (e) {
    showError(e.message);
  }
}
async function removeFriend(id) {
  if (!confirm("Supprimer cette demande ou cet ami ?")) return;
  try {
    await api(`/api/friends/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadFriends();
  } catch (e) {
    showError(e.message);
  }
}
function renderPeople(list) {
  lastPeople = list;
  list = list.filter((person) => !blockedUsers.has(String(person.id)));
  $("#onlineCount").textContent = list.length;
  const groups = new Map();
  list.forEach((person) => {
    const key = person.location?.city || "Ville masquée";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(person);
  });
  $("#people").innerHTML = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "fr"))
    .map(
      ([place, people]) =>
        `<section class="location-group"><h3>${safe(place)}</h3>${people
          .map((p) => {
            const gender = ["female", "male"].includes(p.gender)
                ? p.gender
                : "neutral",
              relation = friendRelations.get(String(p.id));
            let action = "";
            if (p.id !== user.uid) {
              if (!relation)
                action = `<button class="friend-action" data-add-friend="${safe(p.id)}" title="Ajouter en ami">＋ Ami</button>`;
              else if (relation.status === "accepted")
                action = '<span class="friend-state">✓ Ami</span>';
              else action = '<span class="friend-state">En attente</span>';
            }
            const statusLabel={available:"Disponible",busy:"Occupé",away:"Absent"}[p.availability]||"Disponible";
            return `<div class="person-row gender-${gender}"><button class="person person-button" data-user-id="${safe(p.id)}" data-user-name="${safe(p.name)}"><span class="member-avatar">${p.photo ? `<img src="${safe(p.photo)}" alt="">` : safe(initials(p.name))}</span><div><strong>${safe(p.name)}${p.verified ? '<span class="verified-badge" title="Profil vérifié">✓</span>' : ""}</strong><small>${p.id===user.uid?"Vous":`${statusLabel}${p.bio?` · ${safe(p.bio)}`:""}`}</small></div></button>${action}</div>`;
          })
          .join("")}</section>`,
    )
    .join("");
  document.querySelectorAll(".person-button").forEach(
    (button) =>
      (button.onclick = () => {
        openPrivate(button.dataset.userId, button.dataset.userName);
        $(".people").classList.remove("open");
      }),
  );
  document
    .querySelectorAll("[data-add-friend]")
    .forEach(
      (button) =>
        (button.onclick = () => sendFriendRequest(button.dataset.addFriend)),
    );
  updateRoomFeature();
  refreshContactPresence();
}
function connect() {
  socket?.disconnect();
  socket = io({ auth: async callback => {
    try { token = await user.getIdToken(); callback({ token }); }
    catch { callback({ token: "" }); }
  }, transports: ["websocket", "polling"] });
  surpriseFeatures?.bind(socket);
  socket.on("session-expired", async () => {
    hang();
    if (localSessionToken) return logoutSession();
    try { token = await user.getIdToken(true); socket.auth = { token }; socket.connect(); }
    catch { logoutSession(); }
  });
  socket.on("session-revoked", logoutSession);
  socket.on("account-deleted", logoutSession);
  connectionStatus("Connexion…", "waiting");
  socket.on("disconnect", () => {
    hang(false);
    connectionStatus("Reconnexion…", "waiting");
    allOnlineMembers = null;
    renderPeople([]);
    renderOnlineMembers();
  });
  socket.on("connect", () => {
    connectionStatus("En direct", "online");
    socket.emit("join-room", currentRoom);
    if (currentPrivate) socket.emit("watch-private-status", currentPrivate.id);
    // Les événements reçus pendant une coupure ne sont pas rejoués par le serveur.
    loadPrivateConversations();
    loadNotifications();
    load();
  });
  socket.on("premium-room-denied", () => {
    premiumRoomUnlocked = false;
    if (rooms[currentRoom]?.premium === true)
      selectRoom(roomLinks.find(link => link.dataset.room === "cafe"), "cafe");
    $("#premiumRoomGate").classList.remove("hidden");
  });
  socket.on("premium-room-revoked", () => {
    premiumRoomUnlocked = false;
    if (rooms[currentRoom]?.premium === true)
      selectRoom(roomLinks.find(link => link.dataset.room === "cafe"), "cafe");
    showError("Votre abonnement Premium ne donne plus accès aux salons de l’espace adulte.");
  });
  socket.on("message", (m) => addMessage(m));
  socket.on("message-pinned", () => { if (!currentPrivate && currentRoom === "cafe") load(); });
  socket.on("room-activity", ({ room, userId } = {}) => {
    if (!rooms[room] || userId === user.uid || (!currentPrivate && room === currentRoom)) return;
    roomUnread.set(room, (roomUnread.get(room) || 0) + 1);
    updateRoomBadges();
  });
  socket.on("private-message", showPrivateNotification);
  socket.on("private-receipt", updatePrivateReceipts);
  socket.on("private-typing", data => {
    if (!currentPrivate || String(data.userId) !== String(currentPrivate.id)) return;
    const status = $("#privateTypingStatus");
    if (data.active) {
      status.textContent = "écrit…";
      status.classList.remove("is-offline", "is-busy", "is-away");
    }
    else renderPrivateContactStatus();
    status.classList.toggle("is-typing", data.active);
  });
  socket.on("private-status", data => {
    if (!currentPrivate || String(data.userId) !== String(currentPrivate.id)) return;
    privateContactStatus = data;
    if (!$("#privateTypingStatus").classList.contains("is-typing")) renderPrivateContactStatus();
  });
  socket.on("view-once-opened", payload => {
    const article = document.querySelector(`[data-key="p-${CSS.escape(String(payload.id))}"]`);
    if (article) {
      article.querySelector(".view-once-open, .media")?.replaceWith(Object.assign(document.createElement("div"), { className: "view-once-expired", textContent: "✓ Média ouvert" }));
    }
  });
  socket.on("message-reactions", updateMessageReactions);
  socket.on("message-deleted", (payload) => {
    removeMessage(payload.id, payload.private);
    if (payload.private) loadPrivateConversations();
  });
  socket.on("friends-updated", loadFriends);
  socket.on("notification", (notification) => {
    notifications.unshift(notification);
    updateNotifications();
    renderNotifications();
  });
  socket.on("messages-expired", (ids) =>
    ids.forEach((id) => removeMessage(id, false)),
  );
  socket.on("private-messages-expired", (ids) =>
    (ids.forEach((id) => removeMessage(id, true)), loadPrivateConversations()),
  );
  socket.on("presence", renderPeople);
  socket.on("online-members", members => {
    allOnlineMembers = Array.isArray(members) ? members : [];
    renderOnlineMembers();
    refreshContactPresence();
  });
  socket.on(
    "typing",
    (d) =>
      !currentPrivate &&
      ($("#typing").innerHTML = d.active ? `${memberLink(d.userId, d.name)} écrit…` : ""),
  );
  socket.on("webrtc", handleSignal);
  socket.on("webrtc-error", ({ error } = {}) => {
    hang(); showError(error || "Appel vidéo refusé");
  });
  socket.on("connect_error", () => { connectionStatus("Connexion interrompue", "offline"); });
}
async function loadBlocks() {
  try {
    const rows = await (await api("/api/blocks")).json();
    blockedUsers = new Map(rows.map((row) => [String(row.user_id), row]));
    renderBlockedUsers();
    renderOnlineMembers();
    if (lastPeople.length) renderPeople(lastPeople);
  } catch (e) {
    showError(e.message);
  }
}
function renderBlockedUsers() {
  const box = $("#blockedUsers");
  if (!box) return;
  const rows = [...blockedUsers.values()];
  box.innerHTML = rows.length
    ? rows
        .map(
          (row) =>
            `<div class="blocked-person"><span>${safe(row.display_name || "Utilisateur")}</span><button type="button" data-unblock="${safe(row.user_id)}">Débloquer</button></div>`,
        )
        .join("")
    : `<p class="no-blocks">Aucun utilisateur bloqué.</p>`;
  box.querySelectorAll("[data-unblock]").forEach(
    (button) =>
      (button.onclick = async () => {
        try {
          await api(
            `/api/blocks/${encodeURIComponent(button.dataset.unblock)}`,
            { method: "DELETE" },
          );
          blockedUsers.delete(button.dataset.unblock);
          renderBlockedUsers();
          renderPeople(lastPeople);
          load();
        } catch (e) {
          showError(e.message);
        }
      }),
  );
}
function openProfile(profile) {
  $("#profileName").value =
    profile?.display_name || user?.displayName || user?.email || "";
  $("#profileCity").value = profile?.city || "";
  $("#profileBio").value = profile?.bio || "";
  $("#profileGender").value = profile?.gender || "neutral";
  $("#profileAvailability").value = profile?.availability || "available";
  $("#profilePrivateMessages").value = profile?.private_message_policy || "everyone";
  pendingProfilePhoto = null;
  setProfileAvatar($("#profilePhotoPreview"), $("#profileName").value, profile?.photo || user?.photoURL);
  $("#profileVisible").checked = profile?.location_visible !== false;
  $("#profileModal").classList.remove("hidden");
}
$("#chooseProfilePhoto").onclick=()=>$("#profilePhotoInput").click();
$("#profilePhotoInput").onchange=async event=>{const file=event.target.files[0];if(!file)return;if(file.size>8e6)return showError("Photo trop volumineuse");try{pendingProfilePhoto=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const image=new Image();image.onerror=reject;image.onload=()=>{const size=512,canvas=document.createElement("canvas");canvas.width=size;canvas.height=size;const context=canvas.getContext("2d"),side=Math.min(image.width,image.height),sx=(image.width-side)/2,sy=(image.height-side)/2;context.drawImage(image,sx,sy,side,side,0,0,size,size);resolve(canvas.toDataURL("image/jpeg",.82))};image.src=reader.result};reader.readAsDataURL(file)});setProfileAvatar($("#profilePhotoPreview"),$("#profileName").value,pendingProfilePhoto)}catch{showError("Impossible de préparer cette photo")}};
const availabilityLabels={available:"Disponible",busy:"Occupé",away:"Absent"};
async function showPublicProfile(id, fallbackName = "Utilisateur") {
  if (String(id) === String(user.uid)) return showProfile();
  const request = { id: String(id), name: fallbackName };
  viewedProfile = request;
  socialFeatures?.showRichProfile(id);
  $("#publicProfileError").textContent = "";
  $("#publicProfileName").innerHTML = memberLink(id, fallbackName);
  $("#publicProfilePhotoLink").hidden = true;
  $("#publicProfilePhoto").removeAttribute("src");
  $("#publicProfilePhoto").hidden = true;
  $("#publicProfileStatus").textContent = "Chargement…";
  ["#publicProfileBio", "#publicProfileCity", "#publicProfileLastSeen"].forEach(selector => $(selector).textContent = "");
  ["#publicProfileMessage", "#publicProfileFriend", "#publicProfileCall", "#publicProfileMore"].forEach(selector => $(selector).disabled = true);
  $("#publicProfileMoreMenu").classList.add("hidden");
  $("#publicProfileMore").setAttribute("aria-expanded", "false");
  $("#publicProfileModal").classList.remove("hidden");
  try {
    const profile = await (await api(`/api/profile/${encodeURIComponent(id)}`)).json();
    if (viewedProfile !== request) return;
    viewedProfile.name = profile.display_name;
    $("#publicProfilePhoto").hidden = !profile.photo;
    const photoLink = $("#publicProfilePhotoLink");
    photoLink.hidden = !profile.photo;
    photoLink.dataset.privateUser = String(id);
    photoLink.dataset.privateName = profile.display_name;
    photoLink.setAttribute("aria-label", `Écrire en privé à ${profile.display_name}`);
    photoLink.title = `Écrire en privé à ${profile.display_name}`;
    if (profile.photo) $("#publicProfilePhoto").src = profile.photo;
    $("#publicProfileName").innerHTML = `${memberLink(id, profile.display_name)}${profile.verified ? '<span class="verified-badge" title="Profil vérifié">✓</span>' : ""}`;
    $("#publicProfileStatus").textContent = profile.presence_hidden ? "Présence masquée" : availabilityLabels[profile.availability] || "Disponible";
    $("#publicProfileBio").textContent = profile.bio || "Ce membre n’a pas encore ajouté de description.";
    $("#publicProfileCity").textContent = profile.city || "Ville masquée";
    $("#publicProfileLastSeen").textContent = profile.presence_hidden ? "Masquée" : isOnline(profile.user_id) ? "En ligne maintenant" : profile.last_seen ? new Date(profile.last_seen).toLocaleString("fr-FR") : "Non disponible";
    ["#publicProfileMessage", "#publicProfileCall", "#publicProfileMore"].forEach(selector => $(selector).disabled = false);
    updateProfileFriendButton();
  } catch (e) {
    if (viewedProfile === request) { $("#publicProfileStatus").textContent = "Profil indisponible"; $("#publicProfileError").textContent = e.message; }
  }
}
function updateProfileFriendButton() {
  const button = $("#publicProfileFriend"), relation = friendRelations.get(viewedProfile?.id);
  button.classList.remove("hidden");
  button.disabled = Boolean(relation);
  button.textContent = relation?.status === "accepted" ? "✓ Déjà amis" : relation?.direction === "incoming" ? "Demande reçue · voir Contacts" : relation ? "Demande envoyée" : "＋ Ajouter en ami";
}
$("#closePublicProfile").onclick=()=>$("#publicProfileModal").classList.add("hidden");
$("#publicProfileMessage").onclick=()=>{if(!viewedProfile)return;$("#publicProfileModal").classList.add("hidden");openPrivate(viewedProfile.id,viewedProfile.name)};
$("#publicProfileFriend").onclick = async () => {
  if (!viewedProfile) return;
  const request = viewedProfile;
  $("#publicProfileFriend").disabled = true;
  await sendFriendRequest(request.id);
  if (viewedProfile === request) updateProfileFriendButton();
};
  $("#publicProfileCall").onclick = async () => {
  if (!viewedProfile) return;
  const person = lastPeople.find(p => String(p.id) === String(viewedProfile.id));
  if (!person?.socketId) {
    $("#publicProfileError").textContent = "Ce membre n’est plus disponible pour un appel.";
    return;
  }
  $("#publicProfileModal").classList.add("hidden");
  await startDirectCall(person.socketId, viewedProfile.name);
};

$("#publicProfileMore").onclick = () => {
  const menu = $("#publicProfileMoreMenu");
  const isOpen = menu.classList.toggle("hidden") === false;
  $("#publicProfileMore").setAttribute("aria-expanded", String(isOpen));
};

$("#publicProfileReport").onclick = () => {
  if (!viewedProfile) return;
  const target = { ...viewedProfile };
  $("#publicProfileMoreMenu").classList.add("hidden");
  $("#publicProfileModal").classList.add("hidden");
  openReport(target);
};

$("#publicProfileBlock").onclick = async () => {
  if (!viewedProfile) return;
  const target = { ...viewedProfile };
  if (!confirm(`Bloquer ${target.name} ? Cette personne ne pourra plus vous écrire.`)) return;
  try {
    await api(`/api/blocks/${encodeURIComponent(target.id)}`, { method: "POST" });
    blockedUsers.set(String(target.id), {
      user_id: String(target.id),
      display_name: target.name
    });
    await loadFriends();
    $("#publicProfileMoreMenu").classList.add("hidden");
    $("#publicProfileModal").classList.add("hidden");
    renderBlockedUsers();
    renderPeople(lastPeople);
  } catch (error) {
    $("#publicProfileError").textContent = error.message;
  }
};

$("#publicProfileFriend").onclick = async () => {
  if (!viewedProfile) return;
  await sendFriendRequest(viewedProfile.id);
  $("#publicProfileFriend").classList.add("hidden");
};
async function loadProfile() {
  try {
    const profile = await (await api("/api/profile")).json();
    if (!profile) openProfile(null);
  } catch (e) {
    showError(e.message);
  }
}
async function showProfile() {
  openProfile(null);
  renderBlockedUsers();
  try {
    openProfile(await (await api("/api/profile")).json());
  } catch (e) {
    $("#profileError").textContent = e.message;
  }
}
$("#profileBtn").onclick = showProfile;
$("#mobileProfileBtn").onclick = showProfile;
$("#premiumShortcut").onclick = async () => {
  await showProfile();
  $(".premium-box").scrollIntoView({ behavior: "smooth", block: "start" });
};
$("#closeProfile").onclick = () => $("#profileModal").classList.add("hidden");
$("#profileForm").onsubmit = async (event) => {
  event.preventDefault();
  $("#profileError").textContent = "";
  try {
    const profile = await (
      await api("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: $("#profileName").value,
          city: $("#profileCity").value,
          bio: $("#profileBio").value,
          gender: $("#profileGender").value,
          availability: $("#profileAvailability").value,
          privateMessagePolicy: $("#profilePrivateMessages").value,
          photoData: pendingProfilePhoto,
          locationVisible: $("#profileVisible").checked,
        }),
      })
    ).json();
    $("#meName").textContent = profile.display_name;
    setProfileAvatar($("#mePhoto"), profile.display_name, profile.photo);
    $("#profileModal").classList.add("hidden");
  } catch (e) {
    $("#profileError").textContent = e.message;
  }
};
async function loadContactEmail() {
  try {
    const data = await (await fetch("/api/public-config")).json(),
      link = $("#contactEmail");
    if (data.contactEmail) {
      link.textContent = data.contactEmail;
      link.href = `mailto:${data.contactEmail}`;
    } else {
      link.textContent = "Adresse à configurer dans Render";
      link.removeAttribute("href");
    }
  } catch {}
}
async function loadSubscription() {
  try {
    const query = new URLSearchParams(location.search);
    const paymentReturn = query.get("premium");
    const sessionId = paymentReturn === "success" ? query.get("session_id") : null;
    const path = sessionId ? `/api/subscription?session_id=${encodeURIComponent(sessionId)}` : "/api/subscription";
    const data = await (await api(path)).json();
    premiumRoomUnlocked = Boolean(data.premium);
    const label = data.plan === "premium_plus" ? "Premium+" : "Premium";
    const statusLabels = {
      past_due: "Paiement en attente — vérifiez votre moyen de paiement",
      unpaid: "Paiement non réglé — gérez votre abonnement",
      canceled: "Abonnement terminé — compte gratuit",
      incomplete: "Paiement non terminé — compte gratuit"
    };
    $("#premiumState").textContent = data.premium
      ? `${label} actif — vos avantages sont disponibles`
      : paymentReturn === "success" ? "Paiement en cours de confirmation. Actualisez dans quelques instants."
      : paymentReturn === "cancel" ? "Paiement annulé — aucun changement à votre compte"
      : statusLabels[data.status] || "Compte gratuit — espace adulte réservé aux membres Premium";
    const renewal = $("#premiumRenewal");
    renewal.classList.toggle("hidden", !data.premium || !data.currentPeriodEnd);
    if (data.premium && data.currentPeriodEnd)
      renewal.textContent = `Période en cours jusqu'au ${new Date(data.currentPeriodEnd).toLocaleDateString("fr-FR")}. Gérez la prochaine échéance dans Stripe.`;
    $("#premiumChoices").classList.toggle("hidden", data.premium || data.canManage || Boolean(user.guest));
    if (user.guest) $("#premiumState").textContent = "Compte invité : créez un compte permanent pour vous abonner.";
    $("#recoverySettings").classList.toggle("hidden", !user.local || user.guest);
    $("#managePremium").classList.toggle("hidden", !data.canManage);
    $("#premiumBadge").classList.toggle("hidden", !data.premium);
    premiumFeatures?.refresh().catch(() => {});
    $("#callBtn").classList.remove("hidden");
    $("#callBtn").disabled = false;
    if (paymentReturn) {
      query.delete("premium");
      query.delete("session_id");
      history.replaceState(null, "", location.pathname + (query.size ? `?${query}` : "") + location.hash);
    }
  } catch (e) {
    $("#premiumState").textContent = "Impossible de vérifier l'abonnement. Réessayez en rouvrant votre profil.";
    console.error("Abonnement :", e);
  }
  try {
    const { plans } = await (await fetch("/api/premium/plans")).json();
    for (const [id, buttonId, priceId] of [
      ["premium", "subscribePremium", "premiumPrice"],
      ["premium_plus", "subscribePremiumPlus", "premiumPlusPrice"]
    ]) {
      const plan = plans?.find(item => item.id === id);
      const button = $(`#${buttonId}`);
      button.disabled = !plan?.available || Boolean(user.guest);
      $(`#${priceId}`).textContent = plan?.available && Number.isInteger(plan.amount)
        ? `${new Intl.NumberFormat("fr-FR", { style: "currency", currency: plan.currency.toUpperCase() }).format(plan.amount / 100)} / ${plan.intervalCount > 1 ? `${plan.intervalCount} ` : ""}${plan.interval === "year" ? "an" : plan.interval === "month" ? "mois" : plan.interval === "week" ? "semaine" : "jour"}`
        : "Formule indisponible";
    }
  } catch {
    $("#premiumPrice").textContent = "Tarif indisponible";
    $("#premiumPlusPrice").textContent = "Tarif indisponible";
  }
}
// La publicité et sa CMP sont isolées sur /decouvrir.html, jamais dans le tchat.
async function startPremium(plan, button) {
  if (user.guest) { $("#profileError").textContent = "Créez un compte permanent avant de vous abonner."; return; }
  button.disabled = true;
  $("#profileError").textContent = "";
  try {
    const data = await (
      await api("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      })
    ).json();
    location.href = data.url;
  } catch (e) {
    $("#profileError").textContent = e.message;
    button.disabled = false;
  }
}
$("#subscribePremium").onclick = () =>
  startPremium("premium", $("#subscribePremium"));
$("#subscribePremiumPlus").onclick = () =>
  startPremium("premium_plus", $("#subscribePremiumPlus"));
$("#managePremium").onclick = async () => {
  const button = $("#managePremium");
  button.disabled = true;
  try {
    const data = await (
      await api("/api/stripe/portal", { method: "POST" })
    ).json();
    location.href = data.url;
  } catch (e) {
    $("#profileError").textContent = e.message;
    button.disabled = false;
  }
};
$("#exportAccount").onclick = async () => {
  const button = $("#exportAccount");
  button.disabled = true;
  try {
    const response = await api("/api/account-export"),
      blob = await response.blob(),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `letchat-donnees-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showError("Vos données ont été téléchargées");
  } catch (e) {
    $("#profileError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#deleteAccount").onclick = async () => {
  if (
    !confirm(
      "Cette action supprimera définitivement votre profil, vos messages et vos relations Letchat. Continuer ?",
    )
  )
    return;
  const confirmation = prompt("Pour confirmer, écrivez exactement : SUPPRIMER");
  if (confirmation !== "SUPPRIMER") return showError("Suppression annulée");
  const button = $("#deleteAccount");
  button.disabled = true;
  try {
    await api("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    socket?.disconnect();
    if (localSessionToken) {
      localStorage.removeItem("letchatLocalToken");
      sessionStorage.removeItem("letchatGuestToken");
      localSessionToken = "";
    } else {
      try {
        await deleteUser(user);
      } catch {
        await signOut(auth);
      }
    }
    alert("Votre compte et vos données Letchat ont été supprimés.");
    location.reload();
  } catch (e) {
    $("#profileError").textContent = e.message;
    button.disabled = false;
  }
};
const reportReasons = {
  harassment: "Harcèlement ou menace",
  spam: "Spam ou publicité",
  inappropriate: "Contenu inapproprié",
  fake: "Faux profil",
  other: "Autre raison",
};
async function checkAdmin() {
  try {
    const data = await (await api("/api/admin/me")).json();
    isAdmin = Boolean(data.admin);
    $("#adminBtn").classList.toggle("hidden", !data.admin);
  } catch {
    isAdmin = false;
    $("#adminBtn").classList.add("hidden");
  }
}
async function loadAdminReports() {
  const list = $("#reportList");
  list.innerHTML = '<p class="admin-loading">Chargement…</p>';
  $("#adminError").textContent = "";
  try {
    if ($("#adminStatus").value === "journal") {
      const rows = await (await api("/api/admin/moderation-log")).json();
      const actionLabels = {
        report_resolved: "Signalement traité",
        report_dismissed: "Signalement rejeté",
        report_reopened: "Signalement rouvert",
        message_deleted: "Message supprimé",
        user_suspended: "Compte suspendu",
        user_unsuspended: "Compte réactivé",
        profile_verified: "Profil vérifié",
        profile_unverified: "Vérification retirée",
      };
      list.innerHTML = rows.length
        ? rows.map((entry) =>
            `<article class="report-item moderation-log-item"><div class="report-head"><strong>${safe(actionLabels[entry.action] || entry.action)}</strong><time>${new Date(entry.created_at).toLocaleString("fr-FR")}</time></div><p><b>Administrateur :</b> ${memberLink(entry.admin_id, entry.admin_name)}</p>${entry.target_user_id ? `<p><b>Utilisateur concerné :</b> ${memberLink(entry.target_user_id, entry.target_name || "Utilisateur")}</p>` : ""}${entry.report_id ? `<p><b>Signalement :</b> n°${safe(entry.report_id)}</p>` : ""}${entry.details ? `<p class="report-details">${safe(entry.details)}</p>` : ""}</article>`
          ).join("")
        : '<p class="admin-empty">Aucune action de modération enregistrée.</p>';
      return;
    }
    if ($("#adminStatus").value === "profiles") {
      list.innerHTML = '<div class="admin-profile-search"><input id="adminProfileSearch" data-city-autocomplete maxlength="100" placeholder="Rechercher un nom, un e-mail ou une ville"><button id="adminProfileSearchButton" type="button">Rechercher</button></div><div id="adminProfilesResults"><p class="admin-loading">Chargement…</p></div>';
      const loadProfiles = async () => {
        const results = $("#adminProfilesResults"), query = $("#adminProfileSearch").value.trim();
        results.innerHTML = '<p class="admin-loading">Chargement…</p>';
        const profiles = await (await api(`/api/admin/profiles?q=${encodeURIComponent(query)}`)).json();
        results.innerHTML = profiles.length ? profiles.map((profile) => `<article class="report-item admin-profile-item" data-user-id="${safe(profile.user_id)}"><div><strong>${memberLink(profile.user_id, profile.display_name)}${profile.verified?'<span class="verified-badge">✓</span>':""}</strong><small>${safe(profile.email || "")}${profile.city?` · ${safe(profile.city)}`:""}</small></div><button type="button" data-verified="${profile.verified ? "false" : "true"}" class="${profile.verified ? "danger" : ""}">${profile.verified ? "Retirer la vérification" : "Vérifier le profil"}</button></article>`).join("") : '<p class="admin-empty">Aucun profil trouvé.</p>';
        results.querySelectorAll("[data-verified]").forEach((button) => button.onclick = async () => {
          button.disabled = true;
          try {
            await api(`/api/admin/profiles/${encodeURIComponent(button.closest(".admin-profile-item").dataset.userId)}/verification`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verified: button.dataset.verified === "true" }) });
            await loadProfiles();
          } catch (error) { $("#adminError").textContent = error.message; button.disabled = false; }
        });
      };
      $("#adminProfileSearchButton").onclick = loadProfiles;
      $("#adminProfileSearch").onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); loadProfiles(); } };
      await loadProfiles();
      return;
    }
    if ($("#adminStatus").value === "stats") {
      const stats = await (await api("/api/admin/stats")).json();
      const cards = [
        ["Utilisateurs inscrits", stats.users],
        ["En ligne maintenant", stats.online],
        ["Messages sur 24 h", stats.messages24h],
        ["Signalements à traiter", stats.pendingReports],
        ["Suspensions actives", stats.activeSuspensions],
        ["Abonnements Premium", stats.premium],
      ];
      list.innerHTML = `<div class="admin-stats">${cards.map(([label, value]) => `<article><strong>${safe(value)}</strong><span>${safe(label)}</span></article>`).join("")}</div><p class="admin-stats-note">Données actualisées au ${new Date().toLocaleString("fr-FR")}.</p>`;
      return;
    }
    const rows = await (
      await api(
        `/api/admin/reports?status=${encodeURIComponent($("#adminStatus").value)}`,
      )
    ).json();
    list.innerHTML = rows.length
      ? rows
          .map(
            (report) =>
              `<article class="report-item" data-report-id="${report.id}" data-user-id="${safe(report.reported_id)}"><div class="report-head"><strong>${memberLink(report.reported_id, report.reported_name)}</strong><time>${new Date(report.created_at).toLocaleString("fr-FR")}</time></div><p><b>Motif :</b> ${safe(reportReasons[report.reason] || report.reason)}</p><p><b>Signalé par :</b> ${memberLink(report.reporter_id, report.reporter_name)}</p>${report.evidence_body ? `<blockquote class="report-evidence"><b>Message signalé :</b><br>${safe(report.evidence_body)}</blockquote>` : ""}${report.details ? `<p class="report-details">${safe(report.details)}</p>` : ""}<p class="suspension-state">${report.suspended ? "Compte actuellement suspendu" : "Compte actif"}</p><div class="admin-actions">${$("#adminStatus").value === "pending" ? '<button data-action="resolved">Traité</button><button data-action="dismissed">Rejeter</button>' : ""}${report.message_id ? '<button data-action="delete-message" class="danger">Supprimer le message</button>' : ""}<button data-action="24h">Suspendre 24 h</button><button data-action="7d">Suspendre 7 jours</button><button data-action="permanent" class="danger">Suspendre définitivement</button>${report.suspended ? '<button data-action="unsuspend">Réactiver</button>' : ""}</div></article>`,
          )
          .join("")
      : '<p class="admin-empty">Aucun signalement dans cette catégorie.</p>';
    list
      .querySelectorAll("[data-action]")
      .forEach((button) => (button.onclick = () => adminAction(button)));
  } catch (e) {
    list.innerHTML = "";
    $("#adminError").textContent = e.message;
  }
}
async function adminAction(button) {
  const card = button.closest(".report-item"),
    action = button.dataset.action,
    reportId = card.dataset.reportId,
    userId = card.dataset.userId;
  button.disabled = true;
  try {
    if (["resolved", "dismissed"].includes(action)) {
      await api(`/api/admin/reports/${encodeURIComponent(reportId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: action }),
      });
    } else if (action === "delete-message") {
      if (!confirm("Supprimer définitivement le message signalé ?")) return;
      await api(`/api/admin/reports/${encodeURIComponent(reportId)}/message`, { method: "DELETE" });
    } else if (action === "unsuspend") {
      await api(`/api/admin/suspensions/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
    } else {
      if (!confirm(`Confirmer la suspension (${action}) ?`)) return;
      await api(`/api/admin/suspensions/${encodeURIComponent(userId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          duration: action,
          reason: "Signalement traité par la modération",
        }),
      });
    }
    await loadAdminReports();
  } catch (e) {
    $("#adminError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
$("#adminBtn").onclick = () => {
  $("#adminModal").classList.remove("hidden");
  loadAdminReports();
};
$("#closeAdmin").onclick = () => $("#adminModal").classList.add("hidden");
$("#refreshReports").onclick = loadAdminReports;
$("#adminStatus").onchange = loadAdminReports;
function openReport(target, message = null) {
  reportContext = { target, message };
  $("#reportTarget").textContent =
    message
      ? `Vous signalez un message de ${target.name}. Son contenu sera joint comme preuve.`
      : `Vous signalez ${target.name}. Le signalement sera transmis à la modération.`;
  $("#reportReason").value = "";
  $("#reportDetails").value = "";
  $("#reportError").textContent = "";
  $("#reportModal").classList.remove("hidden");
}
$("#reportBtn").onclick = () => {
  if (currentPrivate) openReport(currentPrivate);
};
$("#closeReport").onclick = () => $("#reportModal").classList.add("hidden");
$("#reportForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!reportContext?.target) return;
  const button = $(".report-submit");
  button.disabled = true;
  $("#reportError").textContent = "";
  try {
    await api("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportedId: reportContext.target.id,
        messageKind: reportContext.message ? (reportContext.message.private ? "private" : "public") : null,
        messageId: reportContext.message?.id || null,
        reason: $("#reportReason").value,
        details: $("#reportDetails").value,
      }),
    });
    $("#reportModal").classList.add("hidden");
    showError("Signalement envoyé à la modération");
  } catch (e) {
    $("#reportError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
async function blockPrivateUser(target) {
  if (!target) return;
  if (
    !confirm(
      `Bloquer ${target.name} ? Cette personne ne pourra plus vous écrire.`,
    )
  )
    return;
  try {
    await api(`/api/blocks/${encodeURIComponent(target.id)}`, {
      method: "POST",
    });
    blockedUsers.set(String(target.id), {
      user_id: String(target.id),
      display_name: target.name,
    });
    await loadFriends();
    currentPrivate = null;
    privateContactStatus = null;
    socket?.emit("watch-private-status", "");
    stopTyping(target.id);
    viewOnceEnabled = false;
    updateViewOnceButton();
    $("#blockBtn").classList.add("hidden");
  $("#privateProfileBtn").classList.add("hidden");
    $("#reportBtn").classList.add("hidden");
    $(".chat header h1").textContent = rooms[currentRoom].title;
    $("#roomPresence").classList.remove("hidden");
    $("#privateTypingStatus").classList.add("hidden");
    renderPeople(lastPeople);
    load();
    showError(`${target.name} a été bloqué`);
  } catch (e) {
    showError(e.message);
  }
}
$("#blockBtn").onclick = () => blockPrivateUser(currentPrivate ? { ...currentPrivate } : null);
const roomLinks = [...document.querySelectorAll(".room")];
let premiumRoomUnlocked = false;
$("#closePremiumRoomGate").onclick = () => $("#premiumRoomGate").classList.add("hidden");
$("#openPremiumRoomGate").onclick = async () => {
  $("#premiumRoomGate").classList.add("hidden");
  $("#premiumShortcut").click();
};
function updateRoomBadges() {
  roomLinks.forEach((link) => {
    const count = roomUnread.get(link.dataset.room) || 0;
    let badge = link.querySelector(".room-unread");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "room-unread hidden";
      link.append(badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  });
}
function updateRoomFeature() {
  const panel = $("#roomFeature");
  if (!panel) return;
  if (currentPrivate || (!["cafe", "amateurs", "webcam", "creatifs"].includes(currentRoom) && !rooms[currentRoom]?.adult)) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  if (currentRoom === "cafe") {
    renderCafeOverview(panel);
    return;
  }
  if (currentRoom === "amateurs") {
    panel.innerHTML = `<div class="room-feature-title"><b>▣ Galerie des membres</b><span>Photos et vidéos publiées par la communauté.</span><button id="publishGalleryMedia" type="button">＋ Publier un média</button></div>`;
    $("#publishGalleryMedia").onclick = () => $("#file").click();
    return;
  }
  if (currentRoom === "creatifs") {
    renderMeetingProfiles(panel);
    return;
  }
  if (rooms[currentRoom]?.adult === true) {
    panel.innerHTML = `<details class="adult-safety-compact" style="color:var(--v3-text, #232420)"><summary style="min-height:32px;padding:5px 2px;cursor:pointer;font-size:13px;font-weight:700;line-height:22px">18+ · Règles du salon</summary><div style="max-height:25dvh;overflow-y:auto;overscroll-behavior:contain;padding:8px 2px 2px;font-size:13px;line-height:1.5"><p style="margin:0 0 8px">Salon réservé aux adultes. Respect, consentement et anonymat obligatoires. Ne partagez jamais vos coordonnées personnelles.</p><ul style="margin:0 0 10px;padding-left:20px"><li>Contenu impliquant un mineur strictement interdit</li><li>Aucun contenu non consenti ou illégal</li><li>Bloquez et signalez immédiatement tout comportement dangereux</li></ul><button id="adultSafetyReport" type="button" style="min-height:44px;border:0;border-radius:9px;padding:8px 12px;background:#b94138;color:#fff;font-weight:700">⚑ Signaler un utilisateur</button></div></details>`;
    $("#adultSafetyReport").onclick = () => showError("Touchez un profil ou utilisez le bouton Signaler sous un message.");
    return;
  }
  const seen = new Set();
  const available = lastPeople.filter((person) => {
    if (person.id === user.uid || person.availability !== "available" || seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
  panel.innerHTML = `<div class="room-feature-title webcam-lobby-title"><div><b>▣ Membres disponibles en Webcam</b><span>${available.length ? `${available.length} membre${available.length > 1 ? "s" : ""} disponible${available.length > 1 ? "s" : ""}` : "Aucun autre membre disponible pour le moment"}</span></div><button id="testWebcamButton" type="button">Tester ma caméra</button></div>${available.length ? `<div class="webcam-members">${available.map((person) => `<article>${memberLink(person.id, person.name, person.photo ? `<img src="${safe(person.photo)}" alt="">` : safe(initials(person.name)), "webcam-avatar member-avatar-link")}<strong>${memberLink(person.id, person.name)}</strong><small>Disponible maintenant</small><button type="button" data-webcam-message="${safe(person.id)}" data-webcam-name="${safe(person.name)}">Écrire</button><button type="button" class="webcam-call-primary" data-webcam-call="${safe(person.socketId || "")}" data-webcam-name="${safe(person.name)}" ${person.socketId ? "" : "disabled"}>Appeler</button></article>`).join("")}</div>` : `<div class="webcam-empty"><b>Personne n’est disponible actuellement</b><span>Revenez dans quelques minutes ou écrivez à un contact.</span></div>`}`;
  $("#testWebcamButton").onclick = openWebcamTest;
  panel.querySelectorAll("[data-webcam-message]").forEach((button) => button.onclick = () => openPrivate(button.dataset.webcamMessage, button.dataset.webcamName));
  panel.querySelectorAll("[data-webcam-call]").forEach((button) => button.onclick = () => startDirectCall(button.dataset.webcamCall, button.dataset.webcamName));
}
async function openWebcamTest() {
  $("#webcamTest").classList.remove("hidden");
  $("#webcamTestStatus").textContent = "Préparation de la caméra…";
  try {
    webcamTestStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    $("#webcamTestVideo").srcObject = webcamTestStream;
    await $("#webcamTestVideo").play().catch(() => {});
    const cameraReady = webcamTestStream.getVideoTracks().some(track => track.readyState === "live");
    const microphoneReady = webcamTestStream.getAudioTracks().some(track => track.readyState === "live");
    $("#webcamTestStatus").textContent = `${cameraReady ? "✓ Caméra prête" : "✕ Caméra indisponible"} · ${microphoneReady ? "✓ Micro prêt" : "✕ Micro indisponible"}`;
  } catch (error) {
    $("#webcamTestStatus").textContent = mediaErrorMessage(error);
  }
}
function closeWebcamTest() {
  webcamTestStream?.getTracks().forEach(track => track.stop());
  webcamTestStream = null;
  $("#webcamTestVideo").srcObject = null;
  $("#webcamTest").classList.add("hidden");
}
$("#closeWebcamTest").onclick = closeWebcamTest;
$("#finishWebcamTest").onclick = closeWebcamTest;
$("#webcamTest").onclick = (event) => { if (event.target === $("#webcamTest")) closeWebcamTest(); };
function renderCafeOverview(panel) {
  const active = lastPeople.filter(person => person.id !== user.uid && !blockedUsers.has(String(person.id))).slice(0, 8);
  const pinned = lastPublicMessages.filter(message => message.pinned).slice(-3);
  panel.innerHTML = `<div class="cafe-overview cafe-overview-compact"><div class="cafe-active"><b>Membres actifs</b><div>${active.length ? active.map(person => `<button type="button" data-cafe-profile="${safe(person.id)}" data-cafe-name="${safe(person.name)}" title="${safe(person.name)}">${person.photo ? `<img src="${safe(person.photo)}" alt="">` : safe(initials(person.name))}</button>`).join("") : '<span>Aucun autre membre pour le moment</span>'}</div></div>${pinned.length ? `<div class="cafe-pinned"><b>📌 Messages épinglés</b>${pinned.map(message => `<div class="cafe-pinned-entry">${memberLink(message.user_id, message.author)}<button type="button" data-pinned-message="${safe(message.id)}"><span>${safe(message.body || "Média partagé")}</span></button></div>`).join("")}</div>` : ""}</div>`;
  panel.querySelectorAll("[data-cafe-profile]").forEach(button => button.onclick = () => openPrivate(button.dataset.cafeProfile, button.dataset.cafeName));
  panel.querySelectorAll("[data-pinned-message]").forEach(button => button.onclick = () => document.querySelector(`[data-key="m-${button.dataset.pinnedMessage}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}
function renderMeetingProfiles(panel) {
  const visiblePeople = lastPeople.filter(person => person.id !== user.uid && !blockedUsers.has(String(person.id)));
  panel.innerHTML = `<div class="meeting-panel"><div class="meeting-heading"><div><b>✦ Découvrir des profils</b><span>Choisissez les personnes avec qui vous souhaitez discuter.</span></div><div class="meeting-filters"><select id="meetingGender" aria-label="Filtrer par genre"><option value="all">Tous les profils</option><option value="female">Femmes</option><option value="male">Hommes</option><option value="neutral">Autres profils</option></select><input id="meetingCity" data-city-autocomplete type="search" maxlength="100" aria-label="Filtrer par ville" placeholder="Toutes les villes"></div></div><div id="meetingProfiles" class="meeting-profiles"></div></div>`;
  const draw = () => {
    const gender = $("#meetingGender").value, city = normalizeSearch($("#meetingCity").value);
    const filtered = visiblePeople.filter(person => (gender === "all" || (person.gender || "neutral") === gender) && (!city || normalizeSearch(person.location?.city || "").includes(city)));
    $("#meetingProfiles").innerHTML = filtered.length ? filtered.map(person => `<article class="meeting-profile">${memberLink(person.id, person.name, person.photo ? `<img src="${safe(person.photo)}" alt="">` : safe(initials(person.name)), "meeting-avatar member-avatar-link")}<div><strong>${memberLink(person.id, person.name)}${person.verified ? '<span class="verified-badge">✓</span>' : ""}</strong><small>${safe(person.location?.city || "Ville masquée")} · ${person.availability === "available" ? "Disponible" : person.availability === "busy" ? "Occupé" : "Absent"}</small><p>${safe(person.bio || "Aucune description pour le moment.")}</p></div><div class="meeting-actions"><button type="button" data-meeting-profile="${safe(person.id)}" data-meeting-name="${safe(person.name)}">Voir le profil</button><button type="button" data-meeting-message="${safe(person.id)}" data-meeting-name="${safe(person.name)}">Écrire</button><button type="button" class="meeting-call" data-meeting-call="${safe(person.socketId || "")}" data-meeting-name="${safe(person.name)}" ${person.socketId ? "" : "disabled"}>Appeler</button></div></article>`).join("") : `<div class="meeting-empty">Aucun profil ne correspond à ces filtres.</div>`;
    panel.querySelectorAll("[data-meeting-profile]").forEach(button => button.onclick = () => showPublicProfile(button.dataset.meetingProfile, button.dataset.meetingName));
    panel.querySelectorAll("[data-meeting-message]").forEach(button => button.onclick = () => openPrivate(button.dataset.meetingMessage, button.dataset.meetingName));
    panel.querySelectorAll("[data-meeting-call]").forEach(button => button.onclick = () => startDirectCall(button.dataset.meetingCall, button.dataset.meetingName));
  };
  $("#meetingGender").onchange = draw;
  $("#meetingCity").oninput = draw;
  draw();
}
function selectRoom(link, id) {
  if (rooms[id]?.premium === true && !premiumRoomUnlocked) {
    $("#premiumRoomGate").classList.remove("hidden");
    return;
  }
  saveDraft();
  if (typingActive) stopTyping();
  clearReply();
  privateHomeOpen = false;
  $(".chat").classList.remove("private-home");
  const previousPrivateId = currentPrivate?.id;
  if (previousPrivateId) stopTyping(previousPrivateId);
  currentPrivate = null;
  privateContactStatus = null;
  socket?.emit("watch-private-status", "");
  viewOnceEnabled = false;
  updateViewOnceButton();
  $("#blockBtn").classList.add("hidden");
  $("#privateProfileBtn").classList.add("hidden");
  $("#reportBtn").classList.add("hidden");
  if (currentRoom !== id) {
    currentRoom = id;
    lastPeople = [];
    socket?.emit("join-room", id);
  }
  restoreDraft();
  $("#privateMessagesLink").classList.remove("active");
  roomUnread.delete(id);
  updateRoomBadges();
  roomLinks.forEach((item) => item.classList.remove("active"));
  link.classList.add("active");
  roomLinks.forEach(item => item.setAttribute("aria-current", item === link ? "true" : "false"));
  $(".side").classList.remove("open");
  $(".chat header h1").textContent = rooms[id].title;
  $("#roomPresence").classList.remove("hidden");
  $("#privateTypingStatus").classList.add("hidden");
  $("#typing").textContent = "";
  updateRoomFeature();
  load();
}
function updateViewOnceButton() {
  const button = $("#viewOnceBtn");
  button.classList.toggle("hidden", !currentPrivate);
  button.classList.toggle("active", viewOnceEnabled && Boolean(currentPrivate));
  button.title = viewOnceEnabled ? "Visible une seule fois activé" : "Photo ou vidéo visible une seule fois";
}
$("#viewOnceBtn").onclick = () => {
  viewOnceEnabled = !viewOnceEnabled;
  updateViewOnceButton();
};
roomLinks.forEach((link) => {
  const id = link.dataset.room;
  if (!id || !rooms[id]) return;
  link.onclick = async event => {
    event.preventDefault();
    if (rooms[id]?.premium === true) {
      try {
        premiumRoomUnlocked = Boolean((await (await api("/api/subscription")).json()).premium);
      } catch { premiumRoomUnlocked = false; }
      if (!premiumRoomUnlocked) {
        $(".side").classList.remove("open");
        $("#premiumRoomGate").classList.remove("hidden");
        return;
      }
    }
    if (rooms[id]?.adult === true && localStorage.getItem("letchatAdultRoomAccepted") !== "yes") {
      pendingAdultSelection = { link, id };
      $(".side").classList.remove("open");
      $("#adultRoomWarning").classList.remove("hidden");
      return;
    }
    selectRoom(link, id);
  };
});
$("#leaveAdultRoom").onclick = () => { pendingAdultSelection = null; $("#adultRoomWarning").classList.add("hidden"); };
$("#enterAdultRoom").onclick = () => {
  localStorage.setItem("letchatAdultRoomAccepted", "yes");
  $("#adultRoomWarning").classList.add("hidden");
  if (pendingAdultSelection) selectRoom(pendingAdultSelection.link, pendingAdultSelection.id);
  pendingAdultSelection = null;
};
function contactCandidates(mode = "message") {
  if (!user) return [];
  const permitted = person => String(person.id) !== String(user.uid) && !blockedUsers.has(String(person.id));
  const roomPeople = new Map(lastPeople.filter(permitted).map(person => [String(person.id), person]));
  // L'annuaire global ne fournit volontairement aucun identifiant d'appel.
  // Les messages utilisent cet annuaire ; les appels gardent leurs cibles autorisées du salon.
  if (mode === "call") return [...roomPeople.values()]
    .filter(person => person.socketId && isOnline(person.id)).map(person => ({ ...person, online: true }));
  const known = new Map((allOnlineMembers ?? lastPeople).filter(permitted).map(person => [String(person.id), {
    ...roomPeople.get(String(person.id)), ...person, online: true,
  }]));
  privateConversations.forEach(row => {
    if (!known.has(String(row.user_id)) && permitted({ id: row.user_id })) {
      known.set(String(row.user_id), { id: row.user_id, name: row.display_name, photo: row.photo, gender: row.gender || "neutral", availability: "offline", online: false });
    }
  });
  return [...known.values()];
}
function openContactPicker(mode = "message") {
  contactPickerMode = mode;
  const isCall = mode === "call";
  const focusedId = $("#contactPickerList").contains(document.activeElement) ? document.activeElement.dataset.contactId : null;
  $("#contactPickerTitle").textContent = isCall ? "Qui souhaitez-vous appeler ?" : "Nouveau message privé";
  $("#contactPickerSubtitle").textContent = isCall ? "Choisissez un membre actuellement en ligne." : "Choisissez un utilisateur pour commencer une conversation.";
  const candidates = contactCandidates(mode);
  $("#contactPickerList").innerHTML = candidates.length
    ? candidates.map(person => `<button type="button" class="contact-picker-item" data-contact-id="${safe(person.id)}" data-contact-name="${safe(person.name)}" data-contact-socket="${safe(person.socketId || "")}"><span class="contact-picker-avatar gender-${safe(person.gender || "neutral")}">${person.photo ? `<img src="${safe(person.photo)}" alt="">` : safe(initials(person.name))}</span><span><strong>${safe(person.name)}</strong><small>${person.online ? "En ligne" : "Hors ligne"}</small></span><b>${isCall ? "📞" : "💬"}</b></button>`).join("")
    : `<div class="contact-picker-empty"><b>${isCall ? "Aucun membre disponible" : "Aucun contact disponible"}</b><span>${isCall ? "Revenez lorsque d’autres utilisateurs seront en ligne." : "Les utilisateurs en ligne apparaîtront ici."}</span></div>`;
  $("#contactPickerList").querySelectorAll("[data-contact-id]").forEach(button => {
    button.onclick = async () => {
      $("#contactPickerModal").classList.add("hidden");
      if (contactPickerMode === "call") await startDirectCall(button.dataset.contactSocket, button.dataset.contactName);
      else openPrivate(button.dataset.contactId, button.dataset.contactName);
    };
  });
  $("#contactPickerModal").classList.remove("hidden");
  if (focusedId) $("#contactPickerList").querySelector(`[data-contact-id="${CSS.escape(focusedId)}"]`)?.focus();
}
function renderPrivateMessagesHome() {
  if (!privateHomeOpen) return;
  const available = contactCandidates("message"), recent = privateConversations.filter(row => !row.archived).slice(0, 8);
  $("#roomFeature").classList.add("hidden");
  $("#messages").classList.remove("media-gallery");
  $("#messages").innerHTML = `<div class="private-home-page"><div class="private-home-heading"><div><span>💬</span><div><h2>Messages privés</h2><p>Retrouvez vos conversations ou contactez un membre.</p></div></div><button type="button" id="newPrivateConversationCenter">＋ Nouveau message</button></div><section><h3>Conversations récentes</h3>${recent.length ? `<div class="private-home-grid">${recent.map(row => `<button type="button" data-home-private="${safe(row.user_id)}" data-home-name="${safe(row.display_name)}"><span class="contact-picker-avatar gender-${safe(row.gender || "neutral")}">${row.photo ? `<img src="${safe(row.photo)}" alt="">` : safe(initials(row.display_name))}</span><span><strong>${safe(row.display_name)}</strong><small>${safe(privatePreview(row))}</small></span>${Number(row.unread_count || 0) ? `<b>${Number(row.unread_count)}</b>` : ""}</button>`).join("")}</div>` : '<p class="private-home-empty">Aucune conversation pour le moment.</p>'}</section><section><h3>Membres disponibles</h3>${available.length ? `<div class="private-home-grid">${available.map(person => `<button type="button" data-home-private="${safe(person.id)}" data-home-name="${safe(person.name)}"><span class="contact-picker-avatar gender-${safe(person.gender || "neutral")}">${person.photo ? `<img src="${safe(person.photo)}" alt="">` : safe(initials(person.name))}</span><span><strong>${safe(person.name)}</strong><small>${person.online ? "En ligne" : "Hors ligne"}</small></span></button>`).join("")}</div>` : '<p class="private-home-empty">Aucun autre membre disponible.</p>'}</section></div>`;
  $("#newPrivateConversationCenter").onclick = () => openContactPicker("message");
  $("#messages").querySelectorAll("[data-home-private]").forEach(button => button.onclick = () => openPrivate(button.dataset.homePrivate, button.dataset.homeName));
}
async function showPrivateMessagesHome() {
  saveDraft();
  if (typingActive) stopTyping();
  clearReply();
  const previousPrivateId = currentPrivate?.id;
  if (previousPrivateId) stopTyping(previousPrivateId);
  currentPrivate = null;
  privateContactStatus = null;
  privateHomeOpen = true;
  restoreDraft();
  $("#privateMessagesLink").classList.add("active");
  socket?.emit("watch-private-status", "");
  $(".chat").classList.add("private-home");
  $("#blockBtn").classList.add("hidden");
  $("#privateProfileBtn").classList.add("hidden");
  $("#reportBtn").classList.add("hidden");
  $(".chat header h1").textContent = "◌ Messages";
  $("#roomPresence").classList.add("hidden");
  $("#privateTypingStatus").classList.add("hidden");
  $("#typing").textContent = "";
  $(".side").classList.remove("open");
  roomLinks.forEach(item => item.classList.remove("active"));
  await loadPrivateConversations();
  renderPrivateMessagesHome();
}
document.querySelector(".new").onclick = () => openContactPicker("message");
$("#privateMessagesLink").onclick = async (event) => {
  event.preventDefault();
  await showPrivateMessagesHome();
};
$("#closeContactPicker").onclick = () => $("#contactPickerModal").classList.add("hidden");
$("#contactPickerModal").onclick = event => { if (event.target === $("#contactPickerModal")) $("#contactPickerModal").classList.add("hidden"); };
$("#roomsBtn").onclick = () => $(".side").classList.add("open");
$("#closeSide").onclick = () => $(".side").classList.remove("open");
$("#peopleBtn").onclick = () => {
  $(".people").classList.add("open");
  requestNotifications();
};
$("#closePeople").onclick = () => $(".people").classList.remove("open");
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { load(); if (currentPrivate) markPrivateRead(currentPrivate.id) }
});
window.addEventListener("focus", () => { load(); if (currentPrivate) markPrivateRead(currentPrivate.id) });
async function prepareIce() {
  if (iceServers.length) return iceServers;
  if (!icePromise)
    icePromise = api("/api/turn-credentials")
      .then((r) => r.json())
      .then((list) => {
        if (!Array.isArray(list) || !list.length)
          throw new Error("TURN indisponible");
        iceServers = list;
        return list;
      })
      .catch((error) => {
        icePromise = null;
        console.warn("TURN indisponible, utilisation du relais direct/STUN :", error);
        iceServers = fallbackIceServers;
        return iceServers;
      });
  return icePromise;
}
function peer(id, participantName = "Participant") {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });
  stream?.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.onicecandidate = (e) =>
    e.candidate &&
    sendSignal({
      target: id,
      data: { type: "ice", candidate: e.candidate },
    });
  pc.ontrack = (e) => addRemote(id, e.streams[0], participantName);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      $("#error").classList.add("hidden");
      setCallStatus("Connecté");
      setCameraStatus();
      startCallTimer();
    }
    if (pc.connectionState === "connecting") setCallStatus("Connexion en cours…");
    if (pc.connectionState === "disconnected") setCallStatus("Reconnexion…");
    if (["failed", "closed"].includes(pc.connectionState)) {
      document.getElementById(`v-${id}`)?.remove();
      peers.delete(id);
      if (pc.connectionState === "failed")
        showError("Connexion vidéo interrompue");
      if (pc.connectionState === "failed") setCallStatus("Connexion interrompue");
    }
  };
  peers.set(id, pc);
  return pc;
}
function mediaErrorMessage(error) {
  const messages = {
    NotAllowedError: "Accès caméra/micro refusé par le navigateur",
    NotFoundError: "Aucune caméra ou aucun microphone détecté",
    NotReadableError:
      "La caméra ne fournit pas d’image. Fermez les autres applications vidéo puis réessayez",
    OverconstrainedError: "Caméra incompatible avec les réglages demandés",
    SecurityError: "Accès caméra/micro bloqué pour ce site",
    AbortError: "Ouverture de la caméra interrompue",
  };
  return (
    messages[error?.name] ||
    `Caméra/micro indisponible (${error?.name || "erreur inconnue"})`
  );
}
function setCameraStatus(message = "") {
  const status = $("#cameraStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("hidden", !message);
}
function setCallStatus(message = "") {
  const status = $("#callConnectionStatus");
  if (status) status.textContent = message;
}
function startCallTimer() {
  if (callTimer) return;
  callStartedAt = Date.now();
  callTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - callStartedAt) / 1000);
    $("#callDuration").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
}
function stopCallTimer() {
  clearInterval(callTimer);
  callTimer = null;
  callStartedAt = 0;
  if ($("#callDuration")) $("#callDuration").textContent = "00:00";
}
function ringPulse() {
  try {
    ringtoneContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ringtoneContext.createOscillator(), gain = ringtoneContext.createGain();
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, ringtoneContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ringtoneContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ringtoneContext.currentTime + 0.28);
    oscillator.connect(gain).connect(ringtoneContext.destination);
    oscillator.start();
    oscillator.stop(ringtoneContext.currentTime + 0.3);
  } catch {}
}
function startRingtone() {
  stopRingtone();
  ringPulse();
  ringtoneTimer = setInterval(ringPulse, 1200);
}
function stopRingtone() {
  clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  navigator.vibrate?.(0);
}
function updateMediaControls() {
  const audioEnabled = Boolean(stream?.getAudioTracks().some(t => t.enabled && t.readyState === "live"));
  const videoEnabled = Boolean(stream?.getVideoTracks().some(t => t.enabled && t.readyState === "live"));
  $("#mic").classList.toggle("control-off", !audioEnabled);
  $("#cam").classList.toggle("control-off", !videoEnabled);
  $("#mic").setAttribute("aria-pressed", String(audioEnabled));
  $("#cam").setAttribute("aria-pressed", String(videoEnabled));
  $("#mic span").textContent = audioEnabled ? "Micro" : "Micro coupé";
  $("#cam span").textContent = videoEnabled ? "Caméra" : "Caméra coupée";
}
async function openCamera() {
  let lastError;
  const attempts = [
    { video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: true, audio: false },
  ];
  for (const constraints of attempts) {
    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = cameraStream.getVideoTracks()[0];
      if (track) return track;
    } catch (error) {
      lastError = error;
      console.error("Caméra :", error.name, error.message);
    }
  }
  throw lastError || new DOMException("Caméra indisponible", "NotFoundError");
}
async function startMedia() {
  socialFeatures?.live.leave();
  if (mediaStartPromise) return mediaStartPromise;
  mediaStartPromise = startMediaOnce();
  try {
    return await mediaStartPromise;
  } finally {
    mediaStartPromise = null;
  }
}
async function startMediaOnce() {
  const active =
    stream && stream.getTracks().some((track) => track.readyState === "live");
  if (active) {
    $("#localVideo").srcObject = stream;
    $("#call").classList.remove("hidden");
    inVideoCall = true;
    updateMediaControls();
    return true;
  }
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    showError("Ce navigateur ne permet pas l’accès à la caméra");
    return false;
  }
  stream = new MediaStream();
  let cameraError;
  try {
    stream.addTrack(await openCamera());
    setCameraStatus();
  } catch (error) {
    cameraError = error;
    setCameraStatus(`${mediaErrorMessage(error)}. Cliquez sur « Caméra » pour réessayer.`);
  }
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
  } catch (error) {
    console.error("Microphone :", error.name, error.message);
  }
  if (!stream.getTracks().length) {
    showError(mediaErrorMessage(cameraError));
    return false;
  }
  $("#localVideo").srcObject = stream;
  $("#localVideo").muted = true;
  const localVideo = $("#localVideo");
  await localVideo.play().catch((error) => console.warn("Lecture vidéo locale :", error));
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    const settings = videoTrack.getSettings?.() || {};
    setCameraStatus(videoTrack.muted
      ? "La caméra est ouverte mais ne fournit pas encore d’image"
      : "");
    videoTrack.onunmute = () => setCameraStatus();
    videoTrack.onended = () => setCameraStatus("La caméra a été déconnectée. Cliquez sur « Caméra » pour réessayer.");
    console.info("Caméra active", { readyState: videoTrack.readyState, muted: videoTrack.muted, width: settings.width, height: settings.height });
  }
  $("#call").classList.remove("hidden");
  inVideoCall = true;
  updateMediaControls();
  await prepareIce();
  return true;
}
async function flushIce(id, pc) {
  const list = pendingIce.get(id) || [];
  pendingIce.delete(id);
  for (const candidate of list)
    try {
      await pc.addIceCandidate(candidate);
    } catch {}
}
function sendSignal(payload) {
  const callId = payload.data.callId || activeCallId;
  if (callId && socket?.connected) socket.emit("webrtc", { ...payload, data: { ...payload.data, callId } });
}
async function handleSignal({ from, user: remoteUser, data }) {
  if (!from || !data?.type || !data.callId) return;
  if (data.type === "invite") {
    if (inVideoCall || pendingIncomingCall) {
      sendSignal({ target: from, data: { type: "decline", reason: "busy", callId: data.callId } });
      return;
    }
    pendingIncomingCall = { from, user: remoteUser, callId: data.callId };
    $("#incomingCallerName").textContent = remoteUser?.name || "Un utilisateur";
    $("#incomingCall").classList.remove("hidden");
    startRingtone();
    clearTimeout(incomingCallTimer);
    incomingCallTimer = setTimeout(() => declineIncomingCall("timeout"), 30000);
    navigator.vibrate?.([250, 150, 250]);
    return;
  }
  if (data.callId !== activeCallId && data.callId !== pendingIncomingCall?.callId) return;
  if (data.type === "decline") {
    showError(data.reason === "busy" ? "La personne est déjà en appel" : "Appel refusé ou sans réponse");
    hang();
    return;
  }
  if (data.type === "leave") {
    if (data.callId === activeCallId) hang(false); else closeIncomingCall();
    if (data.reason === "timeout") showError("Appel sans réponse");
    return;
  }
  if (data.callId !== activeCallId) return;
  if (data.type === "ice" && !peers.has(from)) {
    const list = pendingIce.get(from) || [];
    if (list.length < 128) list.push(data.candidate);
    pendingIce.set(from, list);
    return;
  }
  if (data.type === "join" && !inVideoCall) {
    showError("Un utilisateur a lancé un appel. Cliquez sur « Appeler » pour le rejoindre.");
    return;
  }
  if (data.type === "offer" && !inVideoCall) return;
  if ((data.type === "join" || data.type === "offer") && !(await startMedia()))
    return;
  const pc = peer(from, remoteUser?.name || "Participant");
  try {
    if (data.type === "join") {
      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      sendSignal({ target: from, data: { type: "offer", sdp: o } });
    } else if (data.type === "offer") {
      await pc.setRemoteDescription(data.sdp);
      await flushIce(from, pc);
      const a = await pc.createAnswer();
      await pc.setLocalDescription(a);
      sendSignal({ target: from, data: { type: "answer", sdp: a } });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(data.sdp);
      await flushIce(from, pc);
    } else if (data.type === "ice") {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else {
        const list = pendingIce.get(from) || [];
        if (list.length < 128) list.push(data.candidate);
        pendingIce.set(from, list);
      }
    }
  } catch (error) {
    console.error("Négociation WebRTC :", error);
    showError("La connexion vidéo a échoué. Quittez l’appel puis réessayez.");
  }
}
function addRemote(id, s, participantName = "Participant") {
  let d = document.getElementById(`v-${id}`);
  if (!d) {
    d = document.createElement("div");
    d.id = `v-${id}`;
    d.className = "video";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    const label = document.createElement("span");
    label.textContent = participantName;
    d.append(video, label);
    $("#videoGrid").append(d);
  }
  const remoteVideo = d.querySelector("video");
  remoteVideo.srcObject = s;
  remoteVideo.play().catch((error) => console.warn("Lecture vidéo distante :", error));
}
async function startDirectCall(socketId, participantName) {
  if (!socketId) return showError("Ce membre n’est plus disponible");
  if (inVideoCall || pendingIncomingCall) return showError("Terminez l’appel en cours avant d’en lancer un autre.");
  const requestedCallId = crypto.randomUUID();
  activeCallId = requestedCallId;
  if (await startMedia()) {
    if (activeCallId !== requestedCallId) { hang(false); return; }
    setCameraStatus(`Appel de ${participantName}…`);
    setCallStatus("Sonnerie…");
    sendSignal({ target: socketId, data: { type: "invite" } });
  }
}
$("#callBtn").onclick = async () => {
  openContactPicker("call");
};
function closeIncomingCall() {
  stopRingtone();
  clearTimeout(incomingCallTimer);
  incomingCallTimer = null;
  pendingIncomingCall = null;
  $("#incomingCall").classList.add("hidden");
}
function declineIncomingCall(reason = "declined") {
  const call = pendingIncomingCall;
  closeIncomingCall();
  if (call) sendSignal({ target: call.from, data: { type: "decline", reason, callId: call.callId } });
}
$("#acceptIncomingCall").onclick = async () => {
  const call = pendingIncomingCall;
  if (!call) return;
  clearTimeout(incomingCallTimer);
  $("#acceptIncomingCall").disabled = true;
  try {
    if (!await startMedia()) return;
    if (pendingIncomingCall !== call) { hang(); return; }
    activeCallId = call.callId;
    closeIncomingCall();
    setCameraStatus();
    setCallStatus("Connexion en cours…");
    sendSignal({ target: call.from, data: { type: "join" } });
  } finally {
    $("#acceptIncomingCall").disabled = false;
  }
};
$("#declineIncomingCall").onclick = () => declineIncomingCall();
function hang(notify = true) {
  if (notify) sendSignal({ target: null, data: { type: "leave" } });
  activeCallId = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  mediaStartPromise = null;
  inVideoCall = false;
  stopCallTimer();
  setCallStatus("Appel terminé");
  peers.forEach((p) => p.close());
  peers.clear();
  pendingIce.clear();
  document
    .querySelectorAll("#videoGrid .video:not(:first-child)")
    .forEach((x) => x.remove());
  $("#call").classList.add("hidden");
  closeIncomingCall();
}
$("#hangup").onclick = $("#closeCall").onclick = hang;
$("#mic").onclick = () => {
  stream?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
  updateMediaControls();
};
$("#cam").onclick = async () => {
  const track = stream?.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    setCameraStatus(track.enabled ? "" : "Caméra désactivée");
    updateMediaControls();
    return;
  }
  try {
    const newTrack = await openCamera();
    stream ||= new MediaStream();
    stream.addTrack(newTrack);
    $("#localVideo").srcObject = stream;
    await $("#localVideo").play().catch(() => {});
    for (const [id, pc] of peers) {
      pc.addTrack(newTrack, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ target: id, data: { type: "offer", sdp: offer } });
    }
    setCameraStatus();
    updateMediaControls();
  } catch (error) {
    setCameraStatus(`${mediaErrorMessage(error)}. Vérifiez l’autorisation caméra du navigateur.`);
  }
};
$("#fullscreenCall").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("#call").requestFullscreen();
  } catch { showError("Le plein écran n’est pas disponible sur cet appareil"); }
};
$("#screen").onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true }),
      track = s.getVideoTracks()[0];
    peers.forEach((p) =>
      p
        .getSenders()
        .find((x) => x.track?.kind === "video")
        ?.replaceTrack(track),
    );
    track.onended = () => {
      const cam = stream?.getVideoTracks()[0];
      cam &&
        peers.forEach((p) =>
          p
            .getSenders()
            .find((x) => x.track?.kind === "video")
            ?.replaceTrack(cam),
        );
    };
  } catch {}
};

$("#conversationSearch")?.addEventListener("input", renderPrivateConversations);
$("#friendSearch")?.addEventListener("input", renderFriends);

// Annuaire de présence global : aucun changement du salon ou du brouillon.
function renderOnlineMembers() {
  const badge = $("#onlineMembersBadge"), count = $("#onlineMembersCount"), grid = $("#onlineMembersGrid");
  if (!badge || !grid) return;
  const known = allOnlineMembers !== null;
  const members = (allOnlineMembers || []).filter(person => !blockedUsers.has(String(person.id)));
  badge.textContent = known ? String(members.length) : "…";
  count.textContent = known ? `${members.length} membre${members.length > 1 ? "s" : ""} visible${members.length > 1 ? "s" : ""} en ligne · tous les salons` : "En attente de la connexion en direct…";
  if ($("#onlineMembersModal").classList.contains("hidden")) return;
  if (!known) {
    grid.innerHTML = '<p class="online-members-empty" role="status">La liste se chargera dès que la connexion au tchat sera établie.</p>';
    return;
  }
  const query = normalizeSearch($("#onlineMembersSearch").value);
  const shown = members.filter(person => normalizeSearch(`${person.name} ${person.city || ""}`).includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  // Preserve keyboard focus when a live update redraws the directory.
  const focused = grid.contains(document.activeElement) ? {
    id: document.activeElement.dataset.onlineProfile || document.activeElement.dataset.onlineMessage || document.activeElement.dataset.privateUser,
    type: document.activeElement.hasAttribute("data-online-profile") ? "data-online-profile" : document.activeElement.hasAttribute("data-online-message") ? "data-online-message" : "data-private-user",
    avatar: document.activeElement.classList.contains("member-avatar-link"),
  } : null;
  const cards = people => people.map(person => {
    const mine = String(person.id) === String(user?.uid);
    const label = {available: "Disponible", busy: "Occupé", away: "Absent"}[person.availability] || "Connecté";
    return `<article class="online-member-card">
      <div class="online-member-heading">${memberLink(person.id, person.name, person.photo ? `<img src="${safe(person.photo)}" alt="">` : safe(initials(person.name)), "online-member-avatar member-avatar-link")}
      <div><h3>${memberLink(person.id, person.name)}${mine ? ' <small>(vous)</small>' : ""}${person.verified ? '<span class="verified-badge" title="Profil vérifié">✓</span>' : ""}</h3><span class="online-member-status">● ${label}</span></div></div>
      <p class="online-member-city">${safe(person.city || "Ville masquée")}</p>
      <p class="online-member-bio">${safe(person.bio || "Ce membre n’a pas encore ajouté de description.")}</p>
      <div class="online-member-actions"><button type="button" data-online-profile="${safe(person.id)}">${mine ? "Mon profil" : "Voir le profil"}</button>${mine ? "" : `<button type="button" class="online-member-message" data-online-message="${safe(person.id)}">Écrire en privé</button>`}</div>
    </article>`;
  }).join("");
  const groups = [
    { id: "female", title: "Femmes" },
    { id: "male", title: "Hommes" },
    { id: "neutral", title: "Autre / non précisé" },
  ];
  grid.innerHTML = shown.length ? groups.map(group => {
    const people = shown.filter(person => (["female", "male"].includes(person.gender) ? person.gender : "neutral") === group.id);
    if (!people.length) return "";
    return `<section class="online-members-category" aria-labelledby="onlineGroup-${group.id}"><h3 id="onlineGroup-${group.id}" class="online-members-group-title">${group.title}<span>${people.length}</span></h3><div class="online-members-group-grid">${cards(people)}</div></section>`;
  }).join("") : '<p class="online-members-empty" role="status">Aucun membre ne correspond à votre recherche.</p>';
  grid.querySelectorAll("[data-online-profile]").forEach(button => button.onclick = () => {
    const person = members.find(member => String(member.id) === button.dataset.onlineProfile);
    if (!person) return;
    $("#onlineMembersModal").classList.add("hidden");
    showPublicProfile(String(person.id), person.name);
  });
  grid.querySelectorAll("[data-online-message]").forEach(button => button.onclick = () => {
    const person = members.find(member => String(member.id) === button.dataset.onlineMessage);
    if (!person) return;
    $("#onlineMembersModal").classList.add("hidden");
    openPrivate(String(person.id), person.name);
  });
  if (focused?.id) {
    const replacement = [...grid.querySelectorAll(`[${focused.type}]`)].find(button => button.getAttribute(focused.type) === focused.id && (focused.type !== "data-private-user" || button.classList.contains("member-avatar-link") === focused.avatar));
    (replacement || $("#onlineMembersSearch")).focus();
  }
}
function openOnlineMembers(event) {
  event?.preventDefault();
  $(".side").classList.remove("open");
  $(".people").classList.remove("open");
  $("#onlineMembersSearch").value = "";
  $("#onlineMembersModal").classList.remove("hidden");
  renderOnlineMembers();
  $("#onlineMembersSearch").focus();
}
$("#onlineMembersLink").onclick = openOnlineMembers;
$("#onlineMembersShortcut").onclick = openOnlineMembers;
$("#closeOnlineMembers").onclick = () => $("#onlineMembersModal").classList.add("hidden");
$("#onlineMembersModal").addEventListener("click", event => {
  if (event.target === $("#onlineMembersModal")) $("#closeOnlineMembers").click();
});
$("#onlineMembersSearch").addEventListener("input", renderOnlineMembers);

// Le logo revient au salon d’accueil sans recharger ni perdre les brouillons.
$("#homeLink").addEventListener("click", () => {
  const cafe = roomLinks.find(link => link.dataset.room === "cafe");
  if (!cafe) return;
  cafe.closest("details").open = true;
  $(".people").classList.remove("open");
  selectRoom(cafe, "cafe");
  const heading = $(".chat header h1");
  heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
});

// Votre propre identité ouvre vos paramètres de profil.
$("#mePhotoLink").onclick = showProfile;
$("#meName").onclick = showProfile;

// Social extensions reuse the existing authenticated session and current conversation.
socialFeatures = installSocial({
  api, notify: showError, sendVoice: send, beforeLive: () => { if (inVideoCall) hang(); stopVoiceRecording(false); },
  getContext: () => ({ uid: user?.uid || "", socket, room: currentRoom, roomTitle: rooms[currentRoom]?.title || currentRoom,
    private: currentPrivate, privateHome: privateHomeOpen, contacts: [...(allOnlineMembers || lastPeople), ...[...friendRelations.values()].filter(f => f.status === "accepted")] })
});
premiumFeatures = installPremiumBenefitsUI({ api, showProfile, openPrivate, showPublicProfile,
  onPresenceChange: (id, hidden) => {
    if (viewedProfile?.id === id && !$("#publicProfileModal").classList.contains("hidden")) {
      if (hidden) { $("#publicProfileStatus").textContent = "Présence masquée"; $("#publicProfileLastSeen").textContent = "Masquée"; }
      else showPublicProfile(id, viewedProfile.name);
    }
    loadFriends(); loadPrivateConversations();
  },
  getContext: () => ({uid:user?.uid || "",name:user?.displayName || "",socket}) });

surpriseFeatures = installSurpriseUI({ openPrivate, notify: showError, closePanels: closeMemberPanels,
  openHome: id => { if (currentPrivate?.id === id) showPrivateMessagesHome(); },
  report: target => openReport(target), block: blockPrivateUser });
