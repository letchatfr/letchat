/* Améliorations de présentation sans API ni persistance de données privées. */
(() => {
  const $ = selector => document.querySelector(selector);
  const input = $('#input'), messages = $('#messages');
  if (!input || !messages) return;
  const labels = {
    attach: 'Joindre une photo, une vidéo ou un audio', cameraBtn: 'Prendre une photo',
    voiceBtn: 'Enregistrer un message vocal', emoji: 'Choisir un emoji', send: 'Envoyer le message',
    closePeople: 'Fermer les contacts', closeProfile: 'Fermer mon profil',
    searchBtn: 'Rechercher un message ou un membre', notificationsBtn: 'Ouvrir les notifications',
    mobileProfileBtn: 'Modifier mon profil', profileBtn: 'Modifier mon profil',
  };
  for (const [id, label] of Object.entries(labels)) {
    const button = document.getElementById(id);
    if (button) { button.setAttribute('aria-label', label); button.title = label; }
  }
  // Les champs restent identifiables lorsque le texte indicatif disparaît.
  document.querySelectorAll('.local-auth-form input, .local-auth-form select').forEach(field => {
    if (!field.getAttribute('aria-label')) field.setAttribute('aria-label', field.placeholder || (field.tagName === 'SELECT' ? 'Genre du profil' : field.name || 'Champ'));
  });
  function sizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(132, Math.max(38, input.scrollHeight))}px`;
    $('#messageCount').textContent = `${input.value.length.toLocaleString('fr-FR')} / 4 000`;
  }
  input.addEventListener('input', sizeInput);
  sizeInput();
  const jump = $('#jumpLatest');
  jump.addEventListener('click', () => { messages.scrollTop = messages.scrollHeight; jump.classList.add('hidden'); });
  messages.addEventListener('scroll', () => {
    if (messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100) jump.classList.add('hidden');
  }, { passive: true });

  const picker = $('#emojiPicker'), emojiButton = $('#emoji');
  const emoji = [['😊','Sourire'],['😂','Rire'],['❤️','Cœur'],['👍','Pouce levé'],['👋','Bonjour'],['🎉','Fête'],['😍','Adoration'],['😮','Surprise'],['🙏','Merci'],['☕','Café'],['😎','Cool'],['✨','Étincelles'],['💬','Discussion'],['🔥','Feu'],['🤔','Réflexion'],['💪','Courage']];
  let selection = [0, 0];
  const rememberSelection = () => { selection = [input.selectionStart, input.selectionEnd]; };
  ['keyup', 'click', 'select', 'blur'].forEach(name => input.addEventListener(name, rememberSelection));
  emojiButton.setAttribute('aria-controls', 'emojiPicker');
  emojiButton.setAttribute('aria-expanded', 'false');
  function closeEmojis() { picker.classList.add('hidden'); emojiButton.setAttribute('aria-expanded', 'false'); }
  emoji.forEach(([symbol, name]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = symbol; button.setAttribute('aria-label', name); button.title = name;
    button.addEventListener('click', () => {
      const start = Math.min(selection[0], input.value.length), end = Math.min(selection[1], input.value.length);
      if (input.value.length - (end - start) + symbol.length <= input.maxLength) {
        input.setRangeText(symbol, start, end, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      closeEmojis(); input.focus(); rememberSelection();
    });
    picker.append(button);
  });
  emojiButton.addEventListener('click', () => {
    const open = picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !open); emojiButton.setAttribute('aria-expanded', String(open));
    if (open) picker.querySelector('button').focus();
  });
  document.addEventListener('click', event => {
    if (!picker.contains(event.target) && !emojiButton.contains(event.target)) closeEmojis();
  });

  const bio = $('#profileBio'), bioCount = document.createElement('span');
  bioCount.className = 'bio-count'; bioCount.id = 'bioCount';
  bio.setAttribute('aria-describedby', 'bioCount'); bio.after(bioCount);
  const countBio = () => { bioCount.textContent = `${bio.value.length} / 280 caractères`; };
  bio.addEventListener('input', countBio); countBio();

  // Fenêtres : focus initial, fermeture avec Échap et retour au bouton d’origine.
  const closers = {
    onlineMembersModal: 'closeOnlineMembers', profileModal: 'closeProfile', publicProfileModal: 'closePublicProfile', searchModal: 'closeSearch',
    notificationsModal: 'closeNotifications', contactPickerModal: 'closeContactPicker', mediaLightbox: 'closeMediaLightbox',
  };
  const visibleModals = new Map();
  const focusables = modal => [...modal.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')]
    .filter(element => !element.disabled && element.getClientRects().length && !element.closest('.hidden'));
  Object.entries(closers).forEach(([id, closer]) => {
    const modal = document.getElementById(id); if (!modal) return;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const close = document.getElementById(closer);
    if (close && !close.getAttribute('aria-label')) close.setAttribute('aria-label', 'Fermer');
    new MutationObserver(() => {
      const open = !modal.classList.contains('hidden');
      if (open && !visibleModals.has(modal)) {
        visibleModals.set(modal, document.activeElement);
        if (id === 'profileModal') countBio();
        (focusables(modal)[0] || modal).focus();
      } else if (!open && visibleModals.has(modal)) {
        const previous = visibleModals.get(modal); visibleModals.delete(modal);
        if (previous?.isConnected && previous.getClientRects().length) previous.focus();
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !picker.classList.contains('hidden')) {
      closeEmojis(); emojiButton.focus(); event.preventDefault(); return;
    }
    const modal = [...visibleModals.keys()].at(-1);
    if (!modal) return;
    if (event.key === 'Escape') { document.getElementById(closers[modal.id])?.click(); event.preventDefault(); }
    if (event.key === 'Tab') {
      const items = focusables(modal), first = items[0], last = items.at(-1);
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
      else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
    }
  });
  const backdrop = document.createElement('button');
  backdrop.type = 'button'; backdrop.className = 'drawer-backdrop'; backdrop.setAttribute('aria-label', 'Fermer le panneau');
  $('#app').append(backdrop);
  backdrop.addEventListener('click', () => {
    $('.side').classList.remove('open'); $('.people').classList.remove('open');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('.side').classList.remove('open'); $('.people').classList.remove('open'); }
  });
  const peopleMedia = matchMedia('(max-width: 1180px)'), sideMedia = matchMedia('(max-width: 760px)');
  function syncPanels() {
    $('.side').inert = sideMedia.matches && !$('.side').classList.contains('open');
    $('.people').inert = peopleMedia.matches && !$('.people').classList.contains('open');
    $('#roomsBtn').setAttribute('aria-expanded', String($('.side').classList.contains('open')));
    $('#peopleBtn').setAttribute('aria-expanded', String($('.people').classList.contains('open')));
  }
  [$('.side'), $('.people')].forEach(panel => new MutationObserver(syncPanels).observe(panel, { attributes: true, attributeFilter: ['class'] }));
  peopleMedia.addEventListener('change', syncPanels); sideMedia.addEventListener('change', syncPanels); syncPanels();
})();
