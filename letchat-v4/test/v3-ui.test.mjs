import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const waitFor = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.ok(predicate(), 'expected UI state'); };
async function setup(t, responder) {
  const dom = new JSDOM('<!doctype html><html lang="fr"><body><div class="social-toolbar"></div><a id="spacesLink"></a><a id="surpriseLink"></a><dialog id="communityHome"><button data-spaces></button></dialog></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, requests = [], notices = [], intervals = new Map(); let reloads = 0;
  const schedule = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => { intervals.set(ms, fn); return schedule(fn, ms); };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  for (const [file, name] of [['spaces.js', 'installSpacesUI'], ['v3-tools.js', 'installV3Tools']]) {
    const source = (await readFile(`public/${file}`, 'utf8')).replace(/^import.*;$/gm, '').replace(/^export /gm, '');
    w.eval(`{${source}\nwindow.${name}=${name};}`);
  }
  const ctx = { uid: 'self', room: 'cafe', roomTitle: 'Le Café', private: null };
  const api = async (path, options = {}) => { const req = { path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null }; requests.push(req); return { json: async () => responder(req) }; };
  const tools = w.installV3Tools({ api, getContext: () => ctx, notify: s => notices.push(s), reload: async () => reloads++, report() {}, closePanels() {} });
  const q = selector => w.document.querySelector(selector);
  const submit = selector => q(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { w, q, ctx, tools, requests, notices, submit, intervals, reloads: () => reloads };
}

test('community refresh keeps the draft during a transient failure, then recovers; revoked access hides it', async t => {
  const community = { id: 'stable-space', name: 'Une communauté', theme: 'general', description: 'Une discussion de test', rules: 'Respectez les autres.', rules_version: 1, owner_id: 'self', member_count: 1, joined: true, accepted_version: 1, role: 'member', paused: false, archived: false };
  let failure;
  const f = await setup(t, req => {
    if (req.path.startsWith('/api/spaces?')) return { items: [community], next: null };
    if (failure) throw failure;
    if (req.path.endsWith('/messages')) return { items: [], next: null };
    return community;
  });
  f.q('#spacesLink').click(); await waitFor(() => f.q('[data-space]'));
  f.q('[data-space]').click(); await waitFor(() => f.q('.space-composer'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const composer = f.q('.space-composer textarea'); composer.value = 'Mon brouillon à conserver';
  failure = new TypeError('Failed to fetch');
  await f.intervals.get(15000)();
  assert.equal(f.q('.space-composer textarea')?.value, 'Mon brouillon à conserver');
  assert.match(f.q('.space-error').textContent, /connexion|actualis/i);
  failure = null; await f.intervals.get(15000)();
  assert.equal(f.q('.space-composer textarea').value, 'Mon brouillon à conserver');
  assert.equal(f.q('.space-error').textContent, '');
  failure = Object.assign(new Error('Accès refusé'), { status: 403 }); await f.intervals.get(15000)();
  assert.equal(f.q('.space-composer'), null);
  assert.match(f.q('.space-error').textContent, /Accès refusé/);
});

const stableCommunity = { id: 'stable-space', name: 'Une communauté', theme: 'general', description: 'Une discussion de test', rules: 'Respectez les autres.', rules_version: 1, owner_id: 'self', member_count: 1, joined: true, accepted_version: 1, role: 'member', paused: false, archived: false };
const spaceHistory = { items: [{ id: 1, user_id: 'self', author: 'Test', body: 'Message déjà reçu', created_at: '2026-10-02T08:00:00Z', expires_at: new Date(Date.now() + 3600000).toISOString() }], next: null };
async function openStableCommunity(f) {
  f.q('#spacesLink').click(); await waitFor(() => f.q('[data-space]'));
  f.q('[data-space]').click(); await waitFor(() => f.q('.space-message'));
}

test('community history survives an interrupted message refresh and identical recovery', async t => {
  let failure;
  const f = await setup(t, req => {
    if (req.path.startsWith('/api/spaces?')) return { items: [stableCommunity], next: null };
    if (req.path.endsWith('/messages')) { if (failure) throw failure; return spaceHistory; }
    return stableCommunity;
  });
  await openStableCommunity(f);
  f.q('.space-composer textarea').value = 'Brouillon à conserver';
  failure = new TypeError('Failed to fetch'); await f.intervals.get(15000)();
  assert.match(f.q('.space-messages').textContent, /Message déjà reçu/);
  assert.equal(f.q('.space-composer textarea').value, 'Brouillon à conserver');
  failure = null; await f.intervals.get(15000)();
  assert.match(f.q('.space-messages').textContent, /Message déjà reçu/);
  assert.equal(f.q('.space-error').textContent, '');
});

test('community send keeps text typed while the server confirms the preceding message', async t => {
  let confirm;
  const f = await setup(t, req => {
    if (req.path.startsWith('/api/spaces?')) return { items: [stableCommunity], next: null };
    if (req.method === 'POST') return new Promise(resolve => confirm = resolve);
    if (req.path.endsWith('/messages')) return spaceHistory;
    return stableCommunity;
  });
  await openStableCommunity(f);
  const input = f.q('.space-composer textarea'); input.value = 'Premier message';
  f.submit('.space-composer'); await waitFor(() => confirm);
  input.value = 'Début du message suivant';
  confirm({ id: 2 }); await waitFor(() => !f.q('.space-composer button').disabled);
  assert.equal(input.value, 'Début du message suivant');
  assert.equal(f.requests.find(req => req.method === 'POST').body.body, 'Premier message');
});

test('community send ignores repeated submits and clears only the confirmed text', async t => {
  let confirm;
  const f = await setup(t, req => {
    if (req.path.startsWith('/api/spaces?')) return { items: [stableCommunity], next: null };
    if (req.method === 'POST') return new Promise(resolve => confirm = resolve);
    if (req.path.endsWith('/messages')) return spaceHistory;
    return stableCommunity;
  });
  await openStableCommunity(f);
  f.q('.space-composer textarea').value = 'Un seul message';
  f.submit('.space-composer'); await waitFor(() => confirm);
  f.submit('.space-composer');
  assert.equal(f.requests.filter(req => req.method === 'POST').length, 1);
  confirm({ id: 2 }); await waitFor(() => !f.q('.space-composer button').disabled);
  assert.equal(f.q('.space-composer textarea').value, '');
});

test('message search uses the active conversation, escapes text and discards a late response after closing', async t => {
  let resolve;
  const f = await setup(t, req => req.path.includes('message-search') ? new Promise(r => resolve = r) : {});
  f.ctx.private = { id: 'other:id', name: 'Autre membre' };
  f.q('[data-search]').click(); assert.equal(f.q('#messageSearch').open, true);
  f.q('#messageSearch input').value = 'bonjour'; f.submit('#messageSearch form');
  await waitFor(() => resolve);
  assert.ok(f.requests[0].path.includes('kind=private') && f.requests[0].path.includes('scope=other%3Aid'));
  resolve({ items: [{ id: 1, author: '<script>bad</script>', body: '<img src=x onerror=bad()>', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 50000).toISOString() }], next: null });
  await waitFor(() => f.q('.v3-results article'));
  assert.equal(f.q('.v3-results img'), null); assert.match(f.q('.v3-results').textContent, /<img src=x/);
  f.submit('#messageSearch form'); await waitFor(() => f.requests.length === 2);
  f.q('#messageSearch').close(); resolve({ items: [{ body: 'Must not reappear' }], next: null });
  await new Promise(r => setTimeout(r, 10)); assert.equal(f.q('.v3-results').children.length, 0);
});

test('editing keeps the original text for conflict detection and does not submit after account change', async t => {
  const f = await setup(t, () => ({}));
  f.tools.editMessage({ id: '7', private: false, body: 'Original' });
  f.q('#messageEdit textarea').value = 'Corrigé'; f.submit('#messageEdit form');
  await waitFor(() => f.reloads() === 1);
  assert.equal(f.requests[0].path, '/api/messages/public/7'); assert.deepEqual(f.requests[0].body, { body: 'Corrigé', previousBody: 'Original' });
  assert.equal(f.q('#messageEdit').open, false);
  f.tools.editMessage({ id: '8', private: true, body: 'Privé' }); f.ctx.uid = 'another'; f.submit('#messageEdit form');
  assert.equal(f.requests.length, 1);
});

test('notification controls save push preferences and pause without disclosing previews', async t => {
  const f = await setup(t, () => ({ private_messages: true, friendships: true, preview: true, quiet_until: null }));
  f.q('[data-preferences]').click(); await waitFor(() => f.q('#notificationPreferences form'));
  f.q('[name=preview]').checked = false; f.q('[name=private_messages]').checked = false; f.q('[name=quietHours]').value = '8';
  f.submit('#notificationPreferences form');
  await waitFor(() => f.requests.length === 2);
  assert.deepEqual(f.requests[1].body, { private_messages: false, friendships: true, preview: false, quietHours: 8 });
  await waitFor(() => /enregistrées/.test(f.q('#notificationPreferences .v3-feedback').textContent));
});

const notificationDefaults = { private_messages: true, friendships: true, preview: true, quiet_until: null };
function fastPreferenceTimers(f, timeout = false) {
  const schedule = f.w.setTimeout.bind(f.w);
  f.w.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 500 || (timeout && ms === 12000) ? 1 : ms, ...args);
}

test('notification loading recovers automatically after a transient fetch failure', async t => {
  let attempts = 0;
  const f = await setup(t, () => { if (++attempts === 1) throw new TypeError('Failed to fetch'); return notificationDefaults; });
  fastPreferenceTimers(f);
  f.q('[data-preferences]').click();
  await waitFor(() => f.q('#notificationPreferences form'));
  assert.equal(attempts, 2);
  assert.doesNotMatch(f.q('#notificationPreferences').textContent, /Failed to fetch/);
});

test('persistent notification network failure offers a working manual retry', async t => {
  let disconnected = true;
  const f = await setup(t, () => { if (disconnected) throw new TypeError('Failed to fetch'); return notificationDefaults; });
  fastPreferenceTimers(f);
  f.q('[data-preferences]').click();
  await waitFor(() => f.q('[data-retry-preferences]'));
  assert.equal(f.requests.length, 2);
  assert.match(f.q('#notificationPreferences [role=alert]').textContent, /Impossible de joindre Letchat/);
  disconnected = false; f.q('[data-retry-preferences]').click();
  await waitFor(() => f.q('#notificationPreferences form'));
  assert.equal(f.requests.length, 3);
});

test('notification settings resume when the browser comes online and never retry HTTP refusals automatically', async t => {
  let allowed = false;
  const f = await setup(t, () => { if (!allowed) throw new Error('Connexion requise'); return notificationDefaults; });
  f.q('[data-preferences]').click();
  await waitFor(() => f.q('[data-retry-preferences]'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.q('#notificationPreferences [role=alert]').textContent, 'Connexion requise');
  allowed = true; f.w.dispatchEvent(new f.w.Event('online'));
  await waitFor(() => f.q('#notificationPreferences form'));
  assert.equal(f.requests.length, 2);
});

test('a stalled notification request times out without leaving a permanent loading screen', async t => {
  const f = await setup(t, () => new Promise(() => {}));
  fastPreferenceTimers(f, true);
  f.q('[data-preferences]').click();
  await waitFor(() => f.q('[data-retry-preferences]'));
  assert.equal(f.requests.length, 2);
  assert.match(f.q('#notificationPreferences [role=alert]').textContent, /Impossible de joindre/);
});

test('closing notification settings cancels recovery and discards late responses', async t => {
  let reject;
  const f = await setup(t, () => new Promise((_, r) => reject = r));
  fastPreferenceTimers(f);
  f.q('[data-preferences]').click(); await waitFor(() => reject);
  f.q('#notificationPreferences').close(); reject(new TypeError('Failed to fetch'));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.requests.length, 1);
  assert.equal(f.q('#notificationPreferences').open, false);
  assert.equal(f.q('[data-retry-preferences]'), null);
});

test('failed preference saves retain the choices and are never replayed automatically', async t => {
  const f = await setup(t, req => { if (req.method === 'PATCH') throw new TypeError('Failed to fetch'); return notificationDefaults; });
  fastPreferenceTimers(f);
  f.q('[data-preferences]').click(); await waitFor(() => f.q('#notificationPreferences form'));
  f.q('[name=private_messages]').checked = false; f.q('[name=quietHours]').value = '8';
  f.submit('#notificationPreferences form');
  await waitFor(() => /Enregistrement non confirmé/.test(f.q('#notificationPreferences .v3-feedback').textContent));
  assert.equal(f.requests.filter(req => req.method === 'PATCH').length, 1);
  assert.equal(f.q('[name=private_messages]').checked, false);
  assert.equal(f.q('[name=quietHours]').value, '8');
  assert.equal(f.q('#notificationPreferences [type=submit]').disabled, false);
});

test('community creation, rules, composer and pause are reachable from the new navigation', async t => {
  let community = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Les mélomanes', theme: 'musique', description: 'Nos découvertes musicales', rules: 'Respectez les autres membres.', rules_version: 1, owner_id: 'self', owner_name: 'Moi', member_count: 1, joined: true, accepted_version: 1, role: 'member', paused: false, archived: false };
  const f = await setup(t, req => {
    if (req.path.startsWith('/api/spaces?')) return { items: [], next: null };
    if (req.path === '/api/spaces' && req.method === 'POST') { community = { ...community, ...req.body }; return community; }
    if (req.path.endsWith('/messages') && req.method === 'GET') return { items: [], next: null };
    if (req.path.endsWith('/messages') && req.method === 'POST') return { id: '10' };
    return community;
  });
  f.q('[data-spaces].nonexistent')?.click(); f.q('.v3-tools [data-spaces]').click(); await waitFor(() => f.q('[data-create]'));
  f.q('[data-create]').click(); assert.equal(f.q('#spaceSettings').open, true);
  f.q('#spaceSettings [name=name]').value = 'Les mélomanes'; f.q('#spaceSettings [name=theme]').value = 'musique'; f.q('#spaceSettings [name=description]').value = 'Nos découvertes musicales';
  f.submit('#spaceSettings form'); await waitFor(() => f.q('.space-composer'));
  assert.equal(f.q('#spacesDialog h2').textContent, 'Les mélomanes'); assert.ok(f.q('.space-rules summary').textContent.includes('version 1'));
  f.q('.space-composer textarea').value = 'Une découverte à partager'; f.submit('.space-composer');
  await waitFor(() => f.requests.some(r => r.method === 'POST' && r.path.endsWith('/messages')));
  assert.equal(f.requests.find(r => r.method === 'POST' && r.path.endsWith('/messages')).body.body, 'Une découverte à partager');
  f.q('[data-settings]').click(); await waitFor(() => f.q('#spaceSettings [name=archived]'));
  assert.ok(f.q('#spaceSettings [name=archived]'));
  f.q('#spacesDialog').close(); assert.equal(f.q('#spaceSettings').open, false);
});

test('Surprise video is opt-in and matching never starts a camera or sends a suggested message', async t => {
  const f = await setup(t, () => ({})); let invited = 0, prepared = '', opened = 0; const events = new Map(), commands = [];
  const source = (await readFile('public/interests.js', 'utf8')).replace(/^export /gm, '') + '\n' + (await readFile('public/surprise.js', 'utf8')).replace(/^import.*;$/gm, '').replace(/^export /gm, '');
  f.w.eval(`{${source}\nwindow.installSurpriseUI=installSurpriseUI;}`);
  const surprise = f.w.installSurpriseUI({ openPrivate: () => opened++, startCall: () => invited++, preparePrompt: text => prepared = text, openHome() {}, openRooms() {}, report() {}, block() {}, closePanels() {}, notify() {} });
  let revision = 0;
  const socket = { connected: true, on: (name, fn) => events.set(name, fn), timeout() { return this; }, emit(name, payload, ack) { commands.push({ name, payload }); ack(null, { ok: true, state: { revision: ++revision, status: 'waiting', mode: payload.mode, waitingCount: 1, interests: [], joinedAt: Date.now() } }); } };
  surprise.bind(socket); f.q('#surpriseLink').click();
  const radio = f.q('[name=surpriseMode][value=video]'); radio.checked = true; radio.dispatchEvent(new f.w.Event('change'));
  f.q('.surprise-dialog [data-start]').click(); await waitFor(() => commands.length);
  assert.equal(commands[0].payload.mode, 'video'); assert.equal(invited, 0);
  events.get('surprise-state')({ revision: ++revision, status: 'matched', mode: 'video', matchId: 'one', partner: { id: 'other', name: 'Un membre', socketId: 'socket-other' }, sharedInterests: ['musique'] });
  assert.equal(opened, 1); assert.equal(invited, 0);
  f.q('[data-prompt]').click(); assert.match(prepared, /morceau|concert/); assert.equal(commands.length, 1);
  f.q('[data-call]').click(); assert.equal(invited, 1);
});

test('community administration keeps cursor pagination and stops on the last page', async t => {
  const f = await setup(t, () => ({})), paths = [];
  f.w.document.body.insertAdjacentHTML('beforeend', '<button id="adminBtn">Administration</button>');
  const source = (await readFile('public/admin.js', 'utf8')).replace(/^export /gm, '');
  f.w.eval(`{${source}\nwindow.installAdminUI=installAdminUI;}`);
  f.w.installAdminUI({ getUser: () => ({ id: 'self', admin: true }), api: async path => {
    paths.push(path);
    return { json: async () => path.includes('/spaces?') ? { items: [{ id: 'one', name: '<Communauté>', theme: 'general' }], next: path.includes('page=1') ? 2 : null } : {} };
  }});
  f.q('#adminBtn').click();
  f.q('[data-tab=spaces]').click();
  await waitFor(() => f.q('.adm-footer [data-do=next]'));
  assert.equal(f.q('.adm-footer').textContent.includes('NaN'), false);
  assert.equal(f.q('.adm-footer [data-do=prev]').disabled, true);
  assert.equal(f.q('.adm-footer [data-do=next]').disabled, false);
  f.q('.adm-footer [data-do=next]').click();
  await waitFor(() => f.q('.adm-footer [data-do=next]')?.disabled);
  assert.ok(paths.includes('/api/admin/spaces?page=2'));
  assert.equal(f.q('.adm-footer [data-do=prev]').disabled, false);
  assert.match(f.q('.adm-content').textContent, /<Communauté>/);
});
