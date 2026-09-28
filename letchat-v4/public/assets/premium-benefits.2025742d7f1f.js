export function installPremiumBenefitsUI({ api, getContext, showProfile, openPrivate, showPublicProfile, onPresenceChange }) {
  const q = (s, root = document) => root.querySelector(s);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const accents = { default: "Classique", coral: "Corail", blue: "Bleu", purple: "Violet", green: "Vert" };
  const frames = { none: "Sans cadre", gold: "Or", coral: "Corail", blue: "Bleu", purple: "Violet" };
  const json = async (path, method = "GET", body) => (await api(`/api/premium${path}`, { method, ...(body === undefined ? {} : { headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) }) })).json();
  function makeDialog(title, className) {
    const d = document.createElement("dialog"); d.className = `social-dialog ${className}`; d.setAttribute("aria-label", title);
    d.innerHTML = `<div class="social-top"><h2>${title}</h2><button type="button" data-close aria-label="Fermer">×</button></div><div class="social-content"></div>`;
    q("[data-close]",d).onclick = () => d.close();
    d.addEventListener("keydown", event => { if (["Escape","Tab"].includes(event.key)) event.stopPropagation(); });
    document.body.append(d); return d;
  }
  const settings = makeDialog("Mes avantages Premium", "premium-settings"), search = makeDialog("Recherche avancée", "premium-search");
  const settingsButton = document.createElement("button"); settingsButton.type = "button"; settingsButton.id = "premiumPerksBtn"; settingsButton.className = "premium-perks-button";
  settingsButton.textContent = "Découvrir mes avantages Premium"; q("#premiumChoices").before(settingsButton);
  const searchButton = document.createElement("button"); searchButton.type = "button"; searchButton.className = "premium-search-button"; searchButton.textContent = "Recherche avancée · Premium";
  q("#onlineMembersGrid").before(searchButton);
  let state = null, owner = "", socket, revision = 0, searchRevision = 0, refreshRevision = 0, disposed = false, paintTimer, painting = false;
  const appearances = new Map();
  const alive = (uid, stamp) => getContext().uid === uid && stamp === revision && !disposed;
  async function refresh() {
    const uid = getContext().uid, ticket = ++refreshRevision; if (!uid) return null;
    const data = await json("/benefits"); if (uid !== getContext().uid) return null;
    if (ticket !== refreshRevision) return data;
    state = data; settingsButton.textContent = data.premium ? "Personnaliser mon Premium" : "Découvrir les avantages Premium";
    document.body.classList.toggle("premium-discreet-active", data.discreet);
    let indicator = q("#premiumDiscreetState");
    if (!indicator) { indicator = document.createElement("p"); indicator.id = "premiumDiscreetState"; indicator.className = "premium-discreet-indicator"; q("#premiumState").after(indicator); }
    indicator.hidden = !data.discreet; indicator.textContent = "Mode discret activé · présence masquée";
    return data;
  }
  function appearance(el, data, avatar = false) {
    const accent = Object.hasOwn(accents,data?.premium_accent) ? data.premium_accent : "default";
    const frame = Object.hasOwn(frames,data?.premium_frame) ? data.premium_frame : "none";
    if (el.dataset.premiumAccent !== (avatar ? "default" : accent)) el.dataset.premiumAccent = avatar ? "default" : accent;
    if (el.dataset.premiumFrame !== (avatar ? frame : "none")) el.dataset.premiumFrame = avatar ? frame : "none";
    const badge = el.querySelector(":scope > .premium-member-badge");
    if (!avatar && data?.premium_badge && !badge) { const span = document.createElement("span"); span.className = "premium-member-badge"; span.textContent = "Premium"; el.append(span); }
    else if ((!data?.premium_badge || avatar) && badge) badge.remove();
  }
  const identityNodes = () => [...document.querySelectorAll("button[data-private-user]")];
  function applyAppearances() {
    for (const el of identityNodes()) appearance(el,appearances.get(el.dataset.privateUser)?.data,el.classList.contains("member-avatar-link") || Boolean(el.querySelector("img")));
    const own = appearances.get(getContext().uid)?.data;
    appearance(q("#meName"),own); appearance(q("#mePhotoLink"),own,true);
  }
  async function paint() {
    if (painting || !getContext().uid || disposed) return;
    painting = true; const uid = getContext().uid, stamp = revision;
    try {
      const ids = [...new Set([uid,...identityNodes().map(el => el.dataset.privateUser)])];
      const stale = ids.filter(id => !appearances.has(id) || Date.now()-appearances.get(id).time>60000), missing = stale.slice(0,60);
      if (missing.length) {
        const rows = await json("/appearances","POST",{ids:missing}); if (!alive(uid,stamp)) return;
        for (const id of missing) appearances.set(id,{data:{},time:Date.now()});
        for (const row of rows) appearances.set(row.id,{data:row,time:Date.now()});
        if (stale.length>60) schedulePaint();
      }
      if (alive(uid,stamp)) applyAppearances();
    } catch { /* Cosmetic metadata never blocks conversation controls. */ }
    finally { painting=false; }
  }
  function schedulePaint() { clearTimeout(paintTimer); paintTimer=setTimeout(()=>void paint(),120); }
  const observer = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node.nodeType===1 && !node.classList.contains("premium-member-badge")))) schedulePaint();
  });
  observer.observe(document.body,{childList:true,subtree:true});
  function offer(root, text) {
    root.innerHTML = `<div class="premium-offer"><p>${escape(text)}</p><ul><li>Album de 36 photos</li><li>Cadre, couleur du pseudo et badge Premium</li><li>Mode discret</li><li>Recherche avancée des membres</li><li>Groupes de 20 personnes</li></ul><button type="button" data-upgrade>Voir les formules Premium</button></div>`;
    q("[data-upgrade]",root).onclick = async () => { settings.close(); search.close(); await showProfile(); q(".premium-box").scrollIntoView({behavior:"smooth",block:"start"}); };
  }
  async function openSettings() {
    const uid=getContext().uid, stamp=++revision, content=q(".social-content",settings); content.innerHTML='<p role="status">Chargement…</p>'; if (!settings.open) settings.showModal();
    try {
      const data=await refresh(); if (!data || !alive(uid,stamp) || !settings.open) return;
      if (!data.premium) {
        offer(content,"Personnalisez votre profil et profitez de cinq avantages supplémentaires avec Premium ou Premium+.");
        if (data.discreet) {
          const p=document.createElement("p");p.textContent="Votre mode discret reste actif jusqu’à votre désactivation.";content.append(p);
          const b=document.createElement("button");b.type="button";b.textContent="Désactiver le mode discret";b.onclick=async()=>{b.disabled=true;try{await json("/preferences","PATCH",{discreet:false});await openSettings();}catch(e){b.disabled=false;p.textContent=e.message;}};content.append(b);
        }
        return;
      }
      const option=(values,selected)=>Object.entries(values).map(([id,label])=>`<option value="${id}" ${id===selected?"selected":""}>${label}</option>`).join("");
      content.innerHTML=`<div class="premium-perks-summary"><b>Votre Premium</b><span>36 photos dans votre album · groupes de 20 membres</span></div>
        <form class="social-form premium-settings-form"><h3>Un profil à votre image</h3><div class="premium-preview"><span class="premium-preview-avatar"></span><strong data-preview-name></strong></div>
        <div class="premium-fields"><label>Couleur du pseudo<select name="accent">${option(accents,data.accent)}</select></label><label>Cadre de la photo<select name="frame">${option(frames,data.frame)}</select></label></div>
        <label class="social-check"><input name="badge" type="checkbox" ${data.badge?"checked":""}>Afficher mon badge Premium</label>
        <div class="premium-discreet-box"><label class="social-check"><input name="discreet" type="checkbox" ${data.discreet?"checked":""}>Activer le mode discret</label>
        <p>Vous disparaissez des listes de membres en ligne. Votre dernière connexion et vos indicateurs de saisie sont masqués. Vos messages et votre participation à un appel restent visibles.</p>
        <small>Ce choix reste actif jusqu’à désactivation, même après la fin de l’abonnement.</small></div>
        <button type="submit">Enregistrer mes préférences</button><p data-status role="status"></p></form>
        <button type="button" class="premium-search-button" data-open-search>Ouvrir la recherche avancée</button>`;
      const form=q("form",content), avatar=q(".premium-preview-avatar",content), name=q("[data-preview-name]",content);
      const photo=q("#profilePhotoPreview").getAttribute("src") || q("#mePhoto").getAttribute("src"), displayName=q("#profileName").value||getContext().name||"Mon profil";
      if (photo) {const img=document.createElement("img");img.src=photo;img.alt="Ma photo de profil";avatar.append(img);} else avatar.textContent=displayName.slice(0,1).toUpperCase();
      const preview=()=>{name.textContent=displayName;const p={premium_badge:form.elements.badge.checked,premium_accent:form.elements.accent.value,premium_frame:form.elements.frame.value};appearance(name,p);appearance(avatar,p,true);};
      form.addEventListener("change",preview);preview();
      form.onsubmit=async event=>{event.preventDefault();const button=q('[type=submit]',form);button.disabled=true;
        try { const data=await json("/preferences","PATCH",{accent:form.elements.accent.value,frame:form.elements.frame.value,badge:form.elements.badge.checked,discreet:form.elements.discreet.checked});
          if(!alive(uid,stamp)||!settings.open)return;state=data;q("[data-status]",form).textContent="Vos préférences sont enregistrées.";await refresh();appearances.delete(uid);schedulePaint();
        }catch(error){if(alive(uid,stamp))q("[data-status]",form).textContent=error.message;}finally{button.disabled=false;}};
      q("[data-open-search]",content).onclick=()=>{settings.close();void openSearch();};
    } catch(error){if(alive(uid,stamp)&&settings.open)content.textContent=error.message;}
  }
  async function openSearch() {
    const uid=getContext().uid, ticket=++searchRevision, content=q(".social-content",search);content.innerHTML='<p role="status">Chargement…</p>';if(!search.open)search.showModal();
    try {
      const data=await refresh();if(!data||uid!==getContext().uid||ticket!==searchRevision||!search.open)return;
      if(!data.premium){offer(content,"Trouvez des membres avec les filtres Premium : ville, disponibilité, profil et photos.");return;}
      content.innerHTML=`<form class="social-form premium-search-form"><div class="premium-fields"><label>Pseudo, présentation ou centres d’intérêt<input name="q" type="search" maxlength="80" placeholder="Musique, cuisine…"></label><label>Ville<input name="city" data-city-autocomplete maxlength="60" placeholder="Ex. Montpellier"></label>
        <label>Genre<select name="gender"><option value="">Tous</option><option value="female">Femmes</option><option value="male">Hommes</option><option value="neutral">Autre / non précisé</option></select></label>
        <label>Disponibilité<select name="availability"><option value="">Toutes</option><option value="available">Disponible</option><option value="busy">Occupé</option><option value="away">Absent</option></select></label></div>
        <div class="social-actions"><label class="social-check"><input name="online" type="checkbox">En ligne uniquement</label><label class="social-check"><input name="photo" type="checkbox">Avec une photo</label></div>
        <small>Seules les informations que vous pouvez consulter sont utilisées. Les villes masquées et la présence des membres discrets restent privées.</small>
        <button type="submit">Rechercher des membres</button></form><p data-search-status role="status"></p><div class="premium-results"></div><button type="button" data-more hidden>Voir plus de membres</button>`;
      const form=q("form",content), results=q(".premium-results",content), status=q("[data-search-status]",content), more=q("[data-more]",content);
      let request=0, nextOffset=null, filters="", busy=false;
      const run=async offset=>{
        if(busy&&offset>0)return;busy=true;const number=++request;more.disabled=true;q('[type=submit]',form).disabled=true;
        if(!offset){filters=new URLSearchParams({q:form.elements.q.value,city:form.elements.city.value,gender:form.elements.gender.value,availability:form.elements.availability.value,online:String(form.elements.online.checked),photo:String(form.elements.photo.checked)}).toString();results.replaceChildren();more.hidden=true;}
        status.textContent="Recherche en cours…";
        try {
          const response=await json(`/members?${filters}&offset=${offset}`);
          if(number!==request||ticket!==searchRevision||uid!==getContext().uid||!search.open)return;
          for(const member of response.members){
            appearances.set(member.user_id,{data:member,time:Date.now()});const card=document.createElement("article");card.className="premium-member-card";
            card.innerHTML=`<div class="premium-result-head"><span class="premium-result-avatar"></span><div><strong></strong><small></small></div></div><p></p><div class="social-actions"><button type="button" data-profile>Voir le profil</button><button type="button" data-message>Écrire en privé</button></div>`;
            const avatar=q(".premium-result-avatar",card), title=q("strong",card);title.textContent=member.display_name;appearance(title,member);
            if(member.photo){const img=document.createElement("img");img.src=member.photo;img.alt="";avatar.append(img);}else avatar.textContent=member.display_name.slice(0,1).toUpperCase();appearance(avatar,member,true);
            q("small",card).textContent=`${member.city||"Ville masquée"} · ${member.presence_hidden?"Présence masquée":member.online?"En ligne":"Hors ligne"}`;
            q("p",card).textContent=member.bio||"Ce membre n’a pas encore ajouté de présentation.";
            const close=()=>{search.close();q("#onlineMembersModal").classList.add("hidden");q("#profileModal").classList.add("hidden");};
            q("[data-profile]",card).onclick=()=>{close();void showPublicProfile(member.user_id,member.display_name);};
            q("[data-message]",card).onclick=()=>{close();void openPrivate(member.user_id,member.display_name);};results.append(card);
          }
          nextOffset=response.nextOffset;more.hidden=nextOffset===null;
          status.textContent=results.children.length?`${results.children.length} membre(s) trouvé(s)${nextOffset!==null?" · d’autres résultats sont disponibles":""}.`:"Aucun membre ne correspond à ces critères. Essayez avec moins de filtres.";
        }catch(error){if(number===request&&ticket===searchRevision){status.textContent=error.message;if(!offset)results.replaceChildren();}}
        finally{if(number===request){busy=false;more.disabled=false;q('[type=submit]',form).disabled=false;}}
      };
      form.onsubmit=event=>{event.preventDefault();void run(0);};more.onclick=()=>{if(nextOffset!==null)void run(nextOffset);};await run(0);
    }catch(error){if(ticket===searchRevision&&uid===getContext().uid)content.textContent=error.message;}
  }
  settings.addEventListener("close",()=>{revision++;q(".social-content",settings).replaceChildren();});
  search.addEventListener("close",()=>{searchRevision++;q(".social-content",search).replaceChildren();});
  settingsButton.onclick=()=>void openSettings();searchButton.onclick=()=>void openSearch();
  const onAppearance=data=>{if(data?.id){appearances.set(data.id,{data,time:Date.now()});applyAppearances();if(Object.hasOwn(data,"presence_hidden"))onPresenceChange?.(data.id,data.presence_hidden);}};
  const onBenefits=()=>{void refresh().catch(()=>{});};
  function sync(){
    const context=getContext();
    if(context.uid!==owner){revision++;searchRevision++;refreshRevision++;owner=context.uid;state=null;appearances.clear();settings.close();search.close();document.body.classList.remove("premium-discreet-active");applyAppearances();if(owner){onBenefits();schedulePaint();}}
    if(socket!==context.socket){socket?.off("premium-appearance-updated",onAppearance);socket?.off("premium-benefits-updated",onBenefits);socket=context.socket;socket?.on("premium-appearance-updated",onAppearance);socket?.on("premium-benefits-updated",onBenefits);}
  }
  const syncTimer=setInterval(sync,500), poll=setInterval(()=>{if(!document.hidden){schedulePaint();onBenefits();}},60000);
  return {refresh,dispose(){disposed=true;clearInterval(syncTimer);clearInterval(poll);clearTimeout(paintTimer);observer.disconnect();settings.remove();search.remove();settingsButton.remove();searchButton.remove();socket?.off("premium-appearance-updated",onAppearance);socket?.off("premium-benefits-updated",onBenefits);}};
}
