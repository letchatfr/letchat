import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(predicate(), 'expected UI state');
};
async function setup(t) {
  const dom = new JSDOM('<div class="chat"><header></header></div><form id="profileForm"></form><div id="publicProfileModal" class="hidden"><div id="publicProfileBio"></div></div><button id="voiceBtn"></button>', { url: 'http://localhost', runScripts: 'outside-only' });
  const w = dom.window, intervals = new Map(), requests = [], notices = [];
  t.after(() => w.close());
  w.setInterval = (fn, ms) => { intervals.set(ms, fn); return ms; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.show = w.HTMLDialogElement.prototype.showModal;
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.createVoiceRecorder = () => ({ cancel() {} });
  w.createLiveView = () => ({ leave() {} });
  w.createAlbum = () => ({ reset() {}, dispose() {}, hidePublic() {} });
  const groups = ['a', 'b'].map(id => ({ id, name: `Groupe ${id}`, status: 'accepted', members: 2 }));
  const rows = id => [{ id: 1, sender_id: 'other', sender_name: 'Autre membre', body: `Message ${id}`, created_at: '2026-10-02T08:00:00Z', expires_at: new Date(Date.now() + 3600000).toISOString() }];
  let messages = id => rows(id);
  const api = async (path, options = {}) => {
    requests.push({ path, method: options.method || 'GET' });
    let data;
    if (path === '/api/social/groups') data = groups;
    else if (path === '/api/social/games') data = [];
    else if (path.endsWith('/messages')) data = await messages(path.split('/')[4]);
    else { const id = path.split('/')[4]; data = { id, name: `Groupe ${id}`, owner_id: 'self', members: [{ status: 'accepted', display_name: 'Test' }] }; }
    return { json: async () => data };
  };
  const source = (await readFile('public/social.js', 'utf8')).replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  w.eval(source + '\nwindow.installSocial = installSocial;');
  const context = { uid: 'self', room: 'cafe', contacts: [] };
  w.installSocial({ getContext: () => context, api, notify: text => notices.push(text) });
  intervals.get(500)();
  const q = selector => w.document.querySelector(selector);
  await q('[data-groups]').onclick();
  await q('[data-group="a"]').onclick();
  return { w, q, requests, notices, context, respond: fn => messages = fn, rows, sync: intervals.get(500),
    refresh: () => q('[data-games]').onclick(),
    open: id => q(`[data-group="${id}"]`).onclick() };
}

test('group refresh preserves messages and draft on a network failure, then recovers', async t => {
  const f = await setup(t);
  f.q('[data-group-form] textarea').value = 'Mon brouillon';
  f.respond(() => { throw new TypeError('Failed to fetch'); });
  await f.refresh();
  assert.equal(f.q('[data-group-form] textarea')?.value, 'Mon brouillon');
  assert.match(f.q('[data-group-messages]').textContent, /Message a/);
  assert.match(f.q('[data-group-status]').textContent, /connexion|actualis/i);
  f.respond(f.rows); await f.refresh();
  assert.equal(f.q('[data-group-form] textarea').value, 'Mon brouillon');
  assert.match(f.q('[data-group-messages]').textContent, /Message a/);
  assert.equal(f.q('[data-group-status]').textContent, '');
});

test('a late group failure cannot erase the newly selected conversation', async t => {
  const f = await setup(t); let reject;
  f.respond(id => id === 'a' ? new Promise((_, fail) => reject = fail) : f.rows(id));
  const pending = f.refresh(); await waitFor(() => reject);
  await f.open('b');
  f.q('[data-group-form] textarea').value = 'Brouillon du groupe b';
  reject(Object.assign(new Error('Ancien groupe indisponible'), { status: 403 }));
  await pending;
  assert.equal(f.q('[data-group-form] textarea')?.value, 'Brouillon du groupe b');
  assert.match(f.q('[data-group-messages]').textContent, /Message b/);
});

test('a confirmed loss of group access still removes the conversation', async t => {
  const f = await setup(t);
  f.respond(() => { throw Object.assign(new Error('Accès au groupe refusé'), { status: 403 }); });
  await f.refresh();
  assert.equal(f.q('[data-group-form]'), null);
  assert.equal(f.q('[data-group-messages]'), null);
  assert.match(f.q('[data-group-detail]').textContent, /Accès au groupe refusé/);
});

test('group messages still expire locally during a network interruption', async t => {
  const f = await setup(t);
  f.q('[data-group-form] textarea').value = 'Mon brouillon';
  f.respond(() => { throw new TypeError('Failed to fetch'); });
  await f.refresh();
  f.q('.social-bubble').dataset.expires = new Date(Date.now() - 1000).toISOString();
  f.sync();
  assert.equal(f.q('.social-bubble'), null);
  assert.equal(f.q('[data-group-form] textarea').value, 'Mon brouillon');
});
