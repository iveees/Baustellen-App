"use strict";
// Baustellen-Doku – Android-App. Daten liegen lokal und in Dropbox:
//   <gemeinsamer App-Ordner>/Adressbuch.json, Baustellen.json, Einstellungen.json
//   <Projekt>/Baustelle/Baustellen-Doku.json, Fotos/, Berichte/

const { registerPlugin, Capacitor } = window.capacitorExports;
const NATIVE = Capacitor.isNativePlatform();
const Camera = registerPlugin("Camera");
const Filesystem = registerPlugin("Filesystem");
const Browser = registerPlugin("Browser");
const AppP = registerPlugin("App");
const Network = registerPlugin("Network");
const Speech = registerPlugin("SpeechRecognition");
const Mail = registerPlugin("Mail");
const DATA = "DATA";

// ---------- Zustand ----------
const S = {
  kontakte: [], baustellen: [], einst: [], eintraege: {},   // geteilt (Dropbox)
  lokal: {},        // Fotoname -> lokaler Pfad (nur dieses Gerät)
  queue: [],        // Uploads: {art:"foto"|"pdf", bid, name, lokal}
  auth: null, appOrdner: null, letzterSync: 0, syncFehler: "",
};
const V = { tab: "eintraege", filter: "offen", search: "", online: true, syncing: false, dataUri: "" };
const ART = ["Mangel", "Aufgabe", "Notiz"];
const $app = document.getElementById("app");
const $panel = document.getElementById("panel");
const $sheet = document.getElementById("sheet");

// ---------- Helfer ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const fmtDate = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
const fmtDT = (ts) => { const d = new Date(ts); return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) + " " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); };
const telHref = (nr) => "tel:" + String(nr).replace(/[^\d+]/g, "");
const firstMail = (k) => (k && (k.email?.[0] || k.pec?.[0])) || "";
const slug = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
const live = (arr) => arr.filter((x) => !x.geloescht);
const einst = () => S.einst.find((x) => x.id === "allgemein") || {};
function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2800); }
function sortKontakte(arr) { return arr.slice().sort((a, b) => ((a.gruppe === "Techniker" ? 0 : 1) - (b.gruppe === "Techniker" ? 0 : 1)) || a.gewerk.localeCompare(b.gewerk, "de") || a.firma.localeCompare(b.firma, "de")); }
function groupBy(arr, key) { const m = new Map(); for (const x of arr) { const k = x[key] || "Sonstige"; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
function route() { const h = location.hash.slice(1); if (h.startsWith("b-")) return { name: "baustelle", id: h.slice(2) }; if (h === "adressbuch" || h === "einstellungen") return { name: h }; return { name: "start" }; }
const kontakt = (id) => S.kontakte.find((k) => k.id === id && !k.geloescht);
const baustelle = (id) => S.baustellen.find((b) => b.id === id && !b.geloescht);
const eintraegeVon = (bid) => live(S.eintraege[bid] || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
const beteiligte = (b) => sortKontakte((b?.beteiligte || []).map(kontakt).filter(Boolean));
function upsert(arr, rec) { rec.geaendert = Date.now(); const i = arr.findIndex((x) => x.id === rec.id); if (i >= 0) arr[i] = rec; else arr.push(rec); }
const fileSrc = (rel) => Capacitor.convertFileSrc(V.dataUri + "/" + rel);
const absPath = (rel) => V.dataUri.replace(/^file:\/\//, "") + "/" + rel;

// ---------- Lokaler Speicher ----------
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await Filesystem.writeFile({ path: "state.json", directory: DATA, data: JSON.stringify(S), encoding: "utf8" }); } catch (e) { console.error(e); }
  }, 300);
}
async function load() {
  try { const r = await Filesystem.readFile({ path: "state.json", directory: DATA, encoding: "utf8" }); Object.assign(S, JSON.parse(r.data)); } catch {}
  for (const d of ["fotos", "pdf", "cache"]) { try { await Filesystem.mkdir({ path: d, directory: DATA, recursive: true }); } catch {} }
  try { V.dataUri = (await Filesystem.getUri({ path: "", directory: DATA })).uri.replace(/\/$/, ""); } catch {}
  Dropbox.auth = S.auth;
}
function changed() { persist(); render(); scheduleSync(); }

// ---------- Synchronisierung ----------
function merge(local, remote) {
  const m = new Map();
  for (const r of remote || []) m.set(r.id, r);
  for (const l of local || []) { const r = m.get(l.id); if (!r || (l.geaendert || 0) > (r.geaendert || 0)) m.set(l.id, l); }
  return [...m.values()];
}
const canon = (arr) => JSON.stringify(arr.slice().sort((a, b) => (a.id < b.id ? -1 : 1)));
async function syncDoc(path, get, set, seed) {
  const blob = await Dropbox.download(path);
  let remote = null;
  if (blob) { try { remote = JSON.parse(await blob.text()).records || []; } catch { remote = []; } }
  let local = get();
  if (!remote && !local.length && seed) local = seed;
  const merged = merge(local, remote || []);
  set(merged);
  if (!remote || canon(merged) !== canon(remote)) {
    await Dropbox.upload(path, new Blob([JSON.stringify({ app: "Baustellen-Doku", version: 1, records: merged }, null, 1)], { type: "application/json" }));
  }
}
const bPath = (b, sub) => Dropbox.refPath(b.ordner, sub);
const appPath = (sub) => Dropbox.refPath(S.appOrdner, sub);

