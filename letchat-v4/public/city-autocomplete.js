import { createCityIndex, findCities, normalizeCity } from "./city-search.js";

// Official French communes snapshot, downloaded once on first use. Typed text
// stays in the browser: no geolocation and no request to an external service.
export const CITY_DATA_URL = "/cities-fr.f51b6d69480c.json";
let cityIndexPromise;
export function loadCityIndex() {
  if (!cityIndexPromise) cityIndexPromise = fetch(CITY_DATA_URL)
    .then(response => {
      if (!response.ok) throw new Error("Villes indisponibles");
      return response.json();
    }).then(createCityIndex).catch(error => { cityIndexPromise = null; throw error; });
  return cityIndexPromise;
}

export function installCityAutocomplete(doc = document, load = loadCityIndex) {
  const win = doc.defaultView, selector = "input[data-city-autocomplete]", bound = new WeakSet();
  const panel = doc.createElement("div");
  panel.className = "city-suggestions";
  panel.setAttribute("popover", "manual");
  panel.hidden = true;
  const list = doc.createElement("ul");
  list.id = "letchat-city-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Suggestions de villes");
  const note = doc.createElement("div");
  note.className = "city-suggestions-note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  panel.append(list, note);
  doc.body.append(panel);
  let active = null, results = [], selected = -1, revision = 0, timer, selecting = false;

  function hide() {
    revision++;
    win.clearTimeout(timer);
    if (active) {
      active.setAttribute("aria-expanded", "false");
      active.removeAttribute("aria-activedescendant");
    }
    try { panel.hidePopover?.(); } catch { /* Fallback for older browsers. */ }
    if (!panel.hidden) panel.hidden = true;
    active = null;
    results = []; selected = -1;
  }

  function position() {
    if (panel.hidden || !active) return;
    if (!active.isConnected || active.closest("[hidden],.hidden,dialog:not([open])")) { hide(); return; }
    const rect = active.getBoundingClientRect(), viewport = win.visualViewport;
    const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0;
    const height = viewport?.height || win.innerHeight, width = viewport?.width || win.innerWidth;
    if (rect.bottom < top || rect.top > top + height) { hide(); return; }
    const below = top + height - rect.bottom - 10, above = rect.top - top - 10;
    const upward = below < 180 && above > below;
    const available = Math.max(60, Math.min(350, upward ? above : below));
    panel.style.width = `${Math.min(Math.max(rect.width, 230), width - 20)}px`;
    panel.style.maxHeight = `${available}px`;
    panel.style.left = `${Math.max(left + 10, Math.min(rect.left, left + width - panel.offsetWidth - 10))}px`;
    panel.style.top = `${upward ? Math.max(top + 10, rect.top - panel.offsetHeight - 5) : rect.bottom + 5}px`;
  }

  function show(message) {
    if (!active?.isConnected) return;
    const owner = active.closest("dialog") || doc.body;
    if (panel.parentNode !== owner) owner.append(panel);
    note.textContent = message;
    panel.hidden = false;
    try { if (!panel.matches(":popover-open")) panel.showPopover?.(); } catch { /* Fixed-position fallback. */ }
    active.setAttribute("aria-expanded", "true");
    position();
  }

  function paint(items) {
    results = items; selected = -1;
    active.removeAttribute("aria-activedescendant");
    list.replaceChildren(...items.map((city, i) => {
      const item = doc.createElement("li");
      item.id = `letchat-city-option-${i}`;
      item.dataset.cityIndex = String(i);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      const name = doc.createElement("strong"), detail = doc.createElement("span");
      name.textContent = city.name;
      detail.textContent = city.postcodes.length ? city.postcodes.slice(0, 3).join(" · ") + (city.postcodes.length > 3 ? "…" : "") : `Département ${city.department}`;
      detail.title = city.postcodes.join(" · ");
      item.append(name, detail);
      return item;
    }));
    show(items.length ? "Villes françaises · Vous pouvez aussi saisir une autre ville." : "Aucune ville proposée. Vous pouvez continuer votre saisie.");
  }

  function schedule(input) {
    if (selecting) return;
    hide(); active = input;
    const value = input.value;
    if (normalizeCity(value).length < 2) return;
    const ticket = revision;
    timer = win.setTimeout(async () => {
      list.replaceChildren();
      show("Chargement des villes…");
      try {
        const index = await load();
        if (ticket !== revision || doc.activeElement !== input || !input.isConnected) return;
        paint(findCities(index, value));
      } catch {
        if (ticket === revision && doc.activeElement === input) show("Suggestions indisponibles. Saisissez votre ville librement.");
      }
    }, 100);
  }

  function choose(index) {
    const city = results[index], input = active;
    if (!city || !input) return;
    selecting = true;
    hide();
    input.value = city.name;
    input.focus({ preventScroll: true });
    // Notify the existing directory filters and forms, without submitting them.
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    selecting = false;
  }

  function keydown(event) {
    if (event.isComposing || panel.hidden || active !== event.target) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); }
    else if (event.key === "Tab") hide();
    else if (results.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      selected = event.key === "ArrowDown" ? (selected + 1) % results.length : selected <= 0 ? results.length - 1 : selected - 1;
      [...list.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === selected)));
      active.setAttribute("aria-activedescendant", list.children[selected].id);
      list.children[selected].scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && selected >= 0) {
      event.preventDefault(); event.stopImmediatePropagation(); choose(selected);
    }
  }

  function attach(input) {
    if (bound.has(input)) return;
    bound.add(input);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.addEventListener("input", event => { if (!event.isComposing) schedule(input); });
    input.addEventListener("focus", () => schedule(input));
    input.addEventListener("click", () => { if (panel.hidden) schedule(input); });
    input.addEventListener("compositionend", () => schedule(input));
    input.addEventListener("keydown", keydown, true);
    input.addEventListener("blur", () => win.setTimeout(() => {
      if (active === input && doc.activeElement !== input) hide();
    }, 0));
  }
  function scan(root) {
    if (root.nodeType !== 1 && root !== doc) return;
    if (root.matches?.(selector)) attach(root);
    root.querySelectorAll(selector).forEach(attach);
  }
  scan(doc);
  const observer = new win.MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) scan(node);
    if (active && (!active.isConnected || active.closest("[hidden],.hidden,dialog:not([open])"))) hide();
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "open"] });
  panel.addEventListener("mousedown", event => event.preventDefault());
  panel.addEventListener("click", event => {
    const item = event.target.closest("[data-city-index]");
    if (item) { event.preventDefault(); choose(Number(item.dataset.cityIndex)); }
  });
  doc.addEventListener("pointerdown", event => { if (event.target !== active && !panel.contains(event.target)) hide(); });
  doc.addEventListener("scroll", event => { if (!panel.contains(event.target)) position(); }, true);
  win.addEventListener("resize", position);
  win.visualViewport?.addEventListener("resize", position);
  win.visualViewport?.addEventListener("scroll", position);
  return { hide };
}

if (typeof document !== "undefined") installCityAutocomplete();
