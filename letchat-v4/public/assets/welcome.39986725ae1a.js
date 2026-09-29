/* Navigation de l’accueil, indépendante du chargement de la connexion Google. */
(() => {
  const doc = document;
  const tabs = [...doc.querySelectorAll('[data-auth-tab]')];
  const modes = {
    login: ['localLoginForm', 'Content de vous retrouver', 'Connectez-vous avec l’identifiant choisi à l’inscription et votre mot de passe.'],
    register: ['localRegisterForm', 'Faites comme chez vous', 'Créez votre compte pour retrouver votre profil à chaque visite.'],
    guest: ['guestLoginForm', 'Entrez, la discussion est ouverte', 'Découvrez Letchat sans mot de passe, avec un profil temporaire.'],
  };
  function selectMode(mode, focusField = false) {
    if (!modes[mode]) return;
    tabs.forEach(tab => {
      const active = tab.dataset.authTab === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    for (const [key, [id]] of Object.entries(modes)) doc.getElementById(id)?.classList.toggle('hidden', key !== mode);
    doc.getElementById('authTitle').textContent = modes[mode][1];
    doc.getElementById('authDescription').textContent = modes[mode][2];
    doc.getElementById('loginError')?.classList.add('hidden');
    // Les mots de passe redeviennent masqués en quittant un formulaire.
    doc.querySelectorAll('[data-password-toggle]').forEach(button => {
      doc.getElementById(button.dataset.passwordToggle).type = 'password';
      button.textContent = 'Afficher';
      button.setAttribute('aria-label', 'Afficher le mot de passe');
      button.setAttribute('aria-pressed', 'false');
    });
    if (focusField) {
      doc.getElementById('welcomeAccess').scrollIntoView({ block: 'start', behavior: 'auto' });
      doc.getElementById(modes[mode][0]).querySelector('input')?.focus({ preventScroll: true });
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectMode(tab.dataset.authTab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectMode(tabs[next].dataset.authTab);
      tabs[next].focus();
    });
  });
  doc.querySelectorAll('[data-auth-entry]').forEach(button => {
    button.addEventListener('click', () => selectMode(button.dataset.authEntry, true));
  });
  doc.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const field = doc.getElementById(button.dataset.passwordToggle);
      const show = field.type === 'password';
      field.type = show ? 'text' : 'password';
      button.textContent = show ? 'Masquer' : 'Afficher';
      button.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      button.setAttribute('aria-pressed', String(show));
    });
  });
  // Ne jamais laisser un formulaire naviguer si le module de connexion
  // n’est pas encore prêt (réseau lent ou chargement Google interrompu).
  doc.querySelectorAll('.local-auth-form').forEach(form => {
    form.addEventListener('submit', event => {
      if (typeof form.onsubmit === 'function') return;
      event.preventDefault();
      const error = doc.getElementById('loginError');
      error.textContent = 'La connexion n’est pas encore prête. Patientez quelques instants ou rechargez la page.';
      error.classList.remove('hidden');
      error.focus();
    }, true);
  });

  // Le guide reste facultatif ; il ouvre les fonctions déjà présentes du tchat.
  const guide = doc.getElementById('welcomeGuide');
  const guideButton = doc.getElementById('welcomeGuideButton');
  if (!guide || !guideButton) return;
  let guideAction = false;
  guideButton.addEventListener('click', () => {
    if (doc.getElementById('app').classList.contains('hidden')) return;
    doc.querySelector('.side')?.classList.remove('open');
    doc.querySelector('.people')?.classList.remove('open');
    guideAction = false;
    if (!guide.open) guide.showModal();
  });
  const destinations = { cafe: '.room[data-room="cafe"]', members: '#onlineMembersLink', profile: '#profileBtn' };
  guide.querySelectorAll('[data-welcome-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.welcomeAction;
      guideAction = true;
      guide.close();
      doc.querySelector(destinations[action])?.click();
      if (action === 'cafe') doc.getElementById('input')?.focus({ preventScroll: true });
    });
  });
  guide.addEventListener('click', event => {
    if (event.target !== guide) return;
    const rect = guide.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) guide.close();
  });
  guide.addEventListener('close', () => {
    if (!guideAction) {
      const target = window.matchMedia('(max-width: 760px)').matches ? doc.getElementById('mobileNavMore') : guideButton;
      target?.focus({ preventScroll: true });
    }
  });
})();