let syncTimer = null, syncAgain = false;
function scheduleSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (!S.auth || !S.appOrdner || !V.online) { renderSync(); return; }
  if (V.syncing) { syncAgain = true; return; }
  V.syncing = true; renderSync();
  try {
    await syncDoc(appPath("/Adressbuch.json"), () => S.kontakte, (v) => (S.kontakte = v), window.START_KONTAKTE || []);
    await syncDoc(appPath("/Baustellen.json"), () => S.baustellen, (v) => (S.baustellen = v));
    await syncDoc(appPath("/Einstellungen.json"), () => S.einst, (v) => (S.einst = v));
    for (const b of live(S.baustellen)) {
      if (!b.ordner) continue;
      await syncDoc(bPath(b, "/Baustellen-Doku.json"), () => S.eintraege[b.id] || [], (v) => (S.eintraege[b.id] = v));
    }
    await uploadQueue();
    S.letzterSync = Date.now(); S.syncFehler = "";
  } catch (e) {
    console.error(e);
    S.syncFehler = e.status === 401 ? "Dropbox-Anmeldung abgelaufen – bitte neu anmelden" : e.notFound ? "Ordner in Dropbox nicht gefunden: " + (e.summary || "") : "Synchronisieren fehlgeschlagen (" + (e.message || e) + ")";
  } finally {
    V.syncing = false; persist(); render();
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}
async function uploadQueue() {
  const rest = [];
  for (const q of S.queue) {
    const b = baustelle(q.bid);
    if (!b?.ordner) { rest.push(q); continue; }
    try {
      const blob = await (await fetch(fileSrc(q.lokal))).blob();
      const sub = q.art === "pdf" ? "/Berichte/" : "/Fotos/";
      await Dropbox.upload(bPath(b, sub + q.name), blob);
    } catch (e) { if (e.status) rest.push(q); else console.warn("Datei fehlt", q); }
  }
  S.queue = rest;
}

