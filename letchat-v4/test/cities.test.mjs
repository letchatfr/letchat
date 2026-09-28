import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createCityIndex, findCities } from "../public/city-search.js";
import { CITY_DATA_URL } from "../public/city-autocomplete.js";

const rows = JSON.parse(await readFile(`public${CITY_DATA_URL}`, "utf8"));
const index = createCityIndex(rows);
const source = (await readFile("public/city-autocomplete.js", "utf8"))
  .replace(/^import .*;\s*$/gm, "").replace(/^export /gm, "");
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, fetchData = async () => rows) {
  const html = await readFile("public/index.html", "utf8");
  const dom = new JSDOM(html, { url: "https://www.letchat.fr", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, doc = w.document, calls = [];
  w.createCityIndex = createCityIndex; w.findCities = findCities;
  w.normalizeCity = (await import("../public/city-search.js")).normalizeCity;
  w.fetch = async url => { calls.push(url); return { ok: true, json: fetchData }; };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(source);
  const input = doc.querySelector("#guestCity");
  doc.querySelector("#guestLoginForm").classList.remove("hidden");
  function type(value, field = input) {
    field.focus(); field.value = value;
    field.dispatchEvent(new w.Event("input", { bubbles: true }));
  }
  function key(key, field = input) { return field.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }
  return { w, doc, calls, input, type, key, panel: doc.querySelector(".city-suggestions"), options: () => [...doc.querySelectorAll('[role="option"]')] };
}

test("official catalogue finds partial names, accents, apostrophes, postal codes and overseas communes", () => {
  assert.ok(rows.length > 34000);
  assert.equal(findCities(index, "mont")[0].name, "Montpellier");
  assert.equal(findCities(index, "EVRY")[0].name, "Évry-Courcouronnes");
  assert.equal(findCities(index, "l hay")[0].name, "L'Haÿ-les-Roses");
  assert.equal(findCities(index, "340")[0].name, "Montpellier");
  assert.equal(findCities(index, "97300")[0].name, "Cayenne");
  const denis = findCities(index, "st denis");
  assert.ok(denis.some(city => city.department === "93"));
  assert.ok(denis.some(city => city.department === "974"));
  assert.equal(findCities(index, "m").length, 0);
  assert.equal(findCities(index, "mont").length, 8);
});

test("suggestions load only after two characters, once, without sending typed text", async t => {
  const s = await setup(t);
  s.type("m"); await tick(120);
  assert.equal(s.calls.length, 0);
  s.type("Mont"); await tick(130);
  assert.equal(s.input.value, "Mont", "typing must not silently replace a value");
  assert.equal(s.input.getAttribute("aria-expanded"), "true");
  assert.equal(s.options()[0].querySelector("strong").textContent, "Montpellier");
  s.type("Paris"); await tick(130);
  assert.deepEqual(s.calls, [CITY_DATA_URL]);
  assert.equal(s.options()[0].querySelector("strong").textContent, "Paris");
});

test("keyboard selection fills only the name, refreshes filters and does not submit the form", async t => {
  const s = await setup(t); let changes = 0, submissions = 0, searches = 0;
  s.input.onkeydown = event => { if (event.key === "Enter") searches++; };
  s.input.addEventListener("change", () => changes++);
  s.input.form.addEventListener("submit", event => { event.preventDefault(); submissions++; });
  s.type("Mont"); await tick(130);
  assert.equal(s.key("ArrowDown"), false);
  assert.ok(s.input.hasAttribute("aria-activedescendant"));
  assert.equal(s.key("Enter"), false);
  assert.equal(s.input.value, "Montpellier");
  assert.equal(changes, 1); assert.equal(submissions, 0);
  assert.equal(searches, 0, "selection must precede the existing admin Enter shortcut");
  assert.equal(s.doc.activeElement, s.input);
  assert.equal(s.input.getAttribute("aria-expanded"), "false");
  assert.equal(s.panel.hidden, true);
  s.key("Enter"); assert.equal(searches, 1, "normal Enter handling is restored after selection");
});

test("mouse/touch click selects a city, including an option nested inside a dialog", async t => {
  const s = await setup(t);
  const dialog = s.doc.createElement("dialog"); dialog.open = true;
  dialog.innerHTML = '<form><label>Ville<input name="city" data-city-autocomplete></label></form>';
  s.doc.body.append(dialog); await tick(0);
  const input = dialog.querySelector("input");
  s.type("973", input); await tick(130);
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(s.panel.parentElement, dialog);
  s.options()[0].querySelector("strong").click();
  assert.equal(input.value, "Cayenne");
  assert.equal(s.panel.hidden, true);
});

test("Escape, Tab, short input and closing the parent dismiss without overwriting text", async t => {
  const s = await setup(t);
  for (const key of ["Escape", "Tab"]) {
    s.type("Mont"); await tick(130); s.key("ArrowDown"); s.key(key);
    assert.equal(s.panel.hidden, true); assert.equal(s.input.value, "Mont");
  }
  s.type("Mont"); await tick(130); s.type("M");
  assert.equal(s.panel.hidden, true);
  s.type("Mont"); await tick(130); s.input.form.classList.add("hidden"); await tick(0);
  assert.equal(s.panel.hidden, true);
});

test("late catalogue results cannot reopen a dismissed list or replace a newer query", async t => {
  let release;
  const s = await setup(t, () => new Promise(resolve => { release = resolve; }));
  s.type("Mont"); await tick(120);
  s.type("Paris"); await tick(120);
  release(rows); await tick(20);
  assert.equal(s.options()[0].querySelector("strong").textContent, "Paris");
  s.key("Escape"); await tick(20);
  assert.equal(s.panel.hidden, true);
});

test("unavailable catalogue and foreign cities still allow free typing; a failed load can retry", async t => {
  let attempt = 0;
  const s = await setup(t, async () => { if (++attempt === 1) throw new Error("offline"); return rows; });
  s.type("Montréal"); await tick(130);
  assert.match(s.panel.textContent, /indisponibles/);
  assert.equal(s.input.value, "Montréal");
  s.type("Montp"); await tick(130);
  assert.equal(s.options()[0].querySelector("strong").textContent, "Montpellier");
  s.type("Tokyo"); await tick(130);
  assert.equal(s.options().length, 0); assert.equal(s.input.value, "Tokyo");
});

test("suggestions insert text safely, with no HTML interpretation", async t => {
  const s = await setup(t, async () => [['Ville <img src=x onerror=alert(1)>', '99', '99000']]);
  s.type("Ville"); await tick(130);
  assert.equal(s.panel.querySelector("img"), null);
  assert.match(s.options()[0].textContent, /<img/);
});
