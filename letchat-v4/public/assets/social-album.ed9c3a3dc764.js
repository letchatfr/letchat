import { blobBase64 } from "./social-voice.e9c6f0e283d0.js";

export function createAlbum({ getContext, json, dialog, media, clearUrls, notify, after }) {
  const q = (s, root) => root.querySelector(s);
  const manager = dialog("Mon album photo", "social-album-manager");
  const viewer = dialog("Album photo", "social-album-viewer");
  manager.setAttribute("aria-label", "Mon album photo"); viewer.setAttribute("aria-label", "Album photo"); viewer.tabIndex = -1;
  // Native dialogs handle Escape and focus trapping; do not close the profile behind them.
  for (const modal of [manager, viewer]) modal.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
  });
  const publicAlbum = document.createElement("section"); publicAlbum.className = "social-album-public"; after.after(publicAlbum);
  const button = document.createElement("button"); button.type = "button"; button.className = "social-rich-button social-album-button";
  button.textContent = "Mon album photo"; document.querySelector(".social-rich-button").after(button);
  let publicRevision = 0, managerRevision = 0, viewRevision = 0, view = null;
  const endpoint = owner => `/albums/${encodeURIComponent(owner)}`;
  const photoPath = (owner, photo, size) => `/api/social${endpoint(owner)}/${encodeURIComponent(photo.id)}/${size}`;
  const current = (uid, revision) => uid === getContext().uid && revision === managerRevision && manager.open;
  function clear(root) { clearUrls(root); root.replaceChildren(); }

  function grid(root, photos, owner, editable = false) {
    clear(root); root.className = "social-album-grid";
    photos.forEach((photo, index) => {
      const card = document.createElement("div"); card.className = "social-album-card";
      const open = document.createElement("button"); open.type = "button"; open.className = "social-album-thumb";
      open.setAttribute("aria-label", `Agrandir la photo ${index + 1}`);
      const img = document.createElement("img"); img.alt = `Photo ${index + 1} de l’album`; img.dataset.socialMedia = photoPath(owner, photo, "thumbnail");
      open.append(img); open.onclick = () => openViewer(owner, photos, index); card.append(open);
      if (editable) {
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "social-album-delete";
        remove.textContent = "Supprimer"; remove.setAttribute("aria-label", `Supprimer la photo ${index + 1}`);
        remove.onclick = () => deletePhoto(photo, owner); card.append(remove);
      }
      root.append(card);
    });
    if (!photos.length) { const p = document.createElement("p"); p.className = "social-album-empty"; p.textContent = editable ? "Votre album est vide. Ajoutez vos premières photos." : "Ce membre n’a pas encore ajouté de photo."; root.append(p); }
    void media(root);
  }

  async function showPublic(owner) {
    const revision = ++publicRevision, uid = getContext().uid; clear(publicAlbum);
    publicAlbum.innerHTML = '<h3>Album photo</h3><p role="status">Chargement des photos…</p>';
    try {
      const album = await json(endpoint(owner));
      if (revision !== publicRevision || uid !== getContext().uid) return;
      clear(publicAlbum); const heading = document.createElement("h3"); heading.textContent = `Album photo · ${album.photos.length}`;
      const list = document.createElement("div"); publicAlbum.append(heading, list); grid(list, album.photos, owner);
    } catch (error) {
      if (revision !== publicRevision || uid !== getContext().uid) return;
      clear(publicAlbum); const p = document.createElement("p"); p.textContent = error.message || "Album indisponible"; publicAlbum.append(p);
    }
  }
  function hidePublic() { publicRevision++; clear(publicAlbum); if (viewer.open) viewer.close(); }

  async function openManager() {
    const uid = getContext().uid; if (!uid) return;
    const revision = ++managerRevision, content = q(".social-content", manager); clear(content); manager.removeAttribute("aria-busy");
    content.innerHTML = '<p role="status">Chargement de votre album…</p>'; if (!manager.open) manager.showModal();
    try {
      const album = await json(endpoint(uid)); if (!current(uid, revision)) return;
      content.innerHTML = `<p class="social-album-intro">Vos photos sont visibles directement par tous les membres connectés.</p>
        <div class="social-album-tools"><strong data-count></strong><button type="button" data-add>+ Ajouter des photos</button></div>
        <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple hidden aria-label="Choisir des photos">
        <p class="social-note">Jusqu’à 12 photos · 8 Mo maximum par fichier · JPG, PNG, WebP, GIF ou AVIF.</p>
        <p class="social-album-status" role="status" aria-live="polite"></p><div data-album-grid></div>`;
      q("[data-count]", content).textContent = `${album.photos.length} / ${album.limit} photos`;
      const add = q("[data-add]", content), input = q("input", content); add.disabled = album.photos.length >= album.limit;
      if (add.disabled) q(".social-album-status", content).textContent = "Album complet. Supprimez une photo pour libérer une place.";
      add.onclick = () => input.click(); input.onchange = () => upload([...input.files], uid, revision, album);
      grid(q("[data-album-grid]", content), album.photos, uid, true);
    } catch (error) {
      if (current(uid, revision)) { clear(content); const p = document.createElement("p"); p.setAttribute("role", "status"); p.textContent = error.message; content.append(p); }
    }
  }
  function busy(value) { manager.setAttribute("aria-busy", String(value)); manager.querySelectorAll(".social-content button,.social-content input").forEach(el => el.disabled = value); }
  async function upload(files, uid, revision, album) {
    if (!files.length || !current(uid, revision)) return;
    const status = q(".social-album-status", manager), input = q("input", manager);
    if (files.length > album.limit - album.photos.length) { status.textContent = `Il vous reste ${album.limit - album.photos.length} place(s). Sélectionnez moins de photos.`; input.value = ""; return; }
    const oversized = files.find(file => file.size > 8e6);
    if (oversized) { status.textContent = `« ${oversized.name} » dépasse 8 Mo. Choisissez une photo plus petite.`; input.value = ""; return; }
    busy(true); let added = 0, errorMessage = "";
    try {
      for (const file of files) {
        if (!current(uid, revision)) break;
        status.textContent = `Ajout de la photo ${added + 1} sur ${files.length}…`;
        const mediaBase64 = await blobBase64(file); if (!current(uid, revision)) break;
        await json("/albums", "POST", { mediaBase64, mediaType: file.type }); added++;
      }
    } catch (error) { errorMessage = error.message; }
    finally {
      if (current(uid, revision)) {
        busy(false); await openManager();
        const result = q(".social-album-status", manager);
        if (result && uid === getContext().uid && managerRevision === revision + 1) result.textContent = [added ? `${added} photo(s) ajoutée(s).` : "", errorMessage].filter(Boolean).join(" ");
      }
    }
  }
  async function deletePhoto(photo, uid) {
    if (uid !== getContext().uid || !window.confirm("Supprimer cette photo de votre album ?")) return;
    const revision = managerRevision; busy(true);
    try { await json(`/albums/${encodeURIComponent(photo.id)}`, "DELETE"); if (current(uid, revision)) await openManager(); }
    catch (error) { if (current(uid, revision)) { busy(false); q(".social-album-status", manager).textContent = error.message; notify(error.message); const add = q("[data-add]", manager); if (add) add.disabled = manager.querySelectorAll(".social-album-card").length >= 12; } }
  }

  function openViewer(owner, photos, index) {
    view = { owner, photos, index, uid: getContext().uid }; drawViewer(); if (!viewer.open) viewer.showModal();
  }
  function drawViewer() {
    if (!view || view.uid !== getContext().uid) return;
    const revision = ++viewRevision, { owner, photos, index } = view, content = q(".social-content", viewer); clear(content);
    q("h2", viewer).textContent = `Photo ${index + 1} sur ${photos.length}`;
    content.innerHTML = '<div class="social-album-image"><img alt=""></div><div class="social-album-navigation"><button type="button" data-prev aria-label="Photo précédente">← Précédente</button><span role="status">Chargement…</span><button type="button" data-next aria-label="Photo suivante">Suivante →</button></div>';
    const img = q("img", content); img.alt = `Photo ${index + 1} de l’album`; img.dataset.socialMedia = photoPath(owner, photos[index], "image");
    const prev = q("[data-prev]", content), next = q("[data-next]", content); prev.disabled = index === 0; next.disabled = index === photos.length - 1;
    prev.onclick = () => move(-1); next.onclick = () => move(1);
    void media(content).then(() => { if (revision === viewRevision && viewer.open) q("[role=status]", content).textContent = `${index + 1} / ${photos.length}`; });
  }
  function move(delta) { if (!view) return; const index = view.index + delta; if (index < 0 || index >= view.photos.length) return; view.index = index; drawViewer(); viewer.focus(); }
  viewer.addEventListener("keydown", event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); } });
  viewer.addEventListener("close", () => { viewRevision++; view = null; clear(q(".social-content", viewer)); });
  manager.addEventListener("close", () => { managerRevision++; manager.removeAttribute("aria-busy"); clear(q(".social-content", manager)); });
  button.onclick = openManager;
  function reset() { hidePublic(); managerRevision++; if (manager.open) manager.close(); clear(q(".social-content", manager)); }
  return { showPublic, hidePublic, reset, dispose() { reset(); manager.remove(); viewer.remove(); publicAlbum.remove(); button.remove(); } };
}
