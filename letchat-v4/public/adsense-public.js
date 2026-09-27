const CLIENT = "ca-pub-3317597986908171";
const SLOT = "1411415827";

// We request only non-personalized ads. Google also validates the full TCF
// string; refusal of storage or Google as a vendor never produces a request.
export function consentAllowsAds(data, success) {
  if (!success || !data || data.cmpStatus !== "loaded") return false;
  if (!["tcloaded", "useractioncomplete"].includes(data.eventStatus)) return false;
  if (data.gdprApplies === false) return true;
  return data.gdprApplies === true &&
    data.purpose?.consents?.[1] === true && data.vendor?.consents?.[755] === true;
}

export function createPublicAdvertising({ window: w, checkEligibility, nonce }) {
  const d = w.document;
  const container = d.getElementById("publicAdvertising");
  const status = d.getElementById("consentStatus");
  const button = d.getElementById("manageConsent");
  let eligible = false, consent = false, loaded = false, requested = false;
  let editing = false, revision = 0, stopped = false, observer, timer, timedOut = false;
  const allowedPage = w.location.pathname === "/decouvrir.html";
  const queue = () => (w.adsbygoogle = w.adsbygoogle || []);
  const message = text => { if (status) status.textContent = text; };

  function pause() {
    consent = false;
    if (w.adsbygoogle) w.adsbygoogle.pauseAdRequests = 1;
    observer?.disconnect();
    w.clearTimeout(timer);
    if (container) { container.hidden = true; container.replaceChildren(); }
  }

  function requestAd() {
    if (!eligible || !consent || requested || stopped || !allowedPage || !container) return;
    requested = true; // One ad request per document, with no automatic refresh.
    const label = d.createElement("p");
    label.className = "advertising-label";
    label.textContent = "Publicités";
    const ad = d.createElement("ins");
    ad.className = "adsbygoogle";
    ad.style.display = "block";
    ad.dataset.adClient = CLIENT;
    ad.dataset.adSlot = SLOT;
    ad.dataset.adFormat = "auto";
    ad.dataset.fullWidthResponsive = "true";
    container.replaceChildren(label, ad);
    container.hidden = false;
    observer = new w.MutationObserver(() => {
      if (!consent || !eligible || stopped) return;
      if (ad.dataset.adStatus === "unfilled") container.hidden = true;
      if (ad.dataset.adStatus === "filled") container.hidden = false;
    });
    observer.observe(ad, { attributes: true, attributeFilter: ["data-ad-status"] });
    // An unapproved site, unavailable inventory or a blocker must not leave
    // a permanent empty advertising panel.
    timer = w.setTimeout(() => {
      if (ad.dataset.adStatus !== "filled") { timedOut = true; container.hidden = true; }
    }, 15000);
    try {
      queue().pauseAdRequests = 0;
      queue().push({ params: { google_privacy_treatments: "disablePersonalization" } });
    } catch {
      pause();
      message("Publicité indisponible. Vous pouvez continuer à lire cette page.");
    }
  }

  function onConsent(data, success) {
    if (stopped) return;
    // Opening settings revokes the permission to request/display an ad until
    // an explicit new user choice, even if an old tcloaded callback arrives.
    if (editing && data?.eventStatus !== "useractioncomplete") { pause(); return; }
    if (data?.eventStatus === "useractioncomplete") editing = false;
    const allowed = consentAllowsAds(data, success);
    if (!allowed) {
      pause();
      message(data?.eventStatus === "cmpuishown"
        ? "Choisissez vos préférences dans le message de confidentialité."
        : "Aucune annonce n’est demandée sans les autorisations nécessaires.");
      return;
    }
    consent = true;
    message("Vos choix de confidentialité sont enregistrés. Vous pouvez les modifier ici.");
    requestAd();
  }

  function loadGoogle() {
    if (loaded || stopped || !allowedPage || !nonce) return;
    loaded = true;
    queue().pauseAdRequests = 1;
    w.googlefc = w.googlefc || {};
    w.googlefc.callbackQueue = w.googlefc.callbackQueue || [];
    w.googlefc.callbackQueue.push({ CONSENT_API_READY: () => {
      if (stopped) return;
      if (typeof w.__tcfapi !== "function") {
        message("Le service de consentement est indisponible. Aucune annonce n’est demandée.");
        return;
      }
      w.__tcfapi("addEventListener", 2, onConsent);
    } });
    const script = d.createElement("script");
    script.id = "letchatAdSense";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.nonce = nonce;
    script.dataset.privacyTreatments = "disablePersonalization";
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT}`;
    script.onerror = () => {
      pause();
      message("Le service de confidentialité est indisponible ou bloqué. Aucune annonce n’est affichée.");
    };
    d.head.append(script);
  }

  function manageConsent() {
    if (!allowedPage || stopped) return;
    editing = true;
    pause();
    message("Ouverture de vos choix de confidentialité…");
    loadGoogle(); // Also permits a Premium member to revoke a previous choice.
    w.googlefc?.callbackQueue.push({ CONSENT_API_READY: () => {
      if (stopped) return;
      if (typeof w.googlefc.showRevocationMessage === "function") w.googlefc.showRevocationMessage();
      else message("Le service de confidentialité est indisponible. Réessayez plus tard.");
    } });
  }

  async function start() {
    if (!allowedPage || !nonce) return;
    button?.addEventListener("click", manageConsent);
    await recheck();
    if (!stopped && w.location.hash === "#consentement") manageConsent();
  }

  function suspend() {
    revision++;
    eligible = false;
    if (w.adsbygoogle) w.adsbygoogle.pauseAdRequests = 1;
    if (container) container.hidden = true;
  }

  async function recheck() {
    if (!allowedPage || !nonce || stopped) return;
    suspend();
    const current = ++revision;
    let result = false;
    try { result = await checkEligibility() === true; } catch {}
    if (current !== revision || stopped) return;
    eligible = result;
    if (eligible) {
      loadGoogle();
      if (consent) {
        if (!requested) requestAd();
        else {
          const ad = container?.querySelector("ins");
          if (ad && (ad.dataset.adStatus === "filled" || (!timedOut && ad.dataset.adStatus !== "unfilled"))) {
            container.hidden = false;
            queue().pauseAdRequests = 0;
          }
        }
      }
    } else {
      pause();
      message("Cette page s’affiche sans publicité pour votre session.");
    }
  }

  function stop() {
    stopped = true;
    revision++;
    eligible = false;
    pause();
    button?.removeEventListener("click", manageConsent);
  }

  return { start, stop, suspend, recheck };
}
