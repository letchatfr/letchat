/* Présentation uniquement : conserve les boutons, identités et contrôles d’accès existants. */
(() => {
  'use strict';
  const root = document.documentElement;
  const $ = selector => document.querySelector(selector);
  const app = $('#app'), chat = $('.chat'), side = $('.side');
  if (!app || !chat || !side || $('#refonteBottomNav')) return;
  const ICONS = {"MessageCircle":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],"MessagesSquare":[["path",{"d":"M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"}],["path",{"d":"M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"}]],"Inbox":[["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],"Users":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["path",{"d":"M16 3.128a4 4 0 0 1 0 7.744"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["circle",{"cx":"9","cy":"7","r":"4"}]],"Shuffle":[["path",{"d":"m18 14 4 4-4 4"}],["path",{"d":"m18 2 4 4-4 4"}],["path",{"d":"M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"}],["path",{"d":"M2 6h1.972a4 4 0 0 1 3.6 2.2"}],["path",{"d":"M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"}]],"Sparkles":[["path",{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}],["path",{"d":"M20 2v4"}],["path",{"d":"M22 4h-4"}],["circle",{"cx":"4","cy":"20","r":"2"}]],"Settings":[["path",{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"LogOut":[["path",{"d":"m16 17 5-5-5-5"}],["path",{"d":"M21 12H9"}],["path",{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}]],"PanelLeft":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],"Ellipsis":[["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]],"Coffee":[["path",{"d":"M10 2v2"}],["path",{"d":"M14 2v2"}],["path",{"d":"M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"}],["path",{"d":"M6 2v2"}]],"Newspaper":[["path",{"d":"M15 18h-5"}],["path",{"d":"M18 14h-8"}],["path",{"d":"M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"}],["rect",{"width":"8","height":"4","x":"10","y":"6","rx":"1"}]],"Heart":[["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],"Image":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["circle",{"cx":"9","cy":"9","r":"2"}],["path",{"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}]],"Video":[["path",{"d":"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"}],["rect",{"x":"2","y":"6","width":"14","height":"12","rx":"2"}]],"LockKeyhole":[["circle",{"cx":"12","cy":"16","r":"1"}],["rect",{"x":"3","y":"10","width":"18","height":"12","rx":"2"}],["path",{"d":"M7 10V7a5 5 0 0 1 10 0v3"}]],"Sun":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m17.66 17.66 1.41 1.41"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"m6.34 17.66-1.41 1.41"}],["path",{"d":"m19.07 4.93-1.41 1.41"}]],"Moon":[["path",{"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}]],"SunMoon":[["path",{"d":"M12 2v2"}],["path",{"d":"M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"}],["path",{"d":"M16 12a4 4 0 0 0-4-4"}],["path",{"d":"m19 5-1.256 1.256"}],["path",{"d":"M20 12h2"}]],"Plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"Paperclip":[["path",{"d":"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"}]],"Camera":[["path",{"d":"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"}],["circle",{"cx":"12","cy":"13","r":"3"}]],"Mic":[["path",{"d":"M12 19v3"}],["path",{"d":"M19 10v2a7 7 0 0 1-14 0v-2"}],["rect",{"x":"9","y":"2","width":"6","height":"13","rx":"3"}]],"Smile":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M8 14s1.5 2 4 2 4-2 4-2"}],["line",{"x1":"9","x2":"9.01","y1":"9","y2":"9"}],["line",{"x1":"15","x2":"15.01","y1":"9","y2":"9"}]],"ArrowUp":[["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],"Eye":[["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"SquarePen":[["path",{"d":"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],["path",{"d":"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"}]],"Gamepad2":[["line",{"x1":"6","x2":"10","y1":"11","y2":"11"}],["line",{"x1":"8","x2":"8","y1":"9","y2":"13"}],["line",{"x1":"15","x2":"15.01","y1":"12","y2":"12"}],["line",{"x1":"18","x2":"18.01","y1":"10","y2":"10"}],["path",{"d":"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"}]],"Bell":[["path",{"d":"M10.268 21a2 2 0 0 0 3.464 0"}],["path",{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"}]],"Search":[["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],"CircleUserRound":[["path",{"d":"M17.925 20.056a6 6 0 0 0-11.851.001"}],["circle",{"cx":"12","cy":"11","r":"4"}],["circle",{"cx":"12","cy":"12","r":"10"}]],"CircleHelp":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],"ShieldCheck":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]],"Flag":[["path",{"d":"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"}]],"Ban":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M4.929 4.929 19.07 19.071"}]]};
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false'); svg.classList.add('refonte-icon');
    for (const [tag, attrs] of ICONS[name] || ICONS.MessageCircle) {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  }
  function labelControl(element, name, label, visibleText = false) {
    if (!element) return;
    // Badges are live nodes watched by the existing application.
    const badges = [...element.querySelectorAll('.unread-badge,.room-unread,.online-members-badge,.mobile-nav-badge,.mobile-unread-dot')];
    element.replaceChildren(icon(name));
    if (visibleText) { const text = document.createElement('span'); text.textContent = label; element.append(text); }
    element.append(...badges); element.setAttribute('aria-label', label); element.title = label;
  }
  function proxy(target, name, label) {
    const button = document.createElement('button'); button.type = 'button';
    button.append(icon(name), document.createTextNode(label));
    button.addEventListener('click', () => { $('.side').classList.remove('open'); $('.people').classList.remove('open'); $(target)?.click(); });
    return button;
  }
  $('.brand b').replaceChildren(icon('MessagesSquare'));
  labelControl($('#privateMessagesLink'), 'Inbox', 'Messages privés', true);
  labelControl($('#onlineMembersLink'), 'Users', 'Membres en ligne', true);
  labelControl($('#surpriseLink'), 'Shuffle', 'Rencontre Surprise', true);
  labelControl($('#premiumShortcut'), 'Sparkles', 'Découvrir Premium', true);
  labelControl($('#profileBtn'), 'Settings', 'Modifier mon profil');
  labelControl($('#logout'), 'LogOut', 'Déconnexion');
  labelControl($('#mobileNavRooms'), 'PanelLeft', 'Ouvrir les salons');
  labelControl($('#mobileNavMembers'), 'Users', 'Membres', true);
  labelControl($('#mobileNavMore'), 'Ellipsis', 'Options du tchat');
  const rooms = { cafe:'Coffee', actualites:'Newspaper', debats:'MessagesSquare', creatifs:'Heart', amateurs:'Image', webcam:'Video', entraide:'LockKeyhole', 'rencontres-premium':'LockKeyhole' };
  for (const link of document.querySelectorAll('#roomDirectory [data-room]')) {
    link.querySelector('.v2-room-icon')?.replaceChildren(icon(rooms[link.dataset.room] || 'MessageCircle'));
  }
  const discussions = proxy('#roomDirectory [data-room="cafe"]', 'MessageCircle', 'Discussions');
  discussions.id = 'refonteHome'; discussions.className = 'refonte-home';
  side.querySelector('nav').before(discussions);
  const theme = $('#themeBtn');
  $('.account').insertBefore(theme, $('#logout'));
  const eyebrow = document.createElement('span'); eyebrow.className = 'refonte-eyebrow';
  eyebrow.textContent = 'PRENEZ LE TEMPS D’ÉCHANGER'; $('.chat-heading').prepend(eyebrow);
  const themeIcon = () => {
    if (!theme.querySelector('.refonte-icon')) theme.prepend(icon(root.dataset.theme === 'dark' ? 'Sun' : 'Moon'));
    [...theme.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => node.remove());
  };
  new MutationObserver(themeIcon).observe(theme, { childList:true }); themeIcon();
  const browserTheme = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = root.dataset.theme === 'dark' ? '#191b20' : '#fffdfb';
  };
  new MutationObserver(browserTheme).observe(root, { attributes:true, attributeFilter:['data-theme'] });
  browserTheme();
  for (const [id, name, label] of [
    ['mobileComposerToggle','Plus','Pièces jointes et emojis'], ['attach','Paperclip','Joindre une photo, une vidéo ou un audio'],
    ['cameraBtn','Camera','Prendre une photo'], ['voiceBtn','Mic','Enregistrer un message vocal'],
    ['emoji','Smile','Choisir un emoji'], ['send','ArrowUp','Envoyer le message'], ['viewOnceBtn','Eye','Média visible une seule fois'],
  ]) labelControl(document.getElementById(id),name,label);

  // Le menu existant gère le focus et la fermeture. Chaque entrée appelle son vrai bouton.
  const toolOptions = [
    ['.new','Nouveau message','SquarePen'], ['.social-toolbar [data-live]','Visio du salon','Video'],
    ['.social-toolbar [data-groups]','Groupes','Users'], ['.social-toolbar [data-games]','Jeux à deux','Gamepad2'],
    ['.v3-tools [data-preferences]','Préférences de notification','Bell'], ['#logout','Se déconnecter','LogOut'],
  ];
  $('#mobileNavMore').addEventListener('click', () => {
    const list = $('#mobileActionsList');
    for (const [selector,label,name] of toolOptions) {
      const target = $(selector);
      if (!target || target.hidden || target.classList.contains('hidden') || target.closest('[hidden]')) continue;
      const button = document.createElement('button'); button.type = 'button'; button.disabled = target.disabled;
      const symbol = document.createElement('span'); symbol.className = 'mobile-action-symbol'; symbol.append(icon(name));
      const text = document.createElement('span'); text.textContent = label;
      button.append(symbol,text); button.dataset.refonteTarget = selector;
      button.addEventListener('click', () => { $('#closeMobileActions').click(); target.click(); });
      list.append(button);
    }
    const optionIcons = {privateMessagesLink:'Inbox',peopleBtn:'Users',searchBtn:'Search',notificationsBtn:'Bell',privateProfileBtn:'CircleUserRound',profileBtn:'Settings',welcomeGuideButton:'CircleHelp',premiumShortcut:'Sparkles',themeBtn:'SunMoon',callBtn:'Video',adminBtn:'ShieldCheck',reportBtn:'Flag',blockBtn:'Ban'};
    for (const button of list.querySelectorAll('[data-mobile-action]')) {
      button.querySelector('.mobile-action-symbol')?.replaceChildren(icon(optionIcons[button.dataset.mobileAction] || 'Ellipsis'));
    }
  });

  // Une vraie barre de navigation mobile, reliée aux fonctions existantes.
  const nav = document.createElement('nav'); nav.id = 'refonteBottomNav'; nav.className = 'refonte-bottom-nav'; nav.setAttribute('aria-label','Navigation principale');
  const mobile = [ ['#mobileNavRooms','MessageCircle','Salons','rooms'], ['#privateMessagesLink','Inbox','Messages','private'], ['#onlineMembersLink','Users','Membres','members'], ['#surpriseLink','Shuffle','Surprise','surprise'], ['#profileBtn','CircleUserRound','Profil','profile'] ];
  for (const [target,name,label,key] of mobile) {
    const button = proxy(target,name,label); button.dataset.refonteNav = key; nav.append(button);
    if (key === 'private') { const badge = document.createElement('span'); badge.className = 'room-unread hidden'; badge.id = 'refontePrivateBadge'; button.append(badge); }
  }
  chat.append(nav);
  function syncNavigation() {
    const privateMode = $('#privateMessagesLink').classList.contains('active');
    let active = privateMode ? 'private' : 'rooms';
    if (!$('#onlineMembersModal').classList.contains('hidden')) active = 'members';
    if (!$('#profileModal').classList.contains('hidden')) active = 'profile';
    const surprise = $('.surprise-dialog'); if (surprise?.open) active = 'surprise';
    discussions.setAttribute('aria-current',String(!privateMode));
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-current',String(button.dataset.refonteNav === active)));
    const source = $('#privateMessagesNavBadge'), badge = $('#refontePrivateBadge');
    badge.textContent = source.textContent; badge.classList.toggle('hidden',source.classList.contains('hidden'));
  }
  for (const node of [$('#privateMessagesLink'),$('#privateMessagesNavBadge'),$('#onlineMembersModal'),$('#profileModal')]) {
    new MutationObserver(syncNavigation).observe(node,{attributes:true,attributeFilter:['class'],childList:true,characterData:true,subtree:true});
  }
  syncNavigation();
  function simplifyTitle() {
    const heading = $('.chat-heading h1');
    const clean = heading.textContent.replace(/^[☀◌◎◈✦◇♡▣]\s*/u,'');
    if (heading.textContent !== clean) heading.textContent = clean;
  }
  new MutationObserver(simplifyTitle).observe($('.chat-heading h1'),{childList:true,characterData:true,subtree:true}); simplifyTitle();

  // Les boutons originaux restent dans le message : réaction, réponse, édition, signalement, copie.
  const messages = $('#messages');
  function enhanceMessages() {
    for (const message of messages.querySelectorAll('.message:not(.refonte-message)')) {
      const actions = message.querySelector('.message-actions'), meta = message.querySelector('.meta');
      if (!actions || !meta) continue;
      message.classList.add('refonte-message');
      actions.id = `refonte-actions-${message.dataset.key}`;
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'refonte-message-toggle';
      toggle.setAttribute('aria-label','Actions du message'); toggle.setAttribute('aria-expanded','false'); toggle.setAttribute('aria-controls',actions.id); toggle.append(icon('Ellipsis'));
      toggle.addEventListener('click', () => {
        const open = !message.classList.contains('refonte-actions-open');
        closeMessageActions(); message.classList.toggle('refonte-actions-open',open); toggle.setAttribute('aria-expanded',String(open));
      });
      meta.append(toggle);
      actions.addEventListener('click', event => {
        if (event.target.closest('.reply-action,.copy-message-action,.report-message-action,.delete-action,.edit-message-action,[data-pick-reaction]')) {
          message.classList.remove('refonte-actions-open'); toggle.setAttribute('aria-expanded','false');
        }
      });
    }
  }
  function closeMessageActions() {
    for (const message of messages.querySelectorAll('.refonte-actions-open')) {
      message.classList.remove('refonte-actions-open'); message.querySelector('.refonte-message-toggle')?.setAttribute('aria-expanded','false');
    }
  }
  new MutationObserver(enhanceMessages).observe(messages,{childList:true,subtree:true}); enhanceMessages();
  document.addEventListener('click', event => { if (!event.target.closest('.message')) closeMessageActions(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMessageActions(); });
  // Masquer les anciennes barres seulement lorsque tous les accès de remplacement sont prêts.
  root.classList.add('refonte-ready');
})();