// Fotos des Partners: Vorschau aus Dropbox laden
const thumbCache = new Map();
async function fillRemoteThumbs() {
  for (const img of document.querySelectorAll("img[data-remote]")) {
    const key = img.dataset.remote;
    if (thumbCache.has(key)) { img.src = thumbCache.get(key); continue; }
    const [bid, name] = key.split("|"); const b = baustelle(bid);
    if (!b?.ordner || !S.auth || !V.online) continue;
    try { const bl = await Dropbox.thumbnail(bPath(b, "/Fotos/" + name)); if (bl) { const u = URL.createObjectURL(bl); thumbCache.set(key, u); img.src = u; } } catch {}
  }
}
function fotoImg(bid, name, cls = "") {
  if (S.lokal[name]) return `<img class="${cls}" src="${esc(fileSrc(S.lokal[name]))}" alt="" loading="lazy">`;
  return `<img class="${cls}" data-remote="${esc(bid + "|" + name)}" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
}
async function ensureLocal(bid, name) {
  if (S.lokal[name]) return S.lokal[name];
  const b = baustelle(bid);
  const bl = await Dropbox.download(bPath(b, "/Fotos/" + name));
  if (!bl) throw new Error("Foto nicht gefunden: " + name);
  const rel = "fotos/" + name;
  await Filesystem.writeFile({ path: rel, directory: DATA, data: await blobToB64(bl) });
  S.lokal[name] = rel; persist();
  return rel;
}
const blobToB64 = (bl) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(bl); });

// ---------- Render ----------
function renderSync() {
  const el = document.getElementById("syncbar"); if (!el) return;
  el.innerHTML = syncHtml();
}
function syncHtml() {
  let cls = "", txt;
  if (!S.auth) { cls = "err"; txt = "Nicht mit Dropbox verbunden"; }
  else if (!V.online) { cls = "warn"; txt = "Offline – wird später hochgeladen" + (S.queue.length ? ` (${S.queue.length} Dateien)` : ""); }
  else if (V.syncing) { cls = "warn"; txt = "Synchronisiere …"; }
  else if (S.syncFehler) { cls = "err"; txt = S.syncFehler; }
  else txt = S.letzterSync ? "Mit Dropbox abgeglichen " + new Date(S.letzterSync).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "Noch nicht abgeglichen";
  return `<span class="dot ${cls}"></span><span style="flex:1">${esc(txt)}</span><button class="btn" style="min-height:36px;padding:4px 10px" data-act="sync">↻</button>`;
}
function render() {
  const r = route();
  document.querySelectorAll("#nav a").forEach((a) => a.setAttribute("aria-current", (a.dataset.nav === r.name || (r.name === "baustelle" && a.dataset.nav === "start")) ? "page" : "false"));
  let html;
  if (!window.DROPBOX_APP_KEY) html = `<div class="banner">Diese Version hat noch keinen Dropbox-Schlüssel eingetragen.</div>`;
  else if (!S.auth) html = viewLogin();
  else if (!S.appOrdner) html = viewSetup();
  else if (r.name === "baustelle") html = viewBaustelle(r.id);
  else if (r.name === "adressbuch") html = viewAdressbuch();
  else if (r.name === "einstellungen") html = viewSettings();
  else html = viewStart();
  $app.innerHTML = (S.auth && S.appOrdner ? `<div class="syncbar" id="syncbar">${syncHtml()}</div>` : "") + html;
  document.getElementById("nav").style.display = S.auth && S.appOrdner ? "" : "none";
  const s = document.getElementById("search"); if (s && V.focusSearch) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  fillRemoteThumbs();
}

function viewLogin() {
  return `<h1>Baustellen-Doku</h1>
  <div class="card stack"><div>Melde dich mit deinem Dropbox-Konto an. Die App speichert Fotos und Einträge in euren Projektordnern.</div>
  <button class="btn primary big" data-act="login">Mit Dropbox anmelden</button></div>`;
}
function viewSetup() {
  return `<h1>Gemeinsamer App-Ordner</h1>
  <div class="card stack"><div>Wähle den Ordner, in dem Adressbuch und Baustellenliste liegen sollen. <b>Dein Partner muss genau denselben, mit ihm geteilten Ordner wählen.</b></div>
  <div class="hint">Tipp: Lege in Dropbox einen Ordner „Baustellen-App“ an und teile ihn mit deinem Partner.</div>
  <button class="btn primary big" data-act="pick-appordner">Ordner wählen</button>
  <div class="hint">Angemeldet als ${esc(S.auth.name || S.auth.email || "")} · <a href="#" data-act="logout">abmelden</a></div></div>`;
}

function viewStart() {
  const list = live(S.baustellen).sort((a, b) => ((a.status === "abgeschlossen") - (b.status === "abgeschlossen")) || (b.erstellt || 0) - (a.erstellt || 0));
  const cards = list.map((b) => {
    const es = eintraegeVon(b.id); const offen = es.filter((e) => e.status !== "erledigt").length;
    return `<a class="card" href="#b-${esc(b.id)}" style="text-decoration:none">
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="title">${esc(b.name)}</span><span class="count">${offen}</span></div>
      <div class="meta">${b.ort ? `<span>${esc(b.ort)}</span>` : ""}<span>${(b.beteiligte || []).length} Beteiligte</span>${b.status === "abgeschlossen" ? `<span class="pill art">abgeschlossen</span>` : ""}${!b.ordner ? `<span class="pill offen">kein Ordner</span>` : ""}</div>
    </a>`;
  }).join("");
  return `<div class="top"><div class="grow"><h1>Baustellen</h1><div class="sub">Zahl rechts = offene Punkte</div></div></div>
    <button class="btn primary big" data-act="baustelle-neu">+ Neue Baustelle</button>
    <div class="stack">${cards || `<div class="empty">Noch keine Baustelle angelegt.</div>`}</div>`;
}

function viewBaustelle(id) {
  const b = baustelle(id);
  if (!b) return `<div class="empty">Baustelle nicht gefunden. <a href="#start">Zur Übersicht</a></div>`;
  const es = eintraegeVon(id);
  const shown = V.filter === "offen" ? es.filter((e) => e.status !== "erledigt") : es;
  const bet = beteiligte(b);
  let body;
  if (V.tab === "eintraege") {
    body = `<div class="chips"><button class="chip" aria-pressed="${V.filter === "offen"}" data-act="filter" data-v="offen">Offen (${es.filter((e) => e.status !== "erledigt").length})</button><button class="chip" aria-pressed="${V.filter === "alle"}" data-act="filter" data-v="alle">Alle (${es.length})</button></div>
    <div class="stack">${shown.map((e) => entryCard(e)).join("") || `<div class="empty">${V.filter === "offen" ? "Keine offenen Punkte." : "Noch keine Einträge."}</div>`}</div>`;
  } else {
    body = `<div class="row"><button class="btn primary" data-act="beteiligte-waehlen">+ Aus Adressbuch</button><button class="btn" data-act="mail-alle">Beteiligtenliste an alle</button></div>
    ${[...groupBy(bet, "gewerk")].map(([g, ks]) => `<section class="group"><h3>${esc(g)}</h3>${ks.map((k) => contactCard(k, id)).join("")}</section>`).join("") || `<div class="empty">Noch keine Beteiligten. Tippe auf „Aus Adressbuch“.</div>`}`;
  }
  return `<div class="top"><a class="iconbtn" href="#start" aria-label="Zurück">←</a><div class="grow"><h1>${esc(b.name)}</h1><div class="sub">${esc([b.ort, b.bauherr && "Bauherr: " + b.bauherr].filter(Boolean).join(" · "))}</div></div><button class="iconbtn" data-act="baustelle-edit" data-id="${esc(id)}" aria-label="Bearbeiten">✎</button></div>
    ${b.ordner ? `<div class="hint">📁 ${esc(b.ordner.anzeige || "")}${b.ordner.privat ? " – nicht geteilt, dein Partner sieht das nicht" : ""}</div>` : `<div class="banner">Für diese Baustelle ist noch kein Dropbox-Ordner gewählt. Tippe auf ✎.</div>`}
    <button class="btn primary big" data-act="eintrag-neu" data-id="${esc(id)}">● Neuer Eintrag</button>
    <div class="seg"><button aria-pressed="${V.tab === "eintraege"}" data-act="tab" data-v="eintraege">Einträge</button><button aria-pressed="${V.tab === "beteiligte"}" data-act="tab" data-v="beteiligte">Beteiligte (${bet.length})</button></div>
    ${body}`;
}
function entryCard(e) {
  const ks = (e.kontaktIds || []).map(kontakt).filter(Boolean);
  return `<button class="card" data-act="eintrag-edit" data-id="${esc(e.id)}" data-b="${esc(e.baustelleId)}">
    <div class="row"><span class="pill ${e.status === "erledigt" ? "erledigt" : "offen"}">${e.status === "erledigt" ? "erledigt" : "offen"}</span><span class="pill art">${esc(e.art || "Notiz")}</span>${e.mailGesendet ? `<span class="pill art">Mail ✓</span>` : ""}</div>
    <div class="title">${esc(e.titel || "Ohne Titel")}</div>
    <div class="meta"><span>${fmtDT(e.ts)}</span>${ks.length ? `<span>${esc(ks.map((k) => k.firma).join(", "))}</span>` : ""}${e.frist ? `<span>Frist ${fmtDate(e.frist)}</span>` : ""}</div>
    ${(e.fotos || []).length ? `<div class="thumbs">${e.fotos.slice(0, 6).map((f) => fotoImg(e.baustelleId, f)).join("")}</div>` : ""}
  </button>`;
}
function contactCard(k, bid) {
  const tels = (k.tel || []).map((t) => `<a data-k="T" href="${esc(telHref(t.nr))}">${esc(t.nr)}${t.name ? " · " + esc(t.name) : ""}</a>`).join("");
  const mails = (k.email || []).map((m) => `<a data-k="@" href="#" data-act="mail-einzel" data-to="${esc(m)}">${esc(m)}</a>`).join("");
  const pecs = (k.pec || []).map((m) => `<a data-k="P" href="#" data-act="mail-einzel" data-to="${esc(m)}">${esc(m)} (PEC)</a>`).join("");
  return `<div class="contact"><div class="head"><div class="grow"><div class="firma">${esc(k.firma)}</div>${k.person ? `<div class="sub">${esc(k.person)}</div>` : ""}</div>
    ${bid ? `<button class="iconbtn" data-act="beteiligt-weg" data-b="${esc(bid)}" data-id="${esc(k.id)}" aria-label="Entfernen">×</button>` : `<button class="iconbtn" data-act="kontakt-edit" data-id="${esc(k.id)}" aria-label="Bearbeiten">✎</button>`}</div>
    <div class="links">${tels}${mails}${pecs}</div>${k.notiz ? `<div class="hint">${esc(k.notiz)}</div>` : ""}</div>`;
}
function viewAdressbuch() {
  const q = V.search.trim().toLowerCase();
  const all = sortKontakte(live(S.kontakte)).filter((k) => !q || [k.firma, k.person, k.gewerk, k.adresse, ...(k.email || [])].join(" ").toLowerCase().includes(q));
  return `<div class="top"><div class="grow"><h1>Adressbuch</h1><div class="sub">${live(S.kontakte).length} Kontakte</div></div><button class="btn primary" data-act="kontakt-neu">+ Neu</button></div>
    <input type="search" id="search" placeholder="Suchen: Firma, Name, Gewerk …" value="${esc(V.search)}" autocomplete="off">
    ${[...groupBy(all, "gewerk")].map(([g, ks]) => `<section class="group"><h3>${esc(g)} (${ks.length})</h3>${ks.map((k) => contactCard(k)).join("")}</section>`).join("") || `<div class="empty">Nichts gefunden.</div>`}`;
}
function viewSettings() {
  const s = einst();
  const f = (id, label, val, ph = "") => `<label for="${id}">${label}<input type="text" id="${id}" value="${esc(val || "")}" placeholder="${esc(ph)}"></label>`;
  return `<div class="top"><div class="grow"><h1>Einstellungen</h1></div></div>
  <form class="card stack" id="settings-form">
    <h2>Mails und PDFs</h2>
    ${f("s-buero", "Büro (oben auf PDFs)", s.buero)}
    ${f("s-gruss", "Grußformel vor deiner eM-Client-Signatur", s.gruss, "Mit freundlichen Grüßen")}
    <label for="s-anrede">Anrede<select id="s-anrede"><option value="Sie">Sie</option><option value="Du" ${s.anrede === "Du" ? "selected" : ""}>Du</option></select></label>
    <label for="s-sprache">Sprache der Mails<select id="s-sprache">${["Deutsch", "Italienisch"].map((l) => `<option ${(s.sprache || "Deutsch") === l ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label for="s-diktat">Sprache beim Sprechen<select id="s-diktat">${[["de-DE", "Deutsch"], ["it-IT", "Italienisch"]].map(([v, l]) => `<option value="${v}" ${(s.diktat || "de-DE") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <button class="btn primary" type="submit">Speichern</button>
  </form>
  <div class="card stack"><h2>Dropbox</h2>
    <div>Angemeldet als <b>${esc(S.auth?.name || "")}</b> ${esc(S.auth?.email || "")}</div>
    <div class="hint">Gemeinsamer App-Ordner: ${esc(S.appOrdner?.anzeige || "")}${S.appOrdner?.privat ? " (nicht geteilt!)" : ""}</div>
    <div class="row"><button class="btn" data-act="pick-appordner">Ordner ändern</button><button class="btn danger" data-act="logout">Abmelden</button></div>
  </div>
  <div class="hint">Version ${esc(window.APP_VERSION || "")}</div>`;
}

// ---------- Blätter ----------
let sheetCleanup = null;
function openSheet(html, onClose) { $panel.innerHTML = html; $sheet.classList.add("open"); sheetCleanup = onClose || null; $panel.scrollTop = 0; }
function closeSheet() { $panel.onclick = null; $panel.onchange = null; V.eintragOffen = false; if (sheetCleanup) { try { sheetCleanup(); } catch {} sheetCleanup = null; } $sheet.classList.remove("open"); $panel.innerHTML = ""; }

// Dropbox-Ordner auswählen
function folderPicker(title, startPath, onPick) {
  let path = startPath || "";
  const draw = async () => {
    $panel.innerHTML = `<div class="bar"><h2>${esc(title)}</h2><button class="iconbtn" data-act="close-sheet">×</button></div>
      <div class="hint">📁 ${esc(path || "Dropbox")}</div><div class="row">${path ? `<button class="btn" data-fp="up">↑ Zurück</button>` : ""}<button class="btn primary" data-fp="ok" ${path ? "" : "disabled"}>Diesen Ordner wählen</button></div><div id="fp-list" class="hint">Lade …</div>`;
    try {
      const fs = await Dropbox.listFolders(path);
      document.getElementById("fp-list").outerHTML = `<div>${fs.map((f) => `<button class="folder" data-fp="open" data-p="${esc(f.path_display)}">${esc(f.name)}</button>`).join("") || `<div class="empty">Keine Unterordner.</div>`}</div>`;
    } catch (e) { document.getElementById("fp-list").textContent = "Ordner konnten nicht geladen werden (" + (e.message || e) + ")"; }
  };
  openSheet("");
  $panel.onclick = async (ev) => {
    const t = ev.target.closest("[data-fp],[data-act]"); if (!t) return;
    if (t.dataset.act === "close-sheet") { closeSheet(); return; }
    if (t.dataset.fp === "open") { path = t.dataset.p; draw(); }
    if (t.dataset.fp === "up") { path = path.split("/").slice(0, -1).join("/"); draw(); }
    if (t.dataset.fp === "ok") {
      t.disabled = true; t.textContent = "Prüfe …";
      try { const ref = await Dropbox.folderRef(path.toLowerCase()); ref.anzeige = path; closeSheet(); onPick(ref); }
      catch (e) { toast("Ordner nicht verwendbar: " + (e.message || e)); t.disabled = false; t.textContent = "Diesen Ordner wählen"; }
    }
  };
  draw();
}

function sheetBaustelle(id) {
  const b = id ? { ...baustelle(id) } : { id: newId("b"), beteiligte: [], erstellt: Date.now(), status: "aktiv" };
  const draw = () => {
    $panel.innerHTML = `<div class="bar"><h2>${id ? "Baustelle bearbeiten" : "Neue Baustelle"}</h2><button class="iconbtn" data-act="close-sheet">×</button></div>
    <div class="box"><h3>Dropbox-Ordner</h3><div class="hint">Wähle den Ordner <b>„Baustelle“</b> im Projektordner. Dort landen Fotos und Berichte.</div>
      <div>${b.ordner ? "📁 " + esc(b.ordner.anzeige) : "<i>noch keiner gewählt</i>"}</div>${b.ordner?.privat ? `<div class="banner">Dieser Ordner ist nicht geteilt – dein Partner sieht ihn nicht.</div>` : ""}
      <button class="btn" data-x="ordner">Ordner wählen</button></div>
    <label for="b-name">Name<input type="text" id="b-name" value="${esc(b.name || "")}" placeholder="z. B. Wohnhaus Pichler"></label>
    <label for="b-ort">Ort / Adresse<input type="text" id="b-ort" value="${esc(b.ort || "")}"></label>
    <label for="b-bauherr">Bauherr<input type="text" id="b-bauherr" value="${esc(b.bauherr || "")}"></label>
    ${id ? `<label for="b-status">Status<select id="b-status"><option value="aktiv">aktiv</option><option value="abgeschlossen" ${b.status === "abgeschlossen" ? "selected" : ""}>abgeschlossen</option></select></label>` : ""}
    <button class="btn primary big" data-x="save">Speichern</button>
    ${id ? `<button class="btn danger" data-x="del">Baustelle aus der App entfernen</button><div class="hint">Fotos und Dateien in Dropbox bleiben erhalten.</div>` : ""}`;
  };
  const read = () => { for (const k of ["name", "ort", "bauherr", "status"]) { const el = document.getElementById("b-" + k); if (el) b[k] = el.value.trim(); } };
  openSheet("");
  $panel.onclick = async (ev) => {
    const t = ev.target.closest("[data-x],[data-act]"); if (!t) return;
    if (t.dataset.act === "close-sheet") { closeSheet(); return; }
    read();
    if (t.dataset.x === "ordner") {
      const start = b.ordner?.anzeige || "";
      folderPicker("Ordner „Baustelle“ wählen", start, (ref) => {
        b.ordner = ref;
        if (!b.name) { const parts = ref.anzeige.split("/").filter(Boolean); b.name = parts.length > 1 && /baustelle/i.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1); }
        sheetBaustelleReopen();
      });
      return;
    }
    if (t.dataset.x === "save") {
      if (!b.name) { toast("Bitte einen Namen eingeben"); return; }
      upsert(S.baustellen, b); closeSheet(); changed();
      if (!id) { V.tab = "beteiligte"; location.hash = "#b-" + b.id; }
      return;
    }
    if (t.dataset.x === "del") {
      if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "Wirklich entfernen? Nochmal tippen"; return; }
      upsert(S.baustellen, { ...b, geloescht: true }); closeSheet(); location.hash = "#start"; changed();
    }
  };
  function sheetBaustelleReopen() { openSheet(""); $panel.onclick = handler; draw(); }
  const handler = $panel.onclick;
  draw();
}

function sheetKontakt(id) {
  const k = id ? { ...kontakt(id) } : { id: newId("k"), tel: [], email: [], pec: [], gruppe: "Firma" };
  const gewerke = [...new Set(live(S.kontakte).map((x) => x.gewerk))].sort((a, b) => a.localeCompare(b, "de"));
  openSheet(`<div class="bar"><h2>${id ? "Kontakt bearbeiten" : "Neuer Kontakt"}</h2><button class="iconbtn" data-act="close-sheet">×</button></div>
  <form id="kontakt-form" class="stack" data-id="${esc(k.id)}">
    <label for="k-firma">Firma / Name<input type="text" id="k-firma" required value="${esc(k.firma || "")}"></label>
    <label for="k-person">Ansprechpartner<input type="text" id="k-person" value="${esc(k.person || "")}"></label>
    <label for="k-gewerk">Gewerk / Rolle<input type="text" id="k-gewerk" list="gewerke" required value="${esc(k.gewerk || "")}"></label>
    <datalist id="gewerke">${gewerke.map((g) => `<option value="${esc(g)}">`).join("")}</datalist>
    <label for="k-gruppe">Art<select id="k-gruppe"><option value="Firma">Firma / Handwerker</option><option value="Techniker" ${k.gruppe === "Techniker" ? "selected" : ""}>Techniker / Planer</option></select></label>
    <label for="k-adresse">Adresse<input type="text" id="k-adresse" value="${esc(k.adresse || "")}"></label>
    <label for="k-tel">Telefon (mehrere mit Komma; Name in Klammern)<input type="tel" id="k-tel" value="${esc((k.tel || []).map((t) => t.nr + (t.name ? " (" + t.name + ")" : "")).join(", "))}"></label>
    <label for="k-email">E-Mail (mehrere mit Komma)<input type="text" id="k-email" inputmode="email" value="${esc((k.email || []).join(", "))}"></label>
    <label for="k-pec">PEC<input type="text" id="k-pec" inputmode="email" value="${esc((k.pec || []).join(", "))}"></label>
    <label for="k-notiz">Notiz<input type="text" id="k-notiz" value="${esc(k.notiz || "")}"></label>
    <button class="btn primary big" type="submit">Speichern</button>
    ${id ? `<button class="btn danger" type="button" data-act="kontakt-del" data-id="${esc(k.id)}">Kontakt löschen</button>` : ""}
  </form>`);
}

function sheetBeteiligte(bid) {
  const b = baustelle(bid); const sel = new Set(b.beteiligte || []);
  const draw = (q) => {
    const ql = q.toLowerCase();
    const list = sortKontakte(live(S.kontakte)).filter((k) => !ql || [k.firma, k.person, k.gewerk].join(" ").toLowerCase().includes(ql));
    document.getElementById("pick-list").innerHTML = [...groupBy(list, "gewerk")].map(([g, ks]) => `<h3 style="margin-top:10px;color:var(--muted);font-size:14px;text-transform:uppercase">${esc(g)}</h3>` + ks.map((k) => `<label class="pick"><input type="checkbox" data-pick="${esc(k.id)}" ${sel.has(k.id) ? "checked" : ""}><span><b>${esc(k.firma)}</b>${k.person ? " · " + esc(k.person) : ""}</span></label>`).join("")).join("");
  };
  openSheet(`<div class="bar"><h2>Beteiligte wählen</h2><button class="btn primary" data-act="beteiligte-ok" data-id="${esc(bid)}">Fertig</button></div>
    <input type="search" id="pick-q" placeholder="Suchen …" autocomplete="off"><div id="pick-list"></div>`);
  draw(""); V.pickSel = sel;
  document.getElementById("pick-q").addEventListener("input", (ev) => draw(ev.target.value));
  $panel.onchange = (ev) => { const id = ev.target.dataset?.pick; if (id) ev.target.checked ? sel.add(id) : sel.delete(id); };
}

// ---------- Mail ----------
function mailTemplate(b, e, empf) {
  const s = einst(); const du = s.anrede === "Du"; const it = s.sprache === "Italienisch";
  const person = empf.length === 1 ? empf[0].person : "";
  const gruss = s.gruss || (it ? "Cordiali saluti" : "Mit freundlichen Grüßen");
  const ort = b.ort ? (it ? " a " : " in ") + b.ort : "";
  if (it) {
    const anrede = du ? (person ? `Ciao ${person},` : "Ciao,") : (person ? `Gentile ${person},` : "Gentili Signori,");
    return { betreff: `Cantiere ${b.name} – ${e.titel || ""}`.trim(),
      text: `${anrede}\n\nin riferimento al cantiere ${b.name}${ort}:\n\n${e.text || e.titel}\n\n${e.frist ? `${du ? "Ti chiedo" : "Vi chiediamo"} di provvedere entro il ${fmtDate(e.frist)}.\n\n` : ""}${(e.fotos || []).length ? "In allegato le foto.\n\n" : ""}${gruss}` };
  }
  const anrede = du ? (person ? `Hallo ${person},` : "Hallo,") : (person ? `Guten Tag ${person},` : "Sehr geehrte Damen und Herren,");
  return { betreff: `Baustelle ${b.name} – ${e.titel || ""}`.trim(),
    text: `${anrede}\n\nbetreffend die Baustelle ${b.name}${ort}:\n\n${e.text || e.titel}\n\n${e.frist ? `${du ? "Bitte erledige das" : "Wir bitten um Erledigung"} bis ${fmtDate(e.frist)}.\n\n` : ""}${(e.fotos || []).length ? "Fotos anbei.\n\n" : ""}${gruss}` };
}
async function openMail({ to = [], bcc = [], subject = "", body = "", files = [] }) {
  if (!NATIVE) { location.href = `mailto:${to.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; return; }
  return Mail.compose({ to, bcc, subject, body, attachments: files.map(absPath), preferEmClient: true });
}

// ---------- Eintrag ----------
function sheetEintrag(bid, eid) {
  const b = baustelle(bid);
  const existing = eid ? (S.eintraege[bid] || []).find((x) => x.id === eid) : null;
  const E = existing ? JSON.parse(JSON.stringify(existing)) : { id: newId("e"), baustelleId: bid, ts: Date.now(), titel: "", art: "Mangel", text: "", kontaktIds: [], frist: "", status: "offen", fotos: [], mail: { betreff: "", text: "" }, mailGesendet: false };
  E.mail = E.mail || { betreff: "", text: "" };
  const neueFotos = [];
  const bet = beteiligte(b);

  const draw = () => {
    const kids = new Set(E.kontaktIds);
    const empf = [...kids].map(kontakt).filter(Boolean);
    $panel.innerHTML = `<div class="bar"><h2>${existing ? "Eintrag" : "Neuer Eintrag"}</h2><button class="btn primary" data-x="save">Speichern</button><button class="iconbtn" data-x="close">×</button></div>
    <div class="sub">${esc(b.name)} · ${fmtDT(E.ts)}</div>
    <div class="box"><h3>Fotos</h3>
      <div class="photos">${E.fotos.map((f, i) => `<div class="photo">${fotoImg(bid, f)}<button data-x="foto-weg" data-i="${i}" aria-label="Foto entfernen">×</button></div>`).join("")}</div>
      <div class="row"><button class="btn primary" data-x="kamera">Foto aufnehmen</button><button class="btn" data-x="galerie">Aus Galerie</button></div>
    </div>
    <div class="box"><h3>Beschreibung</h3>
      <button class="mic" data-x="mic"><span class="dot"></span>Sprechen</button>
      <textarea id="e-text" placeholder="z. B. Im Bad OG ist die Silikonfuge an der Dusche gerissen.">${esc(E.text)}</textarea>
      <label for="e-titel">Titel (kurz)<input type="text" id="e-titel" value="${esc(E.titel)}" placeholder="wird sonst aus dem Text genommen"></label>
      <div class="chips">${ART.map((a) => `<button class="chip" data-x="art" data-v="${a}" aria-pressed="${E.art === a}">${a}</button>`).join("")}</div>
    </div>
    <div class="box"><h3>Zuständig</h3>
      <div class="chips">${bet.map((k) => `<button class="chip" data-x="zust" data-id="${esc(k.id)}" aria-pressed="${kids.has(k.id)}">${esc(k.gewerk)}: ${esc(k.firma)}</button>`).join("") || `<span class="hint">Für diese Baustelle sind noch keine Beteiligten gewählt.</span>`}</div>
      <div class="row" style="flex-wrap:nowrap"><label for="e-frist" style="flex:1">Frist<input type="date" id="e-frist" value="${esc(E.frist || "")}"></label>
      <label for="e-status" style="flex:1">Status<select id="e-status"><option value="offen">offen</option><option value="erledigt" ${E.status === "erledigt" ? "selected" : ""}>erledigt</option></select></label></div>
    </div>
    <div class="box"><h3>Mail</h3>
      ${empf.length ? `<div class="hint">An: ${esc(empf.map((k) => k.firma + (firstMail(k) ? " <" + firstMail(k) + ">" : " – keine Adresse")).join(", "))}</div>` : `<div class="hint">Erst oben einen Zuständigen wählen.</div>`}
      <button class="btn" data-x="mailtext">Mailtext erstellen</button>
      <label for="e-betreff">Betreff<input type="text" id="e-betreff" value="${esc(E.mail.betreff)}"></label>
      <label for="e-mail">Text<textarea id="e-mail" style="min-height:170px">${esc(E.mail.text)}</textarea></label>
      <button class="btn primary big" data-x="mail" ${empf.length ? "" : "disabled"}>In eM Client öffnen${E.fotos.length ? ` (mit ${E.fotos.length} Foto${E.fotos.length > 1 ? "s" : ""})` : ""}</button>
      <label class="pick" style="border:0"><input type="checkbox" id="e-gesendet" ${E.mailGesendet ? "checked" : ""}> Mail ist verschickt</label>
    </div>
    ${existing ? `<button class="btn danger" data-x="del">Eintrag löschen</button>` : ""}`;
  };
  const read = () => {
    const v = (id) => document.getElementById(id)?.value;
    if (!document.getElementById("e-text")) return;
    E.text = v("e-text"); E.titel = v("e-titel").trim(); E.frist = v("e-frist") || ""; E.status = v("e-status");
    E.mail.betreff = v("e-betreff"); E.mail.text = v("e-mail"); E.mailGesendet = !!document.getElementById("e-gesendet")?.checked;
  };
  const autoTitel = () => { if (!E.titel && E.text) E.titel = E.text.split(/[.\n,]/)[0].trim().slice(0, 60); };
  const addFoto = async (path) => {
    const name = `${today()}_${slug(b.name)}_${Date.now().toString(36)}.jpg`;
    const rel = "fotos/" + name;
    await Filesystem.copy({ from: path, to: rel, toDirectory: DATA });
    S.lokal[name] = rel; E.fotos.push(name); neueFotos.push(name);
  };
  const saveEntry = () => {
    read(); autoTitel();
    if (!E.titel && !E.text && !E.fotos.length) return false;
    for (const name of neueFotos) S.queue.push({ art: "foto", bid, name, lokal: S.lokal[name] });
    neueFotos.length = 0;
    S.eintraege[bid] = S.eintraege[bid] || [];
    upsert(S.eintraege[bid], { ...E, geaendert: Date.now() });
    changed();
    return true;
  };

  openSheet("", () => {});
  V.eintragOffen = true;
  $panel.onclick = async (ev) => {
    const t = ev.target.closest("[data-x]"); if (!t) return;
    const x = t.dataset.x;
    if (x === "kamera") {
      read();
      try { const p = await Camera.getPhoto({ quality: 80, width: 1800, resultType: "uri", source: "CAMERA", correctOrientation: true, saveToGallery: false }); await addFoto(p.path); draw(); }
      catch (e) { if (!/cancel/i.test(e.message || "")) toast("Kamera: " + (e.message || e)); }
      return;
    }
    if (x === "galerie") {
      read();
      try { const r = await Camera.pickImages({ quality: 80, width: 1800, limit: 10 }); for (const p of r.photos) await addFoto(p.path); draw(); }
      catch (e) { if (!/cancel/i.test(e.message || "")) toast("Galerie: " + (e.message || e)); }
      return;
    }
    if (x === "mic") {
      read();
      try {
        const perm = await Speech.requestPermissions();
        if (perm.speechRecognition && perm.speechRecognition !== "granted") { toast("Mikrofon nicht erlaubt"); return; }
        const r = await Speech.start({ language: einst().diktat || "de-DE", maxResults: 1, prompt: "Sprechen …", partialResults: false, popup: true });
        const txt = (r.matches || [])[0];
        if (txt) { const satz = txt.charAt(0).toUpperCase() + txt.slice(1); E.text = E.text ? E.text.replace(/\s*$/, "") + (/[.!?]$/.test(E.text.trim()) ? " " : ". ") + satz : satz; draw(); }
      } catch (e) { if (!/cancel|no match|didn/i.test(e.message || "")) toast("Sprechen: " + (e.message || e)); }
      return;
    }
    if (x === "art") { read(); E.art = t.dataset.v; draw(); return; }
    if (x === "zust") { read(); const id = t.dataset.id; E.kontaktIds = E.kontaktIds.includes(id) ? E.kontaktIds.filter((y) => y !== id) : [...E.kontaktIds, id]; draw(); return; }
    if (x === "foto-weg") { read(); E.fotos.splice(+t.dataset.i, 1); draw(); return; }
    if (x === "mailtext") {
      read(); autoTitel();
      const empf = E.kontaktIds.map(kontakt).filter(Boolean);
      if (!empf.length) { toast("Erst einen Zuständigen wählen"); return; }
      E.mail = mailTemplate(b, E, empf); draw(); return;
    }
    if (x === "mail") {
      read(); autoTitel();
      const empf = E.kontaktIds.map(kontakt).filter(Boolean);
      const to = empf.map(firstMail).filter(Boolean);
      if (!to.length) { toast("Keine E-Mail-Adresse beim Zuständigen"); return; }
      if (!E.mail.text) E.mail = mailTemplate(b, E, empf);
      t.disabled = true; t.textContent = "Fotos vorbereiten …";
      try {
        const files = [];
        for (const f of E.fotos) files.push(await ensureLocal(bid, f));
        saveEntry();
        await openMail({ to, subject: E.mail.betreff, body: E.mail.text, files });
      } catch (e) { toast("Mail: " + (e.message || e)); }
      draw(); return;
    }
    if (x === "save") { if (saveEntry()) { closeSheet(); toast("Gespeichert"); } else toast("Eintrag ist leer"); return; }
    if (x === "del") {
      if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "Wirklich löschen? Nochmal tippen"; return; }
      upsert(S.eintraege[bid], { ...E, geloescht: true }); closeSheet(); changed(); return;
    }
    if (x === "close") {
      read();
      const dirty = !existing ? (E.text || E.fotos.length) : JSON.stringify({ ...E, mail: E.mail }) !== JSON.stringify(existing);
      if (dirty && !t.dataset.confirm) { t.dataset.confirm = "1"; toast("Nicht gespeichert – nochmal × tippen zum Verwerfen"); return; }
      closeSheet();
    }
  };
  draw();
}

// ---------- PDF Beteiligtenliste ----------
const pdfSafe = (s) => String(s ?? "").replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, "-").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF€]/g, "");
async function pdfBeteiligte(b) {
  const ks = beteiligte(b);
  const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  doc.setFontSize(9); doc.setTextColor(110);
  if (einst().buero) doc.text(pdfSafe(einst().buero), 15, 14);
  doc.text("Stand: " + fmtDate(today()), W - 15, 14, { align: "right" });
  doc.setTextColor(20); doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text("Beteiligtenliste", 15, 26);
  doc.setFont("helvetica", "normal"); doc.setFontSize(11);
  doc.text(pdfSafe([b.name, b.ort, b.bauherr ? "Bauherr: " + b.bauherr : ""].filter(Boolean).join("  ·  ")), 15, 33);
  doc.setDrawColor(232, 163, 23); doc.setLineWidth(0.8); doc.line(15, 37, W - 15, 37);
  doc.autoTable({
    startY: 44, margin: { left: 15, right: 15 },
    head: [["Gewerk", "Firma / Ansprechpartner", "Adresse", "Telefon", "E-Mail"]],
    body: ks.map((k) => [k.gewerk, k.firma + (k.person ? "\n" + k.person : ""), k.adresse || "", (k.tel || []).map((t) => t.nr + (t.name ? " (" + t.name + ")" : "")).join("\n"), [...(k.email || []), ...(k.pec || []).map((p) => p + " (PEC)")].join("\n")].map(pdfSafe)),
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 1.8, valign: "top", lineColor: 210, lineWidth: 0.1 },
    headStyles: { fillColor: [29, 36, 40], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [244, 245, 244] },
    columnStyles: { 0: { cellWidth: 31, fontStyle: "bold" }, 1: { cellWidth: 42 }, 2: { cellWidth: 37 }, 3: { cellWidth: 28 }, 4: { cellWidth: 42 } },
  });
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(130); doc.text(`Seite ${i} von ${n}`, W - 15, doc.internal.pageSize.getHeight() - 8, { align: "right" }); }
  const name = `Beteiligtenliste_${slug(b.name)}_${today()}.pdf`;
  const rel = "pdf/" + name;
  await Filesystem.writeFile({ path: rel, directory: DATA, data: doc.output("datauristring").split(",")[1] });
  S.queue.push({ art: "pdf", bid: b.id, name, lokal: rel });
  persist(); scheduleSync();
  return rel;
}

