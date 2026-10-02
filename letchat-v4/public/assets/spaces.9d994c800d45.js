const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const themes = { general: 'Discussions', musique: 'Musique', cinema: 'Cinéma & séries', gaming: 'Jeux vidéo', regions: 'Régions', rencontres: 'Rencontres' };
const q = (selector, root) => root.querySelector(selector);
export function installSpacesUI({ api, getContext, notify, report, dialog, closePanels }) {
  const root = dialog('Les communautés', 'spacesDialog'), sub = dialog('Créer une communauté', 'spaceSettings');
  root.classList.add('v3-spaces');
  const body = q('.v3-dialog-body', root), subBody = q('.v3-dialog-body', sub);
  const json = async (path, method = 'GET', data) => (await api(path, { method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) })).json();
  let active = null, ticket = 0, owner = '', page = 1, nextPage = null, filter = {}, cursor = null, nextMessages = null, refreshing = false, pending = false, socket;
  const valid = revision => revision === ticket && root.open && owner === getContext().uid;
  const manager = s => s.owner_id === getContext().uid || (s.role === 'moderator' && s.joined);
  const action = fn => async (...args) => { try { await fn(...args); } catch (error) { notify(error.message); const el = q('.space-error', root); if (el) el.textContent = error.message; } };
  function show() {
    if (!getContext().uid) return;
    closePanels(); owner = getContext().uid;
    if (!root.open) root.showModal();
    browse();
  }
  function browse() {
    active = null; cursor = null; ticket++;
    q('h2', root).textContent = 'Les communautés';
    body.innerHTML = `<div class="space-intro"><p>Un sujet en commun, une conversation à retrouver. Rejoignez un espace ou créez le vôtre.</p><button type="button" data-create class="v3-primary">Créer une communauté</button></div>
      <form class="space-filters"><label>Rechercher<input type="search" name="q" maxlength="80" placeholder="Nom ou sujet…"></label><label>Thème<select name="theme"><option value="">Tous les thèmes</option>${Object.entries(themes).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label><label class="v3-check"><input name="mine" type="checkbox"> Mes communautés</label><button type="submit">Filtrer</button></form><p class="space-error" role="status"></p><div class="space-grid"></div><div class="space-pagination"><button type="button" data-prev>Précédent</button><span></span><button type="button" data-next>Suivant</button></div>`;
    q('input[name=q]', body).value = filter.q || ''; q('select', body).value = filter.theme || ''; q('[name=mine]', body).checked = filter.mine === 'true';
    q('form', body).onsubmit = e => { e.preventDefault(); filter = Object.fromEntries(new FormData(e.currentTarget)); filter.mine = e.currentTarget.elements.mine.checked ? 'true' : 'false'; page = 1; list(); };
    q('[data-create]', body).onclick = () => settings();
    q('[data-prev]', body).onclick = () => { if (page > 1) { page--; list(); } };
    q('[data-next]', body).onclick = () => { if (nextPage) { page = nextPage; list(); } };
    list();
  }
  async function list() {
    const revision = ++ticket; q('.space-error', body).textContent = 'Chargement…';
    try {
      const data = await json(`/api/spaces?${new URLSearchParams({ ...filter, page })}`); if (!valid(revision) || active) return;
      nextPage = data.next; q('.space-error', body).textContent = '';
      q('.space-grid', body).innerHTML = data.items.length ? data.items.map(s => `<button type="button" class="space-card" data-space="${s.id}"><span class="space-theme">${themes[s.theme] || 'Discussion'}</span><h3>${escape(s.name)}</h3><p>${escape(s.description)}</p><span>${s.member_count} membre${s.member_count > 1 ? 's' : ''} · ${s.joined ? 'Rejoint' : 'Découvrir'}${s.paused || s.archived ? ' · En pause' : ''}</span></button>`).join('') : '<div class="v3-empty"><h3>Une place pour vos sujets</h3><p>Aucune communauté ne correspond à ces critères. Essayez un autre thème ou créez un espace pour lancer la discussion.</p></div>';
      q('[data-prev]', body).disabled = page <= 1; q('[data-next]', body).disabled = !nextPage; q('.space-pagination span', body).textContent = `Page ${page}`;
      body.querySelectorAll('[data-space]').forEach(b => b.onclick = () => openSpace(b.dataset.space));
    } catch (e) { if (valid(revision)) q('.space-error', body).textContent = e.message; }
  }
  async function openSpace(id) {
    const revision = ++ticket; active = id; cursor = null; body.innerHTML = '<p class="space-error" role="status">Chargement de la communauté…</p>';
    try {
      const s = await json(`/api/spaces/${id}`); if (!valid(revision) || active !== id) return;
      renderSpace(s); await messages();
    } catch (e) { if (valid(revision)) { body.innerHTML = '<button type="button" data-back>← Les communautés</button><p class="space-error" role="alert"></p>'; q('.space-error', body).textContent = e.message; q('[data-back]', body).onclick = browse; } }
  }
  function renderSpace(s) {
    q('h2', root).textContent = s.name;
    body.innerHTML = `<div class="space-actions"><button type="button" data-back>← Les communautés</button>${manager(s) ? '<button type="button" data-members>Membres & modération</button>' : ''}${s.owner_id === getContext().uid ? '<button type="button" data-settings>Gérer ma communauté</button>' : s.joined ? '<button type="button" data-leave>Quitter</button>' : ''}</div>
      <div class="space-summary"><span class="space-theme">${themes[s.theme]}</span><p>${escape(s.description)}</p><small>${s.member_count} membre(s) · Responsable : ${escape(s.owner_name)}</small></div>
      <details class="space-rules" ${!s.joined || s.accepted_version !== s.rules_version ? 'open' : ''}><summary>Règles de cette communauté · version ${s.rules_version}</summary><p>${escape(s.rules)}</p></details>
      ${s.paused || s.archived || !s.owner_id ? '<p class="space-notice">Cette communauté est en pause. Les messages encore disponibles restent consultables pour ses membres.</p>' : (!s.joined || s.accepted_version !== s.rules_version) ? '<form class="space-join"><label class="v3-check"><input type="checkbox" required> J’ai lu les règles et je m’engage à les respecter.</label><button type="submit" class="v3-primary">Rejoindre la discussion</button></form>' : ''}
      <p class="space-error" role="status"></p><div class="space-messages" aria-label="Messages de la communauté"></div>
      <div class="space-message-pages" ${s.joined ? '' : 'hidden'}><button type="button" data-older hidden>Messages précédents</button><button type="button" data-latest hidden>Revenir aux plus récents</button></div>
      ${s.joined && s.accepted_version === s.rules_version && !s.paused && !s.archived && s.owner_id ? '<form class="space-composer"><label>Votre message<textarea name="body" rows="2" maxlength="4000" required placeholder="Partagez votre idée…"></textarea></label><button type="submit" class="v3-primary">Envoyer</button><small>Les messages expirent après 48 heures.</small></form>' : ''}`;
    body.dataset.rulesVersion = s.rules_version; body.dataset.joined = s.joined; body.dataset.manage = manager(s); body.dataset.paused = s.paused || s.archived || !s.owner_id;
    q('[data-back]', body).onclick = browse;
    if (q('[data-settings]', body)) q('[data-settings]', body).onclick = () => settings(s);
    if (q('[data-members]', body)) q('[data-members]', body).onclick = () => members(s);
    if (q('[data-leave]', body)) q('[data-leave]', body).onclick = action(async () => { await json(`/api/spaces/${s.id}/membership`, 'DELETE'); browse(); });
    if (q('.space-join', body)) q('.space-join', body).onsubmit = action(async e => { e.preventDefault(); await json(`/api/spaces/${s.id}/join`, 'POST', { rulesVersion: s.rules_version }); await openSpace(s.id); });
    q('[data-older]', body).onclick = () => { cursor = nextMessages; messages(); };
    q('[data-latest]', body).onclick = () => { cursor = null; messages(); };
    const composer = q('.space-composer', body);
    if (composer) composer.onsubmit = action(async e => {
      e.preventDefault(); const button = q('[type=submit]', composer);
      if (button.disabled) return;
      const revision = ticket, input = composer.elements.body, text = input.value;
      button.disabled = true;
      try {
        await json(`/api/spaces/${s.id}/messages`, 'POST', { body: text });
        if (!valid(revision) || active !== s.id || !composer.isConnected) return;
        if (input.value === text) input.value = '';
        cursor = null; await messages();
        if (valid(revision) && composer.isConnected) input.focus();
      } catch (error) {
        if (valid(revision) && active === s.id && composer.isConnected) throw error;
      } finally { button.disabled = false; }
    });
  }
  async function messages() {
    if (!active || body.dataset.joined !== 'true' || !q('.space-messages', body)) return;
    const revision = ticket, spaceId = active, oldCursor = cursor;
    try {
      const data = await json(`/api/spaces/${spaceId}/messages${cursor ? `?before=${cursor}` : ''}`);
      if (!valid(revision) || active !== spaceId || cursor !== oldCursor) return;
      nextMessages = data.next; const list = q('.space-messages', body), fingerprint = JSON.stringify(data.items);
      if (list.dataset.fingerprint !== fingerprint) {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 80;
        list.innerHTML = data.items.length ? data.items.map(m => `<article class="space-message ${m.user_id === getContext().uid ? 'mine' : ''}" data-expires="${escape(m.expires_at)}"><div><strong>${escape(m.author)}</strong><time>${new Date(m.created_at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><p>${escape(m.body)}</p><div class="space-message-actions">${m.user_id !== getContext().uid ? `<button type="button" data-report="${m.id}">Signaler</button>` : ''}${m.user_id === getContext().uid || body.dataset.manage === 'true' ? `<button type="button" data-delete="${m.id}">Supprimer</button>` : ''}</div></article>`).join('') : '<p class="v3-empty">La discussion commence avec vous. Posez une question ou présentez-vous.</p>';
        list.dataset.fingerprint = fingerprint;
        if (atBottom && !cursor) list.scrollTop = list.scrollHeight;
        list.querySelectorAll('[data-report]').forEach(b => b.onclick = () => { const m = data.items.find(m => String(m.id) === b.dataset.report); root.close(); report({ id: m.user_id, name: m.author }, { id: m.id, kind: 'community' }); });
        list.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => removeMessage(spaceId, b.dataset.delete));
      }
      q('[data-older]', body).hidden = !nextMessages; q('[data-latest]', body).hidden = !cursor; q('.space-error', body).textContent = '';
    } catch (e) {
      if (valid(revision) && active === spaceId && cursor === oldCursor) refreshError(e);
    }
  }
  function refreshError(error) {
    if ([401, 403, 404, 410].includes(error.status)) {
      body.innerHTML = '<button type="button" data-back>← Les communautés</button><p class="space-error" role="alert"></p>';
      q('.space-error', body).textContent = error.message; q('[data-back]', body).onclick = browse;
    } else {
      q('.space-error', body).textContent = 'Actualisation interrompue. Vos messages et votre brouillon sont conservés ; la discussion sera actualisée au retour de la connexion.';
    }
  }
  function subForm(title, html, save, buttonLabel = 'Enregistrer') {
    q('h2', sub).textContent = title;
    subBody.innerHTML = `<form>${html}<p class="v3-feedback" role="alert"></p><button type="submit" class="v3-primary">${buttonLabel}</button></form>`;
    if (!sub.open) sub.showModal();
    const uid = getContext().uid;
    q('form', sub).onsubmit = async e => {
      e.preventDefault(); const form = e.currentTarget, button = q('[type=submit]', form); button.disabled = true;
      try { if (uid !== getContext().uid) return sub.close(); await save(form); sub.close(); }
      catch (error) { q('.v3-feedback', form).textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  function settings(s = null) {
    subForm(s ? 'Gérer ma communauté' : 'Créer une communauté', `<label>Nom<input name="name" minlength="3" maxlength="60" required value="${escape(s?.name || '')}"></label><label>Thème<select name="theme">${Object.entries(themes).map(([id, label]) => `<option value="${id}" ${s?.theme === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Présentation<textarea name="description" minlength="10" maxlength="300" rows="3" required>${escape(s?.description || '')}</textarea></label><label>Règles de participation<textarea name="rules" minlength="10" maxlength="1500" rows="5" required>${escape(s?.rules || 'Échangez dans le respect. Pas de harcèlement ni de publicité répétée. Respectez le thème de la communauté et les règles de Letchat.')}</textarea></label>${s ? `<label class="v3-check"><input name="archived" type="checkbox" ${s.archived ? 'checked' : ''}> Archiver la communauté (lecture seule)</label><p class="v3-muted">Une modification des règles demande aux membres de les relire avant leur prochain message.</p>` : '<p class="v3-muted">Vous devenez responsable de cet espace. Vous pourrez désigner des modérateurs et transmettre la responsabilité à un membre permanent.</p>'}`, async form => {
      const data = Object.fromEntries(new FormData(form)); if (s) Object.assign(data, { archived: form.elements.archived.checked, rulesVersion: s.rules_version });
      const saved = await json(s ? `/api/spaces/${s.id}` : '/api/spaces', s ? 'PATCH' : 'POST', data); await openSpace(saved.id);
    }, s ? 'Enregistrer' : 'Créer ma communauté');
  }
  async function members(s, page = 1) {
    q('h2', sub).textContent = 'Membres & modération'; subBody.innerHTML = '<p>Chargement…</p>'; if (!sub.open) sub.showModal();
    try {
      const data = await json(`/api/spaces/${s.id}/members?page=${page}`); if (!sub.open || owner !== getContext().uid) return;
      subBody.innerHTML = `<p>Les interventions sont enregistrées dans le journal de modération.</p>${data.items.map(m => `<article class="space-member"><strong>${escape(m.display_name)}</strong><span>${m.user_id === s.owner_id ? 'Responsable' : m.role === 'moderator' ? 'Modérateur' : 'Membre'}${m.banned ? ' · Exclu' : ''}</span>${m.user_id !== s.owner_id && m.user_id !== getContext().uid ? `<button type="button" data-member="${escape(m.user_id)}" data-name="${escape(m.display_name)}">Gérer</button>` : ''}</article>`).join('')}<div class="space-pagination"><button type="button" data-prev ${page <= 1 ? 'disabled' : ''}>Précédent</button><span>Page ${page}</span><button type="button" data-next ${data.next ? '' : 'disabled'}>Suivant</button></div>`;
      q('[data-prev]', subBody).onclick = () => members(s, page - 1); q('[data-next]', subBody).onclick = () => members(s, data.next);
      subBody.querySelectorAll('[data-member]').forEach(b => b.onclick = () => {
        subForm(`Gérer ${b.dataset.name}`, `<label>Action<select name="action"><option value="ban">Exclure de cette communauté</option><option value="unban">Lever l’exclusion</option>${s.owner_id === getContext().uid ? '<option value="moderator">Nommer modérateur</option><option value="member">Retirer le rôle de modérateur</option><option value="transfer">Transférer la responsabilité</option>' : ''}</select></label><label>Motif<textarea name="reason" minlength="3" maxlength="300" required></textarea></label><p class="v3-muted">Un transfert donne la gestion de cet espace au membre choisi.</p>`, async form => { await json(`/api/spaces/${s.id}/members/${encodeURIComponent(b.dataset.member)}`, 'PATCH', Object.fromEntries(new FormData(form))); await openSpace(s.id); });
      });
    } catch (e) { subBody.textContent = e.message; }
  }
  function removeMessage(spaceId, id) {
    subForm('Supprimer ce message', '<p>Le message sera définitivement retiré de la communauté.</p><label>Motif<textarea name="reason" minlength="3" maxlength="300" required></textarea></label>', async form => { await json(`/api/spaces/${spaceId}/messages/${id}`, 'DELETE', { reason: form.elements.reason.value }); await messages(); }, 'Supprimer');
  }
  async function refresh() {
    if (!root.open || !active || owner !== getContext().uid || document.hidden) return;
    if (refreshing) { pending = true; return; }
    refreshing = true; const revision = ticket, spaceId = active;
    try {
      const s = await json(`/api/spaces/${spaceId}`); if (!valid(revision) || spaceId !== active) return;
      const changed = String(s.rules_version) !== body.dataset.rulesVersion || String(s.joined) !== body.dataset.joined || String(s.paused || s.archived || !s.owner_id) !== body.dataset.paused || String(manager(s)) !== body.dataset.manage;
      if (changed) { const draft = q('.space-composer textarea', body)?.value || ''; renderSpace(s); if (q('.space-composer textarea', body)) q('.space-composer textarea', body).value = draft; }
      await messages();
    } catch (e) {
      if (!valid(revision)) return;
      refreshError(e);
    }
    finally { refreshing = false; if (pending) { pending = false; refresh(); } }
  }
  root.addEventListener('close', () => { ticket++; active = null; body.replaceChildren(); if (sub.open) sub.close(); });
  setInterval(refresh, 15000);
  setInterval(() => {
    if (owner !== getContext().uid && root.open) root.close();
    for (const el of root.querySelectorAll('[data-expires]')) if (new Date(el.dataset.expires).getTime() <= Date.now()) el.remove();
  }, 1000);
  let debounce;
  return { show, bind(nextSocket) { socket = nextSocket; nextSocket.on('space-update', ({ id }) => { if (socket !== nextSocket || id !== active) return; clearTimeout(debounce); debounce = setTimeout(refresh, 100); }); nextSocket.on('connect', refresh); } };
}
