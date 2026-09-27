export function createLiveView({ getContext, api, notify, beforeJoin }) {
  const panel = document.createElement("section");
  panel.className = "social-live"; panel.hidden = true;
  panel.innerHTML = `<header><div><strong data-title>Visio collective</strong><p data-status role="status">Caméra et micro désactivés</p></div><button data-close type="button">Quitter</button></header>
    <div class="social-video-grid"></div><footer><button data-camera type="button">Activer ma caméra</button><button data-mic type="button">Activer mon micro</button><button data-small type="button">Réduire</button></footer>`;
  document.body.append(panel);
  const $ = q => panel.querySelector(q), peers = new Map();
  let socket, scope, stream = null, revision = 0, joining = false, mediaBusy = false, iceServers;
  let camera = false, mic = false;
  const listeners = [];
  function tile(id, name, local = false) {
    const box = document.createElement("div"); box.className = "social-video";
    const video = document.createElement("video"); video.autoplay = true; video.playsInline = true; video.muted = local;
    const label = document.createElement("span"); label.textContent = name;
    const status = document.createElement("small"); status.textContent = "Caméra et micro coupés";
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Agrandir";
    button.onclick = () => {
      const was = box.classList.contains("focused"); panel.querySelectorAll(".social-video").forEach(e => { e.classList.remove("focused"); e.querySelector("button").textContent = "Agrandir"; });
      box.classList.toggle("focused", !was); button.textContent = was ? "Agrandir" : "Réduire";
    };
    box.append(video, label, status, button); $(".social-video-grid").append(box);
    return { box, video, status };
  }
  let local;
  function tellState() {
    socket?.emit("live-state", { camera, mic });
    $("[data-camera]").textContent = camera ? "Couper ma caméra" : "Activer ma caméra";
    $("[data-mic]").textContent = mic ? "Couper mon micro" : "Activer mon micro";
    local?.box.classList.toggle("camera-off", !camera);
    if (local) local.status.textContent = `${camera ? "Caméra active" : "Caméra coupée"} · ${mic ? "Micro actif" : "Micro coupé"}`;
  }
  const signal = (target, data) => socket?.emit("live-signal", { target, data });
  function removePeer(id) { const peer = peers.get(id); peer?.pc.close(); peer?.box.remove(); peers.delete(id); }
  async function attachLocalMedia(peer) {
    const transceivers = peer.pc.getTransceivers();
    for (const [kind, key] of [["audio", "audio"], ["video", "videoSender"]]) {
      const transceiver = transceivers.find(t => t.receiver.track.kind === kind);
      if (!transceiver) continue;
      transceiver.direction = "sendrecv"; peer[key] = transceiver.sender;
      await peer[key].replaceTrack(stream?.getTracks().find(t => t.kind === kind) || null);
    }
  }
  function createPeer(info) {
    if (peers.has(info.socketId)) return peers.get(info.socketId);
    const pc = new RTCPeerConnection({ iceServers }), view = tile(info.socketId, info.name);
    view.box.classList.toggle("camera-off", !info.camera);
    view.status.textContent = `${info.camera ? "Caméra active" : "Caméra coupée"} · ${info.mic ? "Micro actif" : "Micro coupé"}`;
    const peer = { ...view, pc, info, queue: [], chain: Promise.resolve(), makingOffer: false, ignoreOffer: false, settingAnswer: false,
      polite: socket.id.localeCompare(info.socketId) > 0 };
    peers.set(info.socketId, peer);
    // Exactly one side creates the two media sections. The answering side reuses
    // those sections, avoiding duplicate, silent tracks during simultaneous joins.
    if (!peer.polite) {
      peer.audio = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
      peer.videoSender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
    }
    pc.ontrack = e => {
      if (!view.video.srcObject) view.video.srcObject = new MediaStream();
      if (!view.video.srcObject.getTracks().some(t => t.id === e.track.id)) view.video.srcObject.addTrack(e.track);
      view.video.play().catch(() => { view.status.textContent = "Touchez la vidéo pour écouter"; view.video.onclick = () => view.video.play().catch(() => {}); });
    };
    pc.onicecandidate = e => { if (e.candidate) signal(info.socketId, { type: "candidate", candidate: e.candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      if (peer.polite || pc.signalingState !== "stable") return;
      try { peer.makingOffer = true; await attachLocalMedia(peer); await pc.setLocalDescription(); if (scope) signal(info.socketId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp }); }
      catch { if (scope) view.status.textContent = "Connexion vidéo indisponible"; } finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(pc.connectionState)) view.status.textContent = "Connexion interrompue : quittez puis rejoignez la visio";
    };
    return peer;
  }
  function receive({ from, data }) {
    const peer = peers.get(from); if (!scope || !peer) return;
    peer.chain = peer.chain.then(async () => {
      const pc = peer.pc;
      if (data.type === "candidate") {
        if (!peer.ignoreOffer) { if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else peer.queue.push(data.candidate); }
        return;
      }
      const ready = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
      const collision = data.type === "offer" && !ready;
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      peer.settingAnswer = data.type === "answer";
      await pc.setRemoteDescription({ type: data.type, sdp: data.sdp }); peer.settingAnswer = false;
      for (const candidate of peer.queue.splice(0)) await pc.addIceCandidate(candidate);
      if (data.type === "offer") { await attachLocalMedia(peer); await pc.setLocalDescription(); signal(from, { type: pc.localDescription.type, sdp: pc.localDescription.sdp }); }
    }).catch(() => { if (scope) peer.status.textContent = "Connexion à rétablir"; });
  }
  function leave(send = true) {
    revision++; joining = false; mediaBusy = false;
    $("[data-camera]").disabled = false; $("[data-mic]").disabled = false;
    if (send && scope) socket?.emit("live-leave");
    scope = null; panel.hidden = true; panel.classList.remove("compact");
    stream?.getTracks().forEach(t => t.stop()); stream = null; camera = false; mic = false;
    for (const id of [...peers.keys()]) removePeer(id);
    $(".social-video-grid").replaceChildren(); local = null;
    for (const [name, fn] of listeners.splice(0)) socket?.off(name, fn);
  }
  function bind(name, fn) { socket.on(name, fn); listeners.push([name, fn]); }
  async function join(nextScope, title) {
    if (joining) return;
    if (scope === nextScope) { panel.hidden = false; panel.classList.remove("compact"); return; }
    if (scope && !window.confirm("Quitter la visio actuelle pour rejoindre celle-ci ?")) return;
    leave(); socket = getContext().socket;
    if (!socket?.connected) return notify("Attendez la reconnexion au tchat");
    if (!window.RTCPeerConnection) return notify("La visio n’est pas disponible dans ce navigateur");
    beforeJoin(); const attempt = ++revision; joining = true;
    try {
      const config = await (await api("/api/turn-credentials")).json();
      iceServers = Array.isArray(config) ? config : config.iceServers;
      if (attempt !== revision) return;
      if (!Array.isArray(iceServers) || !iceServers.length) throw new Error("Relais vidéo indisponible");
      // Peers can signal while the join acknowledgement is still in transit.
      const pending = []; let ready = false;
      const receiveWhenReady = fn => value => { if (ready) fn(value); else pending.push(() => fn(value)); };
      bind("live-peer", receiveWhenReady(createPeer)); bind("live-left", receiveWhenReady(v => removePeer(v.socketId)));
      bind("live-signal", receiveWhenReady(receive));
      bind("live-state", receiveWhenReady(v => { const p = peers.get(v.socketId); if (p) { p.box.classList.toggle("camera-off", !v.camera); p.status.textContent = `${v.camera ? "Caméra active" : "Caméra coupée"} · ${v.mic ? "Micro actif" : "Micro coupé"}`; } }));
      bind("live-ended", () => { leave(false); notify("Vous avez quitté la visio"); });
      bind("disconnect", () => { leave(false); notify("Visio interrompue. Rejoignez-la après la reconnexion."); });
      const result = await new Promise((resolve, reject) => socket.timeout(8000).emit("live-join", { scope: nextScope }, (e, r) => e ? reject(new Error("La visio ne répond pas")) : resolve(r)));
      if (attempt !== revision) { socket.emit("live-leave"); return; }
      if (!result?.ok) throw new Error(result?.error || "Visio indisponible");
      stream = new MediaStream(); scope = nextScope; panel.hidden = false; $("[data-title]").textContent = title;
      $("[data-status]").textContent = "4 participants maximum · activez vos médias quand vous le souhaitez";
      local = tile(socket.id, "Vous", true); local.video.srcObject = stream; tellState();
      for (const p of result.peers) createPeer(p);
      ready = true; for (const deliver of pending) deliver();
    } catch (e) { if (attempt === revision) { leave(); notify(e.message); } } finally { joining = false; }
  }
  async function toggle(kind) {
    if (!scope || mediaBusy) return;
    const attempt = revision; mediaBusy = true;
    $("[data-camera]").disabled = true; $("[data-mic]").disabled = true;
    try {
      const old = stream.getTracks().find(t => t.kind === kind);
      if (old) {
        old.stop(); stream.removeTrack(old);
        await Promise.allSettled([...peers.values()].map(p => (kind === "audio" ? p.audio : p.videoSender)?.replaceTrack(null)));
        if (attempt !== revision) return;
        if (kind === "audio") mic = false; else camera = false; tellState(); return;
      }
      const input = await navigator.mediaDevices.getUserMedia(kind === "audio" ? { audio: { echoCancellation: true, noiseSuppression: true } } : { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 } } });
      if (attempt !== revision || !scope) { input.getTracks().forEach(t => t.stop()); return; }
      const track = input.getTracks()[0]; stream.addTrack(track); local.video.srcObject = stream;
      await Promise.allSettled([...peers.values()].map(p => (kind === "audio" ? p.audio : p.videoSender)?.replaceTrack(track)));
      if (attempt !== revision) { track.stop(); return; }
      track.onended = () => { if (attempt !== revision) return; stream?.removeTrack(track); if (kind === "audio") mic = false; else camera = false; tellState(); };
      if (kind === "audio") mic = true; else camera = true; tellState();
    } catch (e) { notify(e.name === "NotAllowedError" ? "Autorisez le micro ou la caméra dans votre navigateur" : "Ce périphérique est indisponible"); }
    finally { if (attempt === revision) { mediaBusy = false; $("[data-camera]").disabled = false; $("[data-mic]").disabled = false; } }
  }
  $("[data-close]").onclick = () => leave();
  $("[data-camera]").onclick = () => toggle("video").catch(e => notify(e.message));
  $("[data-mic]").onclick = () => toggle("audio").catch(e => notify(e.message));
  $("[data-small]").onclick = () => { panel.classList.toggle("compact"); $("[data-small]").textContent = panel.classList.contains("compact") ? "Agrandir" : "Réduire"; };
  window.addEventListener("pagehide", () => leave());
  return { join, leave, get scope() { return scope; } };
}
