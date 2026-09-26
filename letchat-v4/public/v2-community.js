/* Preferences stay on this device. Room links are handled by the chat client. */
(() => {
  const search = document.getElementById('roomSearch');
  if (!search) return;
  const filter = document.getElementById('favoriteRoomsOnly');
  const groups = [...document.querySelectorAll('.v2-room-group')];
  const rows = [...document.querySelectorAll('[data-room-row]')];
  const key = 'letchat.v2.favoriteRooms';
  let saved = [];
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(value)) saved = value; } catch {}
  const favorites = new Set(saved.filter(id => rows.some(row => row.dataset.roomRow === id)));
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  let wasFiltering = false;
  const openGroups = new Map();
  function render() {
    const query = normalize(search.value);
    const onlyFavorites = filter.getAttribute('aria-pressed') === 'true';
    const filtering = Boolean(query || onlyFavorites);
    if (filtering && !wasFiltering) groups.forEach(group => openGroups.set(group, group.open));
    let visible = 0;
    rows.forEach(row => {
      const id = row.dataset.roomRow;
      const name = row.querySelector('.v2-room-name').textContent;
      const button = row.querySelector('[data-favorite]');
      const favorite = favorites.has(id);
      button.textContent = favorite ? '★' : '☆';
      button.setAttribute('aria-pressed', String(favorite));
      button.setAttribute('aria-label', `${favorite ? 'Retirer' : 'Ajouter'} ${name} ${favorite ? 'des' : 'aux'} favoris`);
      button.title = button.getAttribute('aria-label');
      row.hidden = !(normalize(name).includes(query) && (!onlyFavorites || favorite));
      if (!row.hidden) visible++;
    });
    groups.forEach(group => {
      group.hidden = ![...group.querySelectorAll('[data-room-row]')].some(row => !row.hidden);
      if (filtering) group.open = true;
      else if (wasFiltering) group.open = openGroups.get(group) ?? true;
    });
    document.getElementById('roomSearchEmpty').classList.toggle('hidden', visible > 0);
    wasFiltering = filtering;
  }
  search.addEventListener('input', render);
  filter.addEventListener('click', () => {
    filter.setAttribute('aria-pressed', String(filter.getAttribute('aria-pressed') !== 'true'));
    render();
  });
  rows.forEach(row => row.querySelector('[data-favorite]').addEventListener('click', () => {
    const id = row.dataset.roomRow;
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    try { localStorage.setItem(key, JSON.stringify([...favorites])); } catch {}
    render();
  }));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (document.activeElement === search && search.value) { search.value = ''; render(); return; }
    const side = document.querySelector('.side');
    if (side.classList.contains('open')) { side.classList.remove('open'); document.getElementById('roomsBtn').focus(); }
  });
  render();
})();
