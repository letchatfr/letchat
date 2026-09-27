export function installSurpriseUI({ openPrivate, openHome, report, block, closePanels, notify }) {
  const q = (selector, root = document) => root.querySelector(selector);
  const menu = q("#surpriseLink");
  let socket, current = { status: "idle" }, revision = -1, busy = false, shownMatch = null;
  const dialog = document.createElement("dialog");
  dialog.className = "surprise-dialog";
  dialog.setAttribute("aria-labelledby", "surpriseTitle");
  dialog.innerHTML = `<div class="surprise-top"><h2 id="surpriseTitle">Rencontre Surprise</h2><button type="button" data-close aria-label="Fermer">×</button></div>
    <div class="surprise-content"><div class="surprise-dice" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.7"/><g fill="currentColor"><circle cx="8" cy="8" r="1.5"/><circle cx="16" cy="8" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/></g></svg></div>
    <h3>Une personne. Une discussion à découvrir.</h3>
    <p>Rencontrez au hasard un membre connecté qui souhaite aussi discuter. Votre pseudo lui sera visible et votre conversation s’ouvrira en privé.</p>
    <p class="surprise-status" role="status" aria-live="polite"></p>
    <p class="surprise-error" role="alert"></p>
    <div class="surprise-actions"><button type="button" data-start class="surprise-primary">Trouver une personne</button><button type="button" data-return hidden>Ouvrir la conversation</button><button type="button" data-stop hidden>Annuler la recherche</button></div>
    <p class="surprise-note">Disponible pour tous les membres. Aucun appel ni caméra ne démarre. Vous pouvez passer ou quitter à tout moment. Les échanges restent dans vos messages privés ; pour empêcher de nouveaux messages, bloquez la personne.</p></div>`;
  document.body.append(dialog);
  const bar = document.createElement("section");
  bar.className = "surprise-bar"; bar.hidden = true; bar.setAttribute("aria-label", "Rencontre Surprise en cours");
  bar.innerHTML = `<div><strong><svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" stroke-width="1.7"/><g fill="currentColor"><circle cx="8" cy="8" r="1.5"/><circle cx="16" cy="8" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/></g></svg> Rencontre Surprise</strong><span data-status role="status" aria-live="polite"></span></div><div class="surprise-actions"><button type="button" data-chat>Conversation</button><button type="button" data-next>Passer</button><button type="button" data-leave>Quitter</button><button type="button" data-block>Bloquer</button><button type="button" data-report>Signaler</button></div>`;
  q(".social-toolbar").after(bar);
  const messages = {
    left: "Vous avez quitté Rencontre Surprise.",
    "peer-left": "L’autre personne a quitté la rencontre. Vous pouvez lancer une nouvelle recherche.",
    blocked: "La rencontre est terminée suite à un blocage.",
    timeout: "La recherche a été arrêtée après 10 minutes. Réessayez quand vous le souhaitez.",
    disconnected: "Connexion interrompue : la rencontre est terminée. Relancez la recherche après reconnexion.",
    unavailable: "La rencontre est terminée. Vérifiez vos réglages de messages privés avant de recommencer.",
  };
  function render() {
    const matched = current.status === "matched", waiting = current.status === "waiting";
    const label = matched ? `Vous êtes avec ${current.partner.name}.` : waiting ? "Recherche en cours… En attente d’un autre membre volontaire." : messages[current.reason] || "Lancez la recherche quand vous êtes prêt à discuter.";
    q(".surprise-status", dialog).textContent = label;
    q("[data-status]", bar).textContent = label;
    bar.hidden = !(matched || waiting);
    q("[data-start]", dialog).hidden = matched || waiting;
    q("[data-return]", dialog).hidden = !matched;
    q("[data-stop]", dialog).hidden = !(matched || waiting);
    q("[data-stop]", dialog).textContent = matched ? "Quitter la rencontre" : "Annuler la recherche";
    for (const name of ["chat", "next", "block", "report"]) q(`[data-${name}]`, bar).hidden = !matched;
    q("[data-leave]", bar).textContent = waiting ? "Annuler" : "Quitter";
    menu.classList.toggle("surprise-active", matched || waiting);
    menu.setAttribute("aria-label", `Rencontre Surprise${waiting ? " — recherche en cours" : matched ? " — rencontre en cours" : ""}`);
    for (const button of [...dialog.querySelectorAll("button:not([data-close])"), ...bar.querySelectorAll("button")]) button.disabled = busy || !socket?.connected;
  }
  function receive(value) {
    if (!value || value.revision <= revision) return;
    revision = value.revision;
    const previous = current;
    current = value;
    render();
    if (value.status === "matched" && value.matchId !== shownMatch) {
      shownMatch = value.matchId;
      if (dialog.open) dialog.close();
      openPrivate(value.partner.id, value.partner.name);
    } else if (value.status === "idle" && previous.status !== "idle") {
      shownMatch = null;
      if (previous.partner) openHome(previous.partner.id);
      if (messages[value.reason]) notify(messages[value.reason]);
    }
  }
  async function command(kind) {
    if (busy) return;
    if (!socket?.connected) { q(".surprise-error", dialog).textContent = "Attendez la reconnexion au tchat."; return; }
    const source = socket;
    busy = true; q(".surprise-error", dialog).textContent = ""; render();
    try {
      const answer = await new Promise((resolve, reject) => source.timeout(8000).emit(`surprise-${kind}`, { matchId: current.matchId }, (error, response) => error ? reject(new Error("La réponse tarde. Réessayez ; votre état sera resynchronisé.")) : resolve(response)));
      if (source !== socket) return;
      if (!answer?.ok) throw new Error(answer?.error || "La recherche est indisponible.");
      receive(answer.state);
    } catch (error) {
      q(".surprise-error", dialog).textContent = error.message; notify(error.message);
      if (source === socket && source.connected) source.emit("surprise-status", {}, answer => { if (answer?.ok && source === socket) receive(answer.state); });
    } finally { if (source === socket) { busy = false; render(); } }
  }
  function show() { closePanels(); if (!dialog.open) dialog.showModal(); render(); }
  menu.onclick = event => { event.preventDefault(); show(); };
  q("[data-close]", dialog).onclick = () => dialog.close();
  q("[data-start]", dialog).onclick = () => command("join");
  q("[data-stop]", dialog).onclick = () => command("leave");
  const resume = () => { if (current.partner) { dialog.close(); openPrivate(current.partner.id, current.partner.name); } };
  q("[data-return]", dialog).onclick = resume;
  q("[data-chat]", bar).onclick = resume;
  q("[data-next]", bar).onclick = () => command("next");
  q("[data-leave]", bar).onclick = () => command("leave");
  q("[data-block]", bar).onclick = () => { if (current.partner) block({ ...current.partner }); };
  q("[data-report]", bar).onclick = () => { if (current.partner) report({ ...current.partner }); };
  function bind(nextSocket) {
    socket = nextSocket; current = { status: "idle" }; revision = -1; shownMatch = null; busy = false; render();
    nextSocket.on("surprise-state", value => { if (socket === nextSocket) receive(value); });
    nextSocket.on("connect", () => {
      if (socket !== nextSocket) return;
      revision = -1; busy = false; render();
      nextSocket.emit("surprise-status", {}, answer => { if (answer?.ok && socket === nextSocket) receive(answer.state); });
    });
    nextSocket.on("disconnect", () => {
      if (socket !== nextSocket) return;
      const previous = current;
      current = { status: "idle", reason: "disconnected" }; shownMatch = null; busy = false; render();
      if (previous.partner) openHome(previous.partner.id);
      if (dialog.open) dialog.close();
    });
  }
  render();
  return { bind };
}
