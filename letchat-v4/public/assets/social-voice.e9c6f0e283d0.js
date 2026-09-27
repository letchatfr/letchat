export const blobBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]);
  reader.onerror = () => reject(new Error("Lecture du fichier impossible")); reader.readAsDataURL(blob);
});

// One recording at a time. Closing at any point, including during permission,
// stops tracks; nothing is uploaded before explicit confirmation.
export function createVoiceRecorder() {
  const dialog = document.createElement("dialog");
  dialog.className = "social-dialog social-recorder";
  dialog.innerHTML = `<div class="social-top"><h2>Message vocal</h2><button type="button" data-cancel aria-label="Fermer">×</button></div>
    <p data-status role="status">Enregistrez puis écoutez votre message avant de l’envoyer.</p>
    <strong class="social-timer" data-timer>00:00</strong><audio controls data-preview hidden></audio>
    <div class="social-actions"><button type="button" data-record>Enregistrer</button><button type="button" data-stop hidden>Arrêter et écouter</button>
    <button type="button" data-use hidden>Utiliser ce vocal</button><button type="button" data-cancel>Annuler</button></div>`;
  document.body.append(dialog);
  const $ = q => dialog.querySelector(q);
  let recorder, stream, timer, chunks = [], blob, url, resolver, epoch = 0, maximum = 120, busy = false;
  const tracksStop = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; clearInterval(timer); };
  function finish(value) {
    epoch++; tracksStop();
    if (recorder?.state === "recording") { recorder.onstop = null; recorder.stop(); }
    recorder = null; $("[data-preview]").pause(); $("[data-preview]").removeAttribute("src");
    if (url) URL.revokeObjectURL(url); url = null; blob = null; busy = false;
    const done = resolver; resolver = null; if (dialog.open) dialog.close(); done?.(value);
  }
  async function record() {
    if (busy || recorder?.state === "recording") return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { $("[data-status]").textContent = "Votre navigateur ne permet pas l’enregistrement. Essayez Chrome, Firefox ou Safari récent."; return; }
    busy = true; const request = ++epoch;
    $("[data-record]").disabled = true;
    $("[data-status]").textContent = "Autorisez le microphone…";
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (request !== epoch || !dialog.open) { input.getTracks().forEach(t => t.stop()); return; }
      stream = input; chunks = []; blob = null;
      if (url) URL.revokeObjectURL(url); url = null;
      $("[data-preview]").hidden = true; $("[data-use]").hidden = true;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(t => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : {});
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { tracksStop(); $("[data-status]").textContent = "Enregistrement interrompu. Réessayez."; $("[data-record]").hidden = false; $("[data-stop]").hidden = true; };
      recorder.onstop = () => {
        tracksStop(); if (request !== epoch) return;
        blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        $("[data-record]").hidden = false; $("[data-stop]").hidden = true;
        $("[data-record]").textContent = "Réenregistrer";
        if (!blob.size || blob.size > 2000000) { blob = null; $("[data-status]").textContent = "Enregistrement vide ou trop long. Réessayez."; return; }
        url = URL.createObjectURL(blob); $("[data-preview]").src = url;
        $("[data-preview]").hidden = false; $("[data-use]").hidden = false;
        $("[data-status]").textContent = "Écoutez votre vocal. Vous pouvez le refaire ou le valider.";
      };
      recorder.start(250); const began = Date.now();
      $("[data-record]").hidden = true; $("[data-stop]").hidden = false;
      $("[data-status]").textContent = `Enregistrement en cours · ${maximum} secondes maximum`;
      $("[data-timer]").textContent = "00:00";
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - began) / 1000);
        $("[data-timer]").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        if (s >= maximum && recorder.state === "recording") recorder.stop();
      }, 250);
    } catch (e) { tracksStop(); if (request === epoch) $("[data-status]").textContent = e.name === "NotAllowedError" ? "Microphone refusé. Autorisez-le dans les réglages du navigateur." : "Microphone indisponible."; }
    finally { if (request === epoch) { busy = false; $("[data-record]").disabled = false; } }
  }
  $("[data-record]").onclick = record;
  $("[data-stop]").onclick = () => { if (recorder?.state === "recording") recorder.stop(); };
  $("[data-use]").onclick = () => { if (blob) finish(blob); };
  dialog.querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => finish(null));
  dialog.addEventListener("cancel", e => { e.preventDefault(); finish(null); });
  dialog.addEventListener("close", () => { if (resolver) finish(null); });
  window.addEventListener("pagehide", () => finish(null));
  return {
    open({ title = "Message vocal", seconds = 120 } = {}) {
      finish(null); maximum = seconds;
      dialog.querySelector("h2").textContent = title;
      $("[data-record]").hidden = false; $("[data-record]").disabled = false; $("[data-record]").textContent = "Enregistrer";
      $("[data-stop]").hidden = true; $("[data-use]").hidden = true; $("[data-preview]").hidden = true;
      $("[data-timer]").textContent = "00:00"; $("[data-status]").textContent = "Enregistrez puis écoutez avant de valider.";
      dialog.showModal(); return new Promise(resolve => { resolver = resolve; });
    }, cancel() { finish(null); }
  };
}
