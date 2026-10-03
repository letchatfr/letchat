import { createVoiceRecorder, blobBase64 } from "./social-voice.e9c6f0e283d0.js";
import { createLiveView } from "./social-live.d8b6f156ef72.js";
import { createAlbum } from "./social-album.94d22e79e2b9.js";

export function installSocial({ getContext, api, notify, report, sendVoice, beforeLive }) {
  const escape = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const q = (selector, root = document) => root.querySelector(selector);
  const json = async (path, method = "GET", body) => (await api(`/api/social${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) })).json();
  const attempt = fn => async (...args) => { try { await fn(...args); } catch (e) { notify(e.message); } };
  const recorder = createVoiceRecorder();
  const live = createLiveView({ getContext, api, notify, beforeJoin: beforeLive });
  const toolbar = document.createElement("div"); toolbar.className = "social-toolbar";
  toolbar.innerHTML = `<button type="button" data-live>▣ Visio du salon</button><button type="button" data-groups>◉ Groupes <span></span></button><button type="button" data-games>⚄ Jeux à deux <span></span></button>`;
  q(".chat > header").after(toolbar);
  function dialog(title, className = "") {
    const d = document.createElement("dialog"); d.className = `social-dialog ${className}`;
    d.innerHTML = `<div class="social-top"><h2>${title}</h2><button type="button" data-close aria-label="Fermer">×</button></div><div class="social-content"></div>`;
    q("[data-close]", d).onclick = () => d.close(); document.body.append(d); return d;
  }
  const groupDialog = dialog("Mes groupes", "social-groups"), gameDialog = dialog("Jeux à deux", "social-games"), profileDialog = dialog("Mon profil enrichi", "social-profile");
  let groups = [], games = [], activeGroup = null, currentGame = null, socket, owner = "", currentContext = "", refreshing = null, refreshAgain = false, lastGroupMessages = "", generation = 0, groupOpenRevision = 0, groupMessageRevision = 0;
  const objectUrls = new Map();
  function clearUrls(root) { for (const [el, url] of objectUrls) if (root.contains(el) || !el.isConnected) { if (el.pause) el.pause(); URL.revokeObjectURL(url); objectUrls.delete(el); } }
  async function media(root) {
    const uid = getContext().uid;
    await Promise.all([...root.querySelectorAll("[data-social-media]")].map(async el => {
      if (el.dataset.loaded) return; el.dataset.loaded = "1";
      try {
        const blob = await (await api(el.dataset.socialMedia)).blob();
        if (!el.isConnected || getContext().uid !== uid) return;
        const url = URL.createObjectURL(blob); objectUrls.set(el, url); el.src = url;
      } catch { if (el.isConnected) { const p = document.createElement("small"); p.textContent = "Média indisponible ou expiré"; el.replaceWith(p); } }
    }));
  }
  const contacts = () => {
    const map = new Map();
    for (const x of getContext().contacts || []) {
      const id = String(x.user_id || x.id || "");
      if (id && id !== getContext().uid) map.set(id, { id, name: x.name || x.display_name || "Membre" });
    }
    if (getContext().private) map.set(getContext().private.id, getContext().private);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  };
  function options(multiple = false) {
    const selected = getContext().private?.id;
    if (multiple) return `<div class="social-invite-list">${contacts().map(c => `<label><input type="checkbox" name="members" value="${escape(c.id)}" ${c.id === selected ? "checked" : ""}><span>${escape(c.name)}</span></label>`).join("") || '<p>Aucun contact disponible. Ajoutez des amis ou retrouvez des membres en ligne.</p>'}</div>`;
    return `<select ${multiple ? 'multiple size="6"' : ""} name="members" required aria-label="${multiple ? "Invités" : "Adversaire"}">${contacts().map(c => `<option value="${escape(c.id)}" ${c.id === selected ? "selected" : ""}>${escape(c.name)}</option>`).join("")}</select>`;
  }
  function show(d) { if (!d.open) { if (d === gameDialog) d.show(); else d.showModal(); } }
  function refresh() {
    if (!getContext().uid) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => { do {
      refreshAgain = false; const stamp = generation;
      const [gg, gm] = await Promise.all([json("/groups"), json("/games")]);
      if (stamp !== generation) continue;
      groups = gg; games = gm;
      q("[data-groups] span", toolbar).textContent = groups.filter(g => g.status === "pending").length || "";
      q("[data-games] span", toolbar).textContent = games.filter(g => g.status === "pending" && g.opponent_id === getContext().uid).length || "";
      if (groupDialog.open) {
        drawGroupList();
        if (activeGroup) await loadGroupMessages();
      }
      if (gameDialog.open) { drawGameList(); drawGame(); }
    } while (refreshAgain && getContext().uid); })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function drawGroupList() {
    const list = q("[data-group-list]", groupDialog); if (!list) return;
    list.innerHTML = groups.length ? groups.map(g => `<button class="social-list-item ${activeGroup?.id === g.id ? "active" : ""}" type="button" data-group="${g.id}"><strong>${escape(g.name)}</strong><small>${g.status === "pending" ? "Invitation à accepter" : `${g.members} membre(s)`}</small></button>`).join("") : '<p class="social-empty">Créez un groupe avec vos amis ou des membres en ligne.</p>';
    list.querySelectorAll("[data-group]").forEach(b => b.onclick = attempt(() => openGroup(b.dataset.group)));
  }
  async function openGroups() {
    activeGroup = null; clearUrls(groupDialog);
    q(".social-content", groupDialog).innerHTML = `<div class="social-split"><aside><button type="button" data-new-group>＋ Créer un groupe</button><div data-group-list></div></aside><section data-group-detail class="social-group-detail"><p class="social-empty">Choisissez une conversation.</p></section></div>`;
    q("[data-new-group]", groupDialog).onclick = attempt(createGroupForm); drawGroupList(); show(groupDialog); await refresh();
  }
  async function createGroupForm() {
    const revision = ++groupOpenRevision, uid = getContext().uid;
    const { groupLimit } = await json("/limits");
    if (revision !== groupOpenRevision || uid !== getContext().uid || !groupDialog.open) return;
    activeGroup = null; clearUrls(groupDialog);
    q("[data-group-detail]", groupDialog).innerHTML = `<form data-create-group class="social-form"><h3>Un groupe, vos invités</h3><label>Nom du groupe<input name="name" required maxlength="60" placeholder="Les amis du Café"></label>
      <fieldset class="social-invite-field"><legend>Invitez jusqu’à ${groupLimit - 1} personnes</legend>${options(true)}</fieldset><small>${groupLimit} membres, vous compris. Chacun doit accepter. Les messages sont conservés 48 heures.${groupLimit === 8 ? " Avec Premium : groupes de 20 membres." : ""}</small><button type="submit">Envoyer les invitations</button><p role="status" data-form-status></p></form>`;
    q("[data-create-group]", groupDialog).onsubmit = async e => {
      e.preventDefault(); const form = e.currentTarget, button = q("button[type=submit]", form); button.disabled = true;
      try {
        const members = [...form.querySelectorAll('input[name="members"]:checked')].map(o => o.value);
        if (!members.length || members.length >= groupLimit) throw new Error(`Cochez de 1 à ${groupLimit - 1} invités.`);
        const created = await json("/groups", "POST", { name: form.elements.name.value, members });
        await refresh(); await openGroup(created.id);
      } catch (error) { q("[data-form-status]", form).textContent = error.message; } finally { button.disabled = false; }
    };
  }
  async function openGroup(id) {
    const request = ++groupOpenRevision;
    const g = groups.find(x => x.id === id); if (!g) return;
    activeGroup = null; clearUrls(groupDialog); const box = q("[data-group-detail]", groupDialog);
    if (g.status === "pending") {
      box.innerHTML = `<h3>${escape(g.name)}</h3><p>Vous avez reçu une invitation. Les échanges sont accessibles après votre accord.</p><div class="social-actions"><button data-accept-group type="button">Accepter</button><button data-decline-group type="button">Refuser</button></div>`;
      q("[data-accept-group]", box).onclick = attempt(async () => { await json(`/groups/${id}/accept`, "POST"); await refresh(); await openGroup(id); });
      q("[data-decline-group]", box).onclick = attempt(async () => { await json(`/groups/${id}/membership`, "DELETE"); await openGroups(); }); return;
    }
    const uid = getContext().uid, group = await json(`/groups/${id}`);
    if (request !== groupOpenRevision || getContext().uid !== uid || !groupDialog.open) return;
    activeGroup = group; lastGroupMessages = ""; drawGroupList();
    box.innerHTML = `<div class="social-group-heading"><div><h3>${escape(group.name)}</h3><small>${group.members.filter(m => m.status === "accepted").map(m => escape(m.display_name)).join(", ")}</small></div><button type="button" data-group-call>▣ Appel de groupe</button><button type="button" data-leave-group>${group.owner_id === uid ? "Supprimer le groupe" : "Quitter"}</button></div>
      <p class="social-note">Messages effacés après 48 h · ${group.members.filter(m => m.status === "pending").length} invitation(s) en attente</p>
      <p class="social-note" data-group-status role="status" hidden></p>
      <div class="social-group-messages" data-group-messages role="log" aria-label="Messages du groupe"></div>
      <form class="social-group-composer" data-group-form><textarea name="message" maxlength="4000" rows="2" aria-label="Message au groupe" placeholder="Écrire au groupe…"></textarea><div class="social-actions"><button type="button" data-group-photo>Photo</button><input type="file" accept="image/*" data-group-file hidden><button type="button" data-group-voice>Vocal</button><button type="submit">Envoyer</button></div></form>`;
    q("[data-group-call]", box).onclick = attempt(async () => { groupDialog.close(); await live.join(`group:${id}`, group.name); });
    q("[data-leave-group]", box).onclick = attempt(async () => { if (window.confirm(group.owner_id === uid ? "Supprimer ce groupe et ses messages pour tous les membres ?" : "Quitter ce groupe ?")) { await json(`/groups/${id}/membership`, "DELETE"); activeGroup = null; await openGroups(); } });
    const form = q("[data-group-form]", box);
    form.onsubmit = async e => {
      e.preventDefault(); const input = form.elements.message, body = input.value.trim(); if (!body) return;
      const button = q("button[type=submit]", form); button.disabled = true;
      try { await json(`/groups/${id}/messages`, "POST", { body }); if (input.value.trim() === body) input.value = ""; await loadGroupMessages(true); }
      catch (error) { notify(error.message); } finally { button.disabled = false; }
    };
    const upload = async blob => { if (getContext().uid !== uid) return; await json(`/groups/${id}/messages`, "POST", { mediaBase64: await blobBase64(blob), mediaType: blob.type.split(";")[0] }); if (activeGroup?.id === id) await loadGroupMessages(true); };
    q("[data-group-photo]", box).onclick = () => q("[data-group-file]", box).click();
    q("[data-group-file]", box).onchange = attempt(async e => { const file = e.target.files[0]; e.target.value = ""; if (file) { if (file.size > 8e6) throw new Error("8 Mo maximum"); await upload(file); } });
    q("[data-group-voice]", box).onclick = attempt(async () => { const blob = await recorder.open({ title: `Vocal pour ${group.name}` }); if (blob) await upload(blob); });
    await loadGroupMessages(true);
  }
  async function loadGroupMessages(scroll = false) {
    if (!activeGroup || !groupDialog.open) return;
    const id = activeGroup.id, uid = getContext().uid, revision = groupOpenRevision, request = ++groupMessageRevision;
    const current = () => groupDialog.open && activeGroup?.id === id && getContext().uid === uid && revision === groupOpenRevision && request === groupMessageRevision;
    if (!groups.some(g => g.id === id && g.status === "accepted")) { activeGroup = null; clearUrls(groupDialog); q("[data-group-detail]", groupDialog).textContent = "Ce groupe n’est plus accessible."; return; }
    let rows;
    try { rows = await json(`/groups/${id}/messages`); }
    catch (e) {
      if (!current()) return;
      if ([401, 403, 404, 410].includes(e.status)) {
        activeGroup = null; clearUrls(groupDialog); q("[data-group-detail]", groupDialog).textContent = e.message;
      } else {
        const status = q('[data-group-status]', groupDialog);
        status.hidden = false;
        status.textContent = 'Actualisation interrompue. Vos messages et votre brouillon sont conservés ; la discussion reprendra au retour de la connexion.';
      }
      return;
    }
    if (!current()) return;
    const status = q('[data-group-status]', groupDialog); status.textContent = ''; status.hidden = true;
    const signature = JSON.stringify(rows); if (signature === lastGroupMessages) return; lastGroupMessages = signature;
    const box = q("[data-group-messages]", groupDialog); if (!box) return;
    const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    clearUrls(box);
    box.innerHTML = rows.length ? rows.map(m => `<article class="social-bubble ${m.sender_id === uid ? "mine" : ""}"><header><strong>${escape(m.sender_name)}</strong><time>${new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time>${m.sender_id !== uid && report ? `<button data-report-message="${m.id}" type="button" aria-label="Signaler le message">Signaler</button>` : ""}${m.sender_id === uid || activeGroup.owner_id === uid ? `<button data-delete-message="${m.id}" type="button" aria-label="Supprimer le message">×</button>` : ""}</header><p>${escape(m.body)}</p>${m.media_type ? m.media_type.startsWith("image/") ? `<img alt="Photo partagée" data-social-media="/api/social/group-media/${m.id}">` : `<${m.media_type.startsWith("audio/") ? "audio" : "video"} controls preload="metadata" data-social-media="/api/social/group-media/${m.id}"></${m.media_type.startsWith("audio/") ? "audio" : "video"}>` : ""}</article>`).join("") : '<p class="social-empty">Votre conversation commence ici.</p>';
    box.querySelectorAll("[data-delete-message]").forEach(b => b.onclick = attempt(async () => { await json(`/groups/${id}/messages/${b.dataset.deleteMessage}`, "DELETE"); await loadGroupMessages(); }));
    [...box.querySelectorAll('.social-bubble')].forEach((el, index) => { el.dataset.expires = rows[index].expires_at; });
    box.querySelectorAll("[data-report-message]").forEach(b => b.onclick = () => {
      const m = rows.find(m => String(m.id) === b.dataset.reportMessage); if (!m) return;
      groupDialog.close(); report({ id: m.sender_id, name: m.sender_name }, { id: m.id, kind: "group" });
    });
    await media(box); if (bottom || scroll) box.scrollTop = box.scrollHeight;
  }
  const gameName = kind => kind === "connect4" ? "Puissance 4" : "Morpion";
  function drawGameList() {
    const list = q("[data-game-list]", gameDialog); if (!list) return;
    list.innerHTML = games.length ? games.map(g => `<button type="button" class="social-list-item ${currentGame === g.id ? "active" : ""}" data-game="${g.id}"><strong>${gameName(g.kind)}</strong><small>${escape(g.creator_id === getContext().uid ? g.opponent_name : g.creator_name)} · ${{ pending: "Invitation", active: "En cours", won: "Terminée", draw: "Égalité", declined: "Refusée" }[g.status] || "Terminée"}</small></button>`).join("") : '<p class="social-empty">Lancez votre premier défi.</p>';
    list.querySelectorAll("[data-game]").forEach(b => b.onclick = () => { currentGame = b.dataset.game; drawGameList(); drawGame(); });
  }
  async function openGames() {
    if (q("[data-game-list]", gameDialog)) { show(gameDialog); await refresh(); return; }
    currentGame = null;
    q(".social-content", gameDialog).innerHTML = '<div class="social-split"><aside><button type="button" data-new-game>＋ Défier un membre</button><div data-game-list></div></aside><section data-game-detail class="social-game-detail"></section></div>';
    q("[data-new-game]", gameDialog).onclick = gameForm; show(gameDialog); drawGameList(); gameForm(); await refresh();
  }
  function gameForm() {
    currentGame = null;
    q("[data-game-detail]", gameDialog).innerHTML = `<form class="social-form" data-create-game><h3>Un jeu pour faire connaissance</h3><label>Avec qui ?${options()}</label><label>Choisissez votre jeu<select name="kind"><option value="connect4">Puissance 4</option><option value="tictactoe">Morpion</option></select></label><p>L’autre membre reçoit une invitation. La partie commence après son accord.</p><button type="submit">Envoyer le défi</button><p role="status" data-status></p></form>`;
    q("[data-create-game]", gameDialog).onsubmit = async e => { e.preventDefault(); const f = e.currentTarget, b = q("button", f); b.disabled = true;
      try { const r = await json("/games", "POST", { opponentId: f.elements.members.value, kind: f.elements.kind.value }); await refresh(); currentGame = r.id; drawGameList(); drawGame(); }
      catch (error) { q("[data-status]", f).textContent = error.message; } finally { b.disabled = false; }
    };
  }
  function drawGame() {
    if (!currentGame) return;
    const g = games.find(g => g.id === currentGame), box = q("[data-game-detail]", gameDialog), uid = getContext().uid;
    if (!g) { box.innerHTML = '<p class="social-empty">Cette partie n’est plus disponible.</p>'; return; }
    const myTurn = g.status === "active" && g.turn_id === uid;
    const name = id => id === g.creator_id ? g.creator_name : g.opponent_name;
    const status = g.status === "pending" ? "En attente d’acceptation" : g.status === "active" ? (myTurn ? "À vous de jouer" : `Au tour de ${name(g.turn_id)}`) : g.status === "won" ? `${name(g.winner_id)} remporte la partie` : g.status === "draw" ? "Match nul" : "Invitation refusée";
    const mine = g.creator_id === uid ? 1 : 2;
    box.innerHTML = `<h3>${gameName(g.kind)}</h3><p class="social-note">${escape(g.creator_name)} contre ${escape(g.opponent_name)} · Vous : ${g.kind === "connect4" ? mine === 1 ? "corail" : "bleu" : mine === 1 ? "X" : "O"}</p><p class="social-game-status" role="status">${escape(status)}</p>
      ${g.status === "pending" ? `<div class="social-actions">${g.opponent_id === uid ? '<button type="button" data-action="accept">Accepter</button>' : ""}<button type="button" data-action="decline">${g.opponent_id === uid ? "Refuser" : "Annuler"}</button></div>` : `<div class="social-board ${g.kind}">${g.board.map((value, i) => `<button type="button" data-move="${g.kind === "connect4" ? i % 7 : i}" class="piece-${value}" ${!myTurn || (g.kind === "tictactoe" && value) ? "disabled" : ""} aria-label="${g.kind === "connect4" ? "Colonne " + (i % 7 + 1) : "Case " + (i + 1)}${value ? ' occupée par ' + (value === 1 ? 'X' : 'O') : ""}">${value ? value === 1 ? "X" : "O" : "·"}</button>`).join("")}</div>${g.status === "active" ? '<button type="button" data-action="resign">Abandonner</button>' : '<button type="button" data-rematch>Nouvelle partie</button>'}`}`;
    const action = async payload => {
      box.querySelectorAll("button").forEach(b => b.disabled = true);
      try { await json(`/games/${g.id}/action`, "POST", { ...payload, version: g.version }); }
      finally { await refresh(); drawGame(); }
    };
    box.querySelectorAll("[data-action]").forEach(b => b.onclick = attempt(() => action({ action: b.dataset.action })));
    box.querySelectorAll("[data-move]").forEach(b => b.onclick = attempt(() => action({ action: "move", move: Number(b.dataset.move) })));
    if (q("[data-rematch]", box)) q("[data-rematch]", box).onclick = attempt(async () => { const r = await json("/games", "POST", { opponentId: g.creator_id === uid ? g.opponent_id : g.creator_id, kind: g.kind }); await refresh(); currentGame = r.id; drawGameList(); drawGame(); });
  }
  async function editProfile() {
    const uid = getContext().uid, data = await json(`/profile/${encodeURIComponent(uid)}`);
    if (getContext().uid !== uid) return;
    clearUrls(profileDialog);
    q(".social-content", profileDialog).innerHTML = `<form class="social-form" data-rich-profile>
      <div class="social-cover-preview">${data.cover ? `<img alt="Ma couverture" data-social-media="/api/social/profile/${encodeURIComponent(uid)}/cover">` : '<p>Une couverture qui vous ressemble</p>'}</div>
      <label>Photo de couverture<input name="cover" type="file" accept="image/jpeg,image/png,image/webp"></label><label class="social-check"><input type="checkbox" name="removeCover">Supprimer la couverture</label>
      <label>Mon caractère<textarea name="character" maxlength="280" placeholder="Plutôt curieux, calme, spontané…">${escape(data.character || "")}</textarea></label>
      <label>Ce que j’aime<textarea name="likes" maxlength="280" placeholder="Mes passions et petits plaisirs…">${escape(data.likes || "")}</textarea></label>
      <label>Ce que je cherche ici<textarea name="looking_for" maxlength="280" placeholder="Des amis, des discussions, des rencontres…">${escape(data.looking_for || "")}</textarea></label>
      <label>Qui peut voir ces ajouts ?<select name="visibility"><option value="public">Tous les membres connectés</option><option value="friends" ${data.visibility === "friends" ? "selected" : ""}>Mes amis uniquement</option></select></label>
      <div data-voice-preview>${data.voice ? `<audio controls data-social-media="/api/social/profile/${encodeURIComponent(uid)}/voice"></audio>` : ""}</div>
      <button type="button" data-profile-voice>Enregistrer ma présentation · 30 s</button><label class="social-check"><input type="checkbox" name="removeVoice">Supprimer la présentation vocale</label>
      <button type="submit">Enregistrer mon profil enrichi</button><p role="status" data-status></p></form>`;
    show(profileDialog); await media(profileDialog);
    const form = q("form", profileDialog); let voice;
    form.elements.cover.onchange = () => {
      const file = form.elements.cover.files[0]; if (!file) return;
      form.elements.removeCover.checked = false;
      const box = q(".social-cover-preview", form); clearUrls(box); box.innerHTML = '<img alt="Aperçu de ma couverture">';
      const el = q("img", box), url = URL.createObjectURL(file); el.src = url; objectUrls.set(el, url);
    };
    q("[data-profile-voice]", form).onclick = attempt(async () => {
      const b = await recorder.open({ title: "Ma présentation vocale", seconds: 30 });
      if (!b || !form.isConnected || getContext().uid !== uid) return;
      voice = b; form.elements.removeVoice.checked = false;
      const box = q("[data-voice-preview]", form); clearUrls(box); box.innerHTML = '<audio controls></audio>';
      const el = q("audio", box), url = URL.createObjectURL(b); el.src = url; objectUrls.set(el, url);
    });
    form.onsubmit = async e => {
      e.preventDefault(); const b = q("button[type=submit]", form); b.disabled = true;
      try {
        const body = Object.fromEntries(["character", "likes", "looking_for", "visibility"].map(key => [key, form.elements[key].value]));
        const cover = form.elements.cover.files[0];
        if (form.elements.removeCover.checked) body.coverBase64 = null;
        else if (cover) { if (cover.size > 8e6) throw new Error("Choisissez une couverture de moins de 8 Mo"); body.coverBase64 = await blobBase64(cover); body.coverType = cover.type; }
        if (form.elements.removeVoice.checked) body.voiceBase64 = null;
        else if (voice) { body.voiceBase64 = await blobBase64(voice); body.voiceType = voice.type.split(";")[0]; }
        await json("/profile", "PUT", body); q("[data-status]", form).textContent = "Profil enrichi enregistré.";
      } catch (error) { q("[data-status]", form).textContent = error.message; } finally { b.disabled = false; }
    };
  }
  const richButton = document.createElement("button"); richButton.type = "button"; richButton.className = "social-rich-button"; richButton.textContent = "＋ Couverture et présentation personnelle";
  q("#profileForm > h2")?.after(richButton);
  if (!richButton.isConnected) q("#profileForm").append(richButton);
  richButton.onclick = attempt(editProfile);
  const richPublic = document.createElement("section"); richPublic.className = "social-rich-profile";
  q("#publicProfileBio").after(richPublic);
  const album = createAlbum({ getContext, json, dialog, media, clearUrls, notify, after: richPublic });
  let profileRequest = 0;
  const profileObserver = new MutationObserver(() => {
    if (q("#publicProfileModal").classList.contains("hidden")) { profileRequest++; clearUrls(richPublic); richPublic.replaceChildren(); album.hidePublic(); }
  });
  profileObserver.observe(q("#publicProfileModal"), { attributes: true, attributeFilter: ["class"] });
  async function showRichProfile(id) {
    void album.showPublic(id);
    const request = ++profileRequest; clearUrls(richPublic); richPublic.replaceChildren();
    try {
      const p = await json(`/profile/${encodeURIComponent(id)}`); if (request !== profileRequest) return;
      if (p.restricted) return;
      richPublic.innerHTML = `${p.cover ? `<img class="social-profile-cover" alt="Couverture du profil" data-social-media="/api/social/profile/${encodeURIComponent(id)}/cover">` : ""}${p.voice ? `<p>Ma présentation vocale</p><audio controls data-social-media="/api/social/profile/${encodeURIComponent(id)}/voice"></audio>` : ""}<dl>${[["character", "Mon caractère"], ["likes", "Ce que j’aime"], ["looking_for", "Ce que je cherche"]].filter(([key]) => p[key]).map(([key, title]) => `<div><dt>${title}</dt><dd>${escape(p[key])}</dd></div>`).join("")}</dl>`;
      await media(richPublic);
    } catch { /* Existing public profile remains usable if extras are unavailable. */ }
  }
  q("[data-live]", toolbar).onclick = attempt(() => { const c = getContext(); if (c.private) throw new Error("Pour un appel à deux, utilisez le bouton Appeler. La visio collective est accessible depuis un salon ou un groupe."); return live.join(`room:${c.room}`, `Visio · ${c.roomTitle}`); });
  q("[data-groups]", toolbar).onclick = attempt(openGroups);
  q("[data-games]", toolbar).onclick = attempt(openGames);
  // Replace the old immediate-send recorder with a preview workflow.
  q("#voiceBtn").onclick = attempt(async () => {
    const c = getContext(); if (!c.uid || c.privateHome) throw new Error("Ouvrez une conversation pour enregistrer un vocal");
    const key = `${c.uid}|${c.private?.id || c.room}`;
    const blob = await recorder.open(); if (!blob) return;
    const now = getContext(); if (`${now.uid}|${now.private?.id || now.room}` !== key) throw new Error("La conversation a changé. Votre vocal n’a pas été envoyé.");
    await sendVoice({ mediaBase64: await blobBase64(blob), mediaType: blob.type.split(";")[0] });
  });
  for (const d of [groupDialog, gameDialog, profileDialog]) d.addEventListener("close", () => clearUrls(d));
  groupDialog.addEventListener('close', () => { groupOpenRevision++; activeGroup = null; });
  const onUpdate = () => { refresh().catch(() => {}); };
  function sync() {
    for (const el of groupDialog.querySelectorAll('[data-expires]')) {
      if (new Date(el.dataset.expires).getTime() <= Date.now()) { clearUrls(el); el.remove(); }
    }
    const c = getContext();
    if (c.uid !== owner) {
      generation++; groupOpenRevision++; owner = c.uid; activeGroup = null; groups = []; games = []; currentGame = null;
      live.leave(); recorder.cancel(); album.reset();
      for (const d of [groupDialog, gameDialog, profileDialog]) if (d.open) d.close();
      richPublic.replaceChildren(); clearUrls(document.body); profileRequest++;
      q(".social-content", gameDialog).replaceChildren();
    }
    toolbar.hidden = !owner;
    const context = `${c.room}|${c.private?.id || ""}|${c.privateHome}`;
    if (context !== currentContext) {
      currentContext = context; q("[data-live]", toolbar).hidden = Boolean(c.private || c.privateHome);
      if (live.scope?.startsWith("room:") && live.scope !== `room:${c.room}`) live.leave();
    }
    if (socket !== c.socket) {
      socket?.off("social-update", onUpdate); socket?.off("connect", onUpdate); socket = c.socket;
      socket?.on("social-update", onUpdate); socket?.on("connect", onUpdate); if (owner) onUpdate();
    }
  }
  const syncTimer = setInterval(sync, 500);
  const poll = setInterval(() => { if (owner && !document.hidden) onUpdate(); }, 15000);
  window.addEventListener("pagehide", () => { recorder.cancel(); live.leave(); });
  return { showRichProfile, live, dispose() { clearInterval(syncTimer); clearInterval(poll); profileObserver.disconnect(); live.leave(); recorder.cancel(); album.dispose(); } };
}