// ---------- Ereignisse ----------
document.addEventListener("click", async (ev) => {
  if (V.eintragOffen && ev.target.closest("#sheet")) return;
  const t = ev.target.closest("[data-act]"); if (!t) return;
  if (t.tagName === "A" && t.getAttribute("href") === "#") ev.preventDefault();
  const act = t.dataset.act, id = t.dataset.id, r = route();
  switch (act) {
    case "close-sheet": closeSheet(); break;
    case "login":
      try { const url = await Dropbox.startLogin(); await Browser.open({ url }); } catch (e) { toast(e.message || String(e)); }
      break;
    case "logout": if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "Wirklich abmelden?"; break; } Dropbox.logout(); S.appOrdner = null; persist(); render(); break;
    case "pick-appordner": folderPicker("Gemeinsamen App-Ordner wählen", S.appOrdner?.anzeige || "", (ref) => { S.appOrdner = ref; if (ref.privat) toast("Achtung: Ordner ist nicht geteilt"); persist(); render(); sync(); }); break;
    case "sync": sync(); break;
    case "baustelle-neu": sheetBaustelle(null); break;
    case "baustelle-edit": sheetBaustelle(id); break;
    case "tab": V.tab = t.dataset.v; render(); break;
    case "filter": V.filter = t.dataset.v; render(); break;
    case "eintrag-neu": sheetEintrag(id, null); break;
    case "eintrag-edit": sheetEintrag(t.dataset.b, id); break;
    case "beteiligte-waehlen": sheetBeteiligte(r.id); break;
    case "beteiligte-ok": { const b = { ...baustelle(id), beteiligte: [...V.pickSel] }; closeSheet(); upsert(S.baustellen, b); changed(); break; }
    case "beteiligt-weg": { const b = baustelle(t.dataset.b); upsert(S.baustellen, { ...b, beteiligte: (b.beteiligte || []).filter((x) => x !== id) }); changed(); break; }
    case "mail-einzel": openMail({ to: [t.dataset.to] }).catch((e) => toast(e.message || e)); break;
    case "mail-alle": {
      const b = baustelle(r.id); const addrs = beteiligte(b).map(firstMail).filter(Boolean);
      if (!addrs.length) { toast("Keine Adressen vorhanden"); break; }
      try {
        const rel = await pdfBeteiligte(b); const it = einst().sprache === "Italienisch"; const du = einst().anrede === "Du";
        const body = it ? `${du ? "Ciao a tutti" : "Gentili Signori"},\n\nin allegato l'elenco aggiornato dei partecipanti al cantiere ${b.name}.\n\n${einst().gruss || "Cordiali saluti"}`
          : `${du ? "Hallo zusammen" : "Sehr geehrte Damen und Herren"},\n\nanbei die aktuelle Beteiligtenliste für die Baustelle ${b.name}${b.ort ? " (" + b.ort + ")" : ""}.\n\n${einst().gruss || "Mit freundlichen Grüßen"}`;
        await openMail({ bcc: addrs, subject: (it ? "Elenco partecipanti " : "Beteiligtenliste ") + b.name, body, files: [rel] });
      } catch (e) { toast("PDF/Mail: " + (e.message || e)); }
      break;
    }
    case "kontakt-neu": sheetKontakt(null); break;
    case "kontakt-edit": sheetKontakt(id); break;
    case "kontakt-del": if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "Wirklich löschen? Nochmal tippen"; break; } upsert(S.kontakte, { ...kontakt(id), geloescht: true }); closeSheet(); changed(); break;
  }
});
document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target; const v = (id) => (document.getElementById(id)?.value || "").trim();
  if (f.id === "kontakt-form") {
    const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const tel = split(v("k-tel")).map((t) => { const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/); return m ? { nr: m[1], name: m[2] } : { nr: t, name: "" }; });
    const old = kontakt(f.dataset.id) || {};
    upsert(S.kontakte, { ...old, id: f.dataset.id, firma: v("k-firma"), person: v("k-person"), gewerk: v("k-gewerk"), gruppe: v("k-gruppe"), adresse: v("k-adresse"), tel, email: split(v("k-email")), pec: split(v("k-pec")), notiz: v("k-notiz") });
    closeSheet(); changed(); toast("Kontakt gespeichert");
  }
  if (f.id === "settings-form") {
    upsert(S.einst, { ...einst(), id: "allgemein", buero: v("s-buero"), gruss: v("s-gruss"), anrede: v("s-anrede"), sprache: v("s-sprache"), diktat: v("s-diktat") });
    changed(); toast("Gespeichert");
  }
});
document.addEventListener("input", (ev) => { if (ev.target.id === "search") { V.search = ev.target.value; V.focusSearch = true; render(); V.focusSearch = false; } });
window.addEventListener("hashchange", () => { closeSheet(); window.scrollTo(0, 0); render(); });

// ---------- Start ----------
(async () => {
  await load();
  Dropbox.onAuth((a) => { S.auth = a; persist(); render(); });
  render();
  if (!NATIVE) return;
  AppP.addListener("appUrlOpen", async ({ url }) => {
    if (!url.startsWith("baustellendoku://oauth")) return;
    try { await Browser.close(); } catch {}
    try { await Dropbox.finishLogin(url); toast("Mit Dropbox verbunden"); } catch (e) { toast(e.message || String(e)); }
  });
  AppP.addListener("resume", () => scheduleSync(300));
  AppP.addListener("backButton", () => {
    if ($sheet.classList.contains("open")) { if (V.eintragOffen) { const x = $panel.querySelector('[data-x="close"]'); x?.click(); } else closeSheet(); return; }
    if (route().name !== "start") { history.back(); return; }
    AppP.minimizeApp();
  });
  try { V.online = (await Network.getStatus()).connected; } catch {}
  Network.addListener("networkStatusChange", (st) => { const was = V.online; V.online = st.connected; renderSync(); if (!was && V.online) scheduleSync(500); });
  try { window.APP_VERSION = (await AppP.getInfo()).version; } catch {}
  scheduleSync(300);
})();
