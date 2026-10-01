export function installCommunityUI({ api, getUser, openRoom, openPrivate, openMembers, openProfile, closePanels, upgradeSession, showRecoveryCode }) {
  const q = (selector, root = document) => root.querySelector(selector);
  const make = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent:text || "" });
  let started = false, loading = false, snapshot = null, upgrading = false;
  const home = document.createElement("dialog");
  home.id = "communityHome"; home.className = "community-dialog"; home.setAttribute("aria-labelledby", "communityTitle");
  home.innerHTML = `<div class="community-heading"><div><span class="community-eyebrow">VOTRE COMMUNAUTÉ</span><h2 id="communityTitle">On discute ?</h2></div><button type="button" data-close aria-label="Fermer l’accueil">×</button></div>
    <div class="community-body"><p class="community-intro">Rejoignez une discussion, retrouvez vos contacts ou faites une nouvelle rencontre.</p>
    <div class="community-live" role="status">Connexion à la communauté…</div>
    <div class="community-quick"><button type="button" data-join class="community-primary">Rejoindre une discussion</button><button type="button" data-spaces>Explorer les communautés</button><button type="button" data-surprise>Rencontre Surprise <span aria-hidden="true">↗</span></button></div>
    <section><div class="community-section-heading"><h3>Les salons maintenant</h3><button type="button" data-all-rooms>Tous les salons</button></div><div class="community-rooms"></div></section>
    <section><div class="community-section-heading"><h3>Disponibles pour discuter</h3><button type="button" data-members>Voir les membres</button></div><div class="community-members"></div></section>
    <section class="community-empty-tip" hidden><h3>Vous ouvrez la discussion</h3><p>Le Café accueille les nouveaux échanges. Présentez-vous ou partagez une question ; les prochains membres pourront vous répondre.</p><button type="button" data-cafe>Entrer au Café</button></section>
    <section class="community-guest" hidden><div><h3>Gardez votre place sur Letchat</h3><p data-expiry></p><p>Conservez votre profil et vos contacts avec un mot de passe. Les messages gardent leur durée de vie de 48 heures.</p></div><button type="button" data-upgrade>Conserver mon compte</button></section>
    <p class="community-error" role="alert"></p><button type="button" data-retry hidden>Réessayer</button><p class="community-footnote">Les compteurs indiquent les autres membres visibles, sans compter vos propres connexions.</p></div>`;
  document.body.append(home);
  const upgrade = document.createElement("dialog");
  upgrade.id = "guestUpgrade"; upgrade.className = "community-dialog guest-upgrade"; upgrade.setAttribute("aria-labelledby", "guestUpgradeTitle");
  upgrade.innerHTML = `<div class="community-heading"><h2 id="guestUpgradeTitle">Conserver mon compte</h2><button type="button" data-close aria-label="Fermer">×</button></div>
    <form class="community-body"><p>Votre profil, vos amis et vos conversations encore disponibles restent avec vous.</p>
    <label>Identifiant de connexion<input name="username" autocomplete="username" minlength="3" maxlength="40" required aria-describedby="guestUsernameHelp"></label>
    <small id="guestUsernameHelp">Vous pourrez vous reconnecter avec cet identifiant. Votre nom affiché reste inchangé.</small>
    <label>Mot de passe<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label>
    <label>Confirmer le mot de passe<input name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label>
    <p>Au moins 8 caractères. Un code de récupération vous sera remis après la création.</p>
    <p class="community-error" role="alert"></p><button type="submit" class="community-primary">Garder mon compte gratuitement</button></form>`;
  document.body.append(upgrade);
  const reminder = make("section", "guest-reminder"); reminder.hidden = true;
  reminder.innerHTML = `<span></span><button type="button">Garder mon compte</button>`;
  q(".chat > footer").before(reminder);
  const profileUpgrade = make("section", "community-guest profile-guest-upgrade"); profileUpgrade.hidden = true;
  profileUpgrade.innerHTML = `<h3>Votre compte est temporaire</h3><p data-expiry></p><button type="button">Conserver mon compte</button>`;
  q("#profileForm h2").after(profileUpgrade);
  const nav = make("nav", "community-mobile-nav"); nav.setAttribute("aria-label", "Navigation principale");
  const icons = {
    rooms:'<path d="M3 5h18v12H9l-6 4V5Z"/>', messages:'<path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/>',
    members:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/>',
    profile:'<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
  };
  for (const [id,label] of [["rooms","Salons"],["messages","Messages"],["members","Membres"],["profile","Profil"]]) {
    const button = make("button", ""); button.type = "button"; button.dataset.destination = id;
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[id]}</svg><span>${label}</span>${id === "messages" ? '<b class="community-unread" hidden></b>' : ""}`;
    nav.append(button);
  }
  q(".chat").append(nav);
  const closeHome = () => { if (home.open) home.close(); };
  function chooseRoom(id) { closeHome(); closePanels(); openRoom(id); syncNav(); }
  function showHome() {
    if (!getUser() || !q("#rulesModal").classList.contains("hidden")) return;
    closePanels();
    if (!home.open) home.showModal();
    refreshIdentity(); syncNav(); refresh();
  }
  function showUpgrade() {
    if (!getUser()?.guest) return;
    closeHome(); closePanels(); q("#profileModal").classList.add("hidden");
    const form = q("form", upgrade); form.reset();
    form.elements.username.value = getUser().loginUsername || getUser().displayName || "";
    q(".community-error", upgrade).textContent = "";
    if (!upgrade.open) upgrade.showModal();
  }
  function expiryText() {
    const date = new Date(getUser()?.expiresAt), remaining = date.getTime() - Date.now();
    if (!Number.isFinite(remaining)) return "Compte invité valable 24 heures. Conservez-le avant son expiration.";
    if (remaining <= 0) return "Votre accès invité a expiré. Reconnectez-vous.";
    const minutes = Math.max(1, Math.ceil(remaining / 60000));
    return `Invité · ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2,"0")} restantes`;
  }
  function refreshIdentity() {
    const guest = Boolean(getUser()?.guest);
    q(".community-guest", home).hidden = !guest; reminder.hidden = !guest; profileUpgrade.hidden = !guest;
    for (const node of [q("[data-expiry]", home),q("[data-expiry]", profileUpgrade),q("span", reminder)]) node.textContent = expiryText();
  }
  function render(data) {
    snapshot = data;
    q(".community-live", home).textContent = data.onlineCount
      ? `${data.onlineCount} autre${data.onlineCount > 1 ? "s" : ""} membre${data.onlineCount > 1 ? "s" : ""} en ligne · ${data.availableCount} disponible${data.availableCount > 1 ? "s" : ""}`
      : "La communauté est calme pour le moment.";
    q("[data-join]", home).textContent = data.rooms.some(room => room.count > 0) ? "Rejoindre une discussion" : "Ouvrir la discussion au Café";
    const rooms = q(".community-rooms", home); rooms.replaceChildren();
    for (const room of data.rooms) {
      const button = make("button", "community-room"); button.type = "button"; button.dataset.communityRoom = room.id;
      button.append(make("strong", "", room.title.replace(/^[^\p{L}\p{N}]+/u,"")), make("span", "", room.description), make("small", room.count ? "has-activity" : "", room.count ? `${room.count} autre${room.count > 1 ? "s" : ""} membre${room.count > 1 ? "s" : ""} · Rejoindre →` : "Commencer une discussion →"));
      button.onclick = () => chooseRoom(room.id); rooms.append(button);
    }
    const members = q(".community-members", home); members.replaceChildren();
    for (const person of data.members) {
      const button = make("button", "community-member"); button.type = "button";
      // Initials do not issue third-party image requests or disclose hidden locations.
      button.append(make("span", "community-avatar", person.name.trim().slice(0,2).toUpperCase()), make("strong", "", person.name), make("span", "", "Écrire →"));
      button.onclick = () => { closeHome(); openPrivate(person.id, person.name); }; members.append(button);
    }
    if (!data.members.length) members.append(make("p", "community-muted", "Personne n’est disponible pour une nouvelle conversation privée actuellement."));
    q(".community-empty-tip", home).hidden = data.onlineCount > 0;
  }
  async function refresh() {
    if (loading || !home.open || !getUser()) return;
    if (q("#connectionStatus")?.dataset.state !== "online") {
      home.dataset.fingerprint = "";
      q(".community-live", home).textContent = "Connexion en cours… L’activité sera actualisée dès votre retour en ligne.";
      q("[data-join]", home).disabled = true;
      return;
    }
    loading = true;
    try {
      const data = await (await api("/api/community/home")).json();
      if (!home.open) return;
      // Refresh only on changed data to keep keyboard focus on an existing card.
      const fingerprint = JSON.stringify({rooms:data.rooms,members:data.members,onlineCount:data.onlineCount,availableCount:data.availableCount});
      if (home.dataset.fingerprint !== fingerprint) { render(data); home.dataset.fingerprint = fingerprint; }
      q(".community-error", home).textContent = ""; q("[data-retry]", home).hidden = true; q("[data-join]", home).disabled = false;
    } catch {
      q(".community-error", home).textContent = "L’activité n’a pas pu être actualisée. Vous pouvez toujours ouvrir un salon.";
      q("[data-retry]", home).hidden = false;
      q("[data-join]", home).disabled = true;
    } finally { loading = false; }
  }
  q("[data-close]", home).onclick = closeHome;
  home.addEventListener("close", syncNav);
  q("[data-join]", home).onclick = () => chooseRoom(snapshot?.rooms.find(room => room.count > 0)?.id || "cafe");
  q("[data-cafe]", home).onclick = () => chooseRoom("cafe");
  q("[data-all-rooms]", home).onclick = () => { closeHome(); q("#roomsBtn").click(); };
  q("[data-members]", home).onclick = () => { closeHome(); openMembers(); };
  q("[data-surprise]", home).onclick = () => { closeHome(); q("#surpriseLink").click(); };
  q("[data-retry]", home).onclick = refresh;
  q("[data-upgrade]", home).onclick = showUpgrade;
  q("button", reminder).onclick = showUpgrade; q("button", profileUpgrade).onclick = showUpgrade;
  q("[data-close]", upgrade).onclick = () => { if (!upgrading) upgrade.close(); };
  upgrade.addEventListener("cancel", event => { if (upgrading) event.preventDefault(); });
  upgrade.addEventListener("close", () => { if (!upgrading) q("form", upgrade).reset(); });
  q("form", upgrade).addEventListener("input", () => { q(".community-error", upgrade).textContent = ""; });
  q("form", upgrade).onsubmit = async event => {
    event.preventDefault(); if (upgrading) return;
    const form = event.currentTarget, button = q('[type="submit"]', form), error = q(".community-error", form);
    if (form.elements.password.value !== form.elements.confirmation.value) { error.textContent = "Les deux mots de passe doivent être identiques."; return; }
    upgrading = true; error.textContent = ""; button.disabled = true; button.textContent = "Enregistrement…";
    q("[data-close]", upgrade).disabled = true;
    try {
      const data = await (await api("/api/account/upgrade-guest", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username:form.elements.username.value,password:form.elements.password.value}) })).json();
      await upgradeSession(data); refreshIdentity(); form.reset(); upgrade.close(); showRecoveryCode(data.recoveryCode, data.user.loginUsername);
    } catch (e) { error.textContent = e instanceof TypeError ? "Connexion interrompue. Si le compte a été enregistré, reconnectez-vous avec l’identifiant et le mot de passe choisis." : e.message; }
    finally { upgrading = false; button.disabled = false; button.textContent = "Garder mon compte gratuitement"; q("[data-close]", upgrade).disabled = false; }
  };
  for (const button of nav.querySelectorAll("button")) button.onclick = () => {
    closePanels();
    if (button.dataset.destination === "rooms") showHome();
    if (button.dataset.destination === "messages") q("#privateMessagesLink").click();
    if (button.dataset.destination === "members") openMembers();
    if (button.dataset.destination === "profile") openProfile();
    syncNav();
  };
  function syncNav() {
    const mode = !q("#profileModal").classList.contains("hidden") ? "profile" : !q("#onlineMembersModal").classList.contains("hidden") ? "members" : q("#privateMessagesLink").classList.contains("active") ? "messages" : "rooms";
    for (const button of nav.querySelectorAll("button")) {
      if ((home.open ? "rooms" : mode) === button.dataset.destination) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    const badge = q("#privateMessagesNavBadge"), clone = q(".community-unread", nav);
    clone.hidden = badge.classList.contains("hidden"); clone.textContent = badge.textContent;
    q('[data-destination="messages"]', nav).setAttribute("aria-label", clone.hidden ? "Messages" : `Messages, ${badge.textContent} non lus`);
  }
  for (const selector of ["#profileModal", "#onlineMembersModal", "#privateMessagesLink", "#privateMessagesNavBadge"])
    new MutationObserver(syncNav).observe(q(selector), {attributes:true,attributeFilter:["class"],childList:true,characterData:true,subtree:true});
  new MutationObserver(() => { if (home.open) refresh(); }).observe(q("#connectionStatus"), {attributes:true,attributeFilter:["data-state"]});
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshIdentity(); refresh(); } });
  setInterval(() => { if (!document.hidden && getUser()) { refreshIdentity(); refresh(); } }, 15000);
  syncNav();
  return { showHome, refreshIdentity, refresh, start() { if (!started) { started = true; refreshIdentity(); showHome(); } } };
}
