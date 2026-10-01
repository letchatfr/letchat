import { installSpacesUI } from './spaces.js';
const q = (s, root = document) => root.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function installV3Tools({ api, getContext, notify, reload, report, closePanels }) {
  const json = async (path, method = 'GET', body) => (await api(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })).json();
  function dialog(title, name) {
    const d = document.createElement('dialog'); d.className = 'v3-dialog'; d.id = name;
    d.setAttribute('aria-labelledby', `${name}Title`);
    d.innerHTML = `<header><div><span class="v3-eyebrow">LETCHAT V3</span><h2 id="${name}Title">${title}</h2></div><button type="button" data-close aria-label="Fermer">×</button></header><div class="v3-dialog-body"></div>`;
    q('[data-close]', d).onclick = () => d.close(); document.body.append(d); return d;
  }
  const search = dialog('Rechercher dans la conversation', 'messageSearch'), edit = dialog('Modifier mon message', 'messageEdit'), prefs = dialog('Mes notifications', 'notificationPreferences');
  let searchContext, searchTicket = 0, next = null, editing = null, preferenceTicket = 0;
  const valid = ctx => ctx?.uid && ctx.uid === getContext().uid;
  function open(d) { closePanels(); if (!d.open) d.showModal(); }
  q('.v3-dialog-body', search).innerHTML = `<p data-context></p><form class="v3-search-form"><label>Mot ou expression<input type="search" name="q" minlength="2" maxlength="100" required placeholder="Au moins deux caractères…"></label><button type="submit" class="v3-primary">Rechercher</button></form><p class="v3-muted">Seuls les messages encore disponibles dans cette conversation sont recherchés. Ils expirent après 48 heures.</p><p class="v3-feedback" role="status"></p><div class="v3-results"></div><button type="button" data-more hidden>Résultats suivants</button>`;
  async function runSearch(more = false) {
    const ticket = ++searchTicket, ctx = searchContext;
    const term = q('input', search).value.trim();
    q('.v3-feedback', search).textContent = 'Recherche…'; q('[type=submit]', search).disabled = true;
    if (!more) { next = null; q('.v3-results', search).replaceChildren(); }
    try {
      const params = new URLSearchParams({ q: term, kind: ctx.private ? 'private' : 'public', scope: ctx.private?.id || ctx.room });
      if (more && next) params.set('before', next);
      const data = await json(`/api/message-search?${params}`);
      if (ticket !== searchTicket || !search.open || !valid(ctx)) return;
      next = data.next;
      q('.v3-results', search).innerHTML += data.items.map(m => `<article data-expires="${escape(m.expires_at)}"><div><strong>${escape(m.author)}</strong><time>${new Date(m.created_at).toLocaleString('fr-FR')}</time></div><p>${escape(m.body)}</p>${m.edited_at ? '<small>Modifié</small>' : ''}</article>`).join('');
      q('[data-more]', search).hidden = !next;
      q('.v3-feedback', search).textContent = q('.v3-results', search).children.length ? 'Résultats du plus récent au plus ancien.' : 'Aucun message ne correspond à votre recherche.';
    } catch (e) { if (ticket === searchTicket) q('.v3-feedback', search).textContent = e.message; }
    finally { if (ticket === searchTicket) q('[type=submit]', search).disabled = false; }
  }
  q('form', search).onsubmit = e => { e.preventDefault(); runSearch(); };
  q('[data-more]', search).onclick = () => runSearch(true);
  search.addEventListener('close', () => { searchTicket++; q('[type=submit]', search).disabled = false; q('.v3-results', search).replaceChildren(); });
  function showSearch() {
    const ctx = getContext(); if (!ctx.uid) return;
    if (ctx.privateHome) return notify('Ouvrez une conversation ou un salon pour y rechercher un message.');
    searchContext = { ...ctx }; q('[data-context]', search).textContent = ctx.private ? `Avec ${ctx.private.name}` : `Salon ${ctx.roomTitle}`;
    q('form', search).reset(); q('.v3-feedback', search).textContent = ''; q('[data-more]', search).hidden = true;
    open(search); q('input', search).focus();
  }
  q('.v3-dialog-body', edit).innerHTML = `<form><label>Votre message<textarea name="body" maxlength="4000" rows="5" required></textarea></label><p class="v3-muted">La mention « Modifié » sera visible. La date d’expiration reste inchangée.</p><p class="v3-feedback" role="alert"></p><button type="submit" class="v3-primary">Enregistrer</button></form>`;
  function editMessage(message) {
    editing = { ...message, uid: getContext().uid };
    q('textarea', edit).value = message.body; q('.v3-feedback', edit).textContent = '';
    open(edit); q('textarea', edit).focus();
  }
  q('form', edit).onsubmit = async e => {
    e.preventDefault(); const message = editing; if (!valid(message)) return edit.close();
    q('[type=submit]', edit).disabled = true;
    try {
      await json(`/api/messages/${message.private ? 'private' : 'public'}/${message.id}`, 'PATCH', { body: q('textarea', edit).value, previousBody: message.body });
      if (editing === message && valid(message)) { edit.close(); await reload(); }
    } catch (error) { if (editing === message) q('.v3-feedback', edit).textContent = error.message; }
    finally { q('[type=submit]', edit).disabled = false; }
  };
  edit.addEventListener('close', () => { editing = null; });
  async function showPreferences() {
    const ticket = ++preferenceTicket, ctx = getContext();
    q('.v3-dialog-body', prefs).innerHTML = '<p>Chargement…</p>'; open(prefs);
    try {
      const data = await json('/api/notification-preferences'); if (!prefs.open || ticket !== preferenceTicket || !valid(ctx)) return;
      q('.v3-dialog-body', prefs).innerHTML = `<p>Choisissez les notifications push envoyées à vos appareils. L’historique reste disponible dans le tchat.</p><form>
        <label class="v3-check"><input name="private_messages" type="checkbox" ${data.private_messages ? 'checked' : ''}> Messages privés</label>
        <label class="v3-check"><input name="friendships" type="checkbox" ${data.friendships ? 'checked' : ''}> Demandes et réponses d’amis</label>
        <label class="v3-check"><input name="preview" type="checkbox" ${data.preview ? 'checked' : ''}> Afficher un aperçu sur l’écran verrouillé</label>
        <label>Mettre en pause les notifications push<select name="quietHours"><option value="0">Recevoir les notifications</option><option value="1">Pendant 1 heure</option><option value="8">Pendant 8 heures</option><option value="24">Pendant 24 heures</option></select></label>
        <p class="v3-muted">${data.quiet_until && new Date(data.quiet_until) > new Date() ? `Pause actuelle jusqu’au ${new Date(data.quiet_until).toLocaleString('fr-FR')}. Enregistrer applique le nouveau choix.` : 'Ces réglages s’ajoutent aux conversations mises en sourdine et aux autorisations de votre navigateur.'}</p>
        <p class="v3-feedback" role="status"></p><button type="submit" class="v3-primary">Enregistrer mes choix</button></form>`;
      q('form', prefs).onsubmit = async e => {
        e.preventDefault(); if (!valid(ctx)) return prefs.close();
        const form = e.currentTarget, submit = q('[type=submit]', form); submit.disabled = true;
        try {
          await json('/api/notification-preferences', 'PATCH', { private_messages: form.elements.private_messages.checked, friendships: form.elements.friendships.checked, preview: form.elements.preview.checked, quietHours: Number(form.elements.quietHours.value) });
          q('.v3-feedback', prefs).textContent = 'Vos préférences sont enregistrées.';
        } catch (error) { q('.v3-feedback', prefs).textContent = error.message; } finally { submit.disabled = false; }
      };
    } catch (e) { if (ticket === preferenceTicket) q('.v3-dialog-body', prefs).textContent = e.message; }
  }
  const spaces = installSpacesUI({ api, getContext, notify, report, dialog, closePanels });
  const toolbar = document.createElement('nav'); toolbar.className = 'v3-tools'; toolbar.setAttribute('aria-label', 'Outils de discussion');
  toolbar.innerHTML = '<button type="button" data-spaces>Communautés</button><button type="button" data-search>Rechercher un message</button><button type="button" data-preferences>Notifications</button>';
  q('.social-toolbar').after(toolbar);
  q('[data-spaces]', toolbar).onclick = spaces.show; q('[data-search]', toolbar).onclick = showSearch; q('[data-preferences]', toolbar).onclick = showPreferences;
  q('#spacesLink')?.addEventListener('click', e => { e.preventDefault(); spaces.show(); });
  const homeButton = q('#communityHome [data-spaces]'); if (homeButton) homeButton.onclick = () => { q('#communityHome').close(); spaces.show(); };
  const lastEvent = new Map();
  function record(event) {
    if (!getContext().uid || Date.now() - (lastEvent.get(event) || 0) < 30000) return;
    lastEvent.set(event, Date.now());
    api('/api/diagnostics/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }) }).catch(() => {});
  }
  window.addEventListener('error', () => record('client_error'));
  window.addEventListener('unhandledrejection', () => record('client_error'));
  setInterval(() => {
    for (const element of search.querySelectorAll('[data-expires]')) if (new Date(element.dataset.expires).getTime() <= Date.now()) element.remove();
    if (!getContext().uid) for (const d of [search, edit, prefs]) if (d.open) d.close();
  }, 1000);
  return { editMessage, record, bind(socket) { spaces.bind(socket); socket.on('disconnect', () => record('socket_disconnected')); } };
}
