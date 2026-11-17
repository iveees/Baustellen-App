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
const DiktatP = registerPlugin("Diktat");
const Mail = registerPlugin("Mail");
const DATA = "DATA";
const PC = !!window.IS_DESKTOP;   // Windows-Version (gleiche Oberfläche, andere Hülle)
// Handy: Kamera; PC: Fotos aus Dateien auswählen (mehrere)
async function fotoAufnehmen() {
  if (PC) return (await Camera.pickImages({ quality: 80, width: 1800, limit: 20 })).photos.map((p) => p.path);
  return [(await Camera.getPhoto({ quality: 80, width: 1800, resultType: "uri", source: "CAMERA", correctOrientation: true, saveToGallery: false })).path];
}

// ---------- Zustand ----------
const S = {
  kontakte: [], baustellen: [], einst: [], eintraege: {},   // geteilt (Dropbox)
  lokal: {},        // Fotoname -> lokaler Pfad (nur dieses Gerät)
  queue: [],        // Uploads: {art:"foto"|"pdf", bid, name, lokal}
  protokolle: {},   // geteilt, pro Baustelle
  begehung: {},     // laufender Rundgang pro Baustelle (nur dieses Gerät)
  meinName: "",
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
const reihe = (e) => e.pos ?? e.ts ?? 0;   // eigene Reihenfolge (verschoben) vor Erstellzeit
const eintraegeVon = (bid) => live(S.eintraege[bid] || []).sort((a, b) => reihe(b) - reihe(a));
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
  V.syncing = true; S.syncFehler = ""; renderSync();
  try {
    await syncDoc(appPath("/Einstellungen.json"), () => S.einst, (v) => (S.einst = v));
    await syncDoc(appPath("/Baustellen.json"), () => S.baustellen, (v) => (S.baustellen = v));
    await syncDoc(appPath("/Adressbuch.json"), () => S.kontakte, (v) => (S.kontakte = v), window.START_KONTAKTE || []);
    await wordListeAbgleichen(V.wordErzwingen); V.wordErzwingen = false;
    await syncDoc(appPath("/Adressbuch.json"), () => S.kontakte, (v) => (S.kontakte = v));
    await syncDoc(appPath("/Einstellungen.json"), () => S.einst, (v) => (S.einst = v));
    for (const b of live(S.baustellen)) {
      if (!b.ordner) continue;
      await syncDoc(bPath(b, "/Baustellen-Doku.json"), () => S.eintraege[b.id] || [], (v) => (S.eintraege[b.id] = v));
      await syncDoc(bPath(b, "/Baustellen-Protokolle.json"), () => S.protokolle[b.id] || [], (v) => (S.protokolle[b.id] = v));
    }
    for (const b of live(S.baustellen)) if (b.ordner) { try { await dateienAbgleichen(b); } catch (e) { console.warn("Abgleich", e); } }
    await uploadQueue();
    S.letzterSync = Date.now(); if (/Word-Liste/.test(S.syncFehler || "")) { /* Hinweis stehen lassen */ } else S.syncFehler = S.queue.length ? S.queue.length + " Datei(en) noch nicht hochgeladen – wird erneut versucht" + (V.uploadFehler ? " (" + V.uploadFehler + ")" : "") : "";
  } catch (e) {
    console.error(e);
    S.syncFehler = e.status === 401 ? "Dropbox-Anmeldung abgelaufen – bitte neu anmelden" : e.notFound ? "Ordner in Dropbox nicht gefunden: " + (e.summary || "") : "Synchronisieren fehlgeschlagen (" + (e.message || e) + ")";
  } finally {
    V.syncing = false; persist(); render();
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}
const UNTERORDNER = { foto: "/Fotos/", pdf: "/Berichte/", protokoll: "/Protokolle/", ordner: "/" };
async function lokaleDatei(rel) {
  try { const r = await fetch(fileSrc(rel)); if (!r.ok) return null; const bl = await r.blob(); return bl.size ? bl : null; } catch { return null; }
}
async function uploadQueue() {
  const rest = [];
  for (const q of S.queue) {
    const b = baustelle(q.bid);
    if (!b?.ordner) { rest.push(q); continue; }
    const blob = await lokaleDatei(q.lokal);
    if (!blob) { console.warn("Datei fehlt auf dem Handy", q); continue; }   // nur dann verwerfen
    try {
      const res = await Dropbox.upload(bPath(b, UNTERORDNER[q.art] + q.name), blob);
      if (q.word && res?.rev) { const p = (S.protokolle[q.bid] || []).find((x) => x.id === q.word); if (p) { p.wordRev = res.rev; upsert(S.protokolle[q.bid], p); } }
    }
    catch (e) { console.warn("Upload später erneut", q, e); V.uploadFehler = (e.summary || e.message || String(e)).slice(0, 80); rest.push(q); }  // Netz/Server: behalten
  }
  S.queue = rest;
}
// Fehlt etwas in Dropbox, das auf diesem Handy liegt? Dann nachladen.
async function dateienAbgleichen(b) {
  S.abgleich = S.abgleich || {};
  if (Date.now() - (S.abgleich[b.id] || 0) < 10 * 60 * 1000) return;
  const liste = async (sub) => { try { return new Set((await Dropbox.rpc("files/list_folder", { path: bPath(b, sub) })).entries.map((e) => e.name.toLowerCase())); } catch (e) { if (e.notFound) return new Set(); throw e; } };
  const [fotos, prots] = [await liste("/Fotos"), await liste("/Protokolle")];
  const inQueue = new Set(S.queue.map((q) => q.name));
  for (const e of live(S.eintraege[b.id] || [])) for (const f of e.fotos || [])
    if (S.lokal[f] && !fotos.has(f.toLowerCase()) && !inQueue.has(f)) S.queue.push({ art: "foto", bid: b.id, name: f, lokal: S.lokal[f] });
  for (const p of live(S.protokolle[b.id] || []))
    for (const d of [p.datei, p.wordDatei]) if (d && S.lokal[d] && !prots.has(d.toLowerCase()) && !inQueue.has(d)) S.queue.push({ art: "protokoll", bid: b.id, name: d, lokal: S.lokal[d], word: d === p.wordDatei ? p.id : undefined });
  S.abgleich[b.id] = Date.now();
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
async function ensureLocal(bid, name, ordner = "Fotos") {
  if (S.lokal[name]) return S.lokal[name];
  const b = baustelle(bid);
  const bl = await Dropbox.download(bPath(b, "/" + ordner + "/" + name));
  if (!bl) throw new Error("Datei nicht gefunden: " + name);
  const rel = (ordner === "Fotos" ? "fotos/" : "pdf/") + name;
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
  else if (V.syncing) { cls = "warn"; txt = V.wordStatus || "Synchronisiere …"; }
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
  let shown = V.filter === "offen" ? es.filter((e) => e.status !== "erledigt") : es;
  if (S.umgekehrt) shown = shown.slice().reverse();
  const bet = beteiligte(b);
  const prots = protokolleVon(id);
  const rg = S.begehung[id];
  const neuSeitProt = es.filter((e) => !e.protokollNr).length;
  let body;
  if (V.tab === "eintraege") {
    body = `<div class="chips"><button class="chip" aria-pressed="${V.filter === "offen"}" data-act="filter" data-v="offen">Offen (${es.filter((e) => e.status !== "erledigt").length})</button><button class="chip" aria-pressed="${V.filter === "alle"}" data-act="filter" data-v="alle">Alle (${es.length})</button><button class="chip" aria-pressed="${!!S.umgekehrt}" data-act="umkehren">⇅ Umkehren</button></div>
    <div class="stack" id="punkte-liste">${shown.map((e) => entryCard(e)).join("") || `<div class="empty">${V.filter === "offen" ? "Keine offenen Punkte." : "Noch keine Einträge."}</div>`}</div>
    ${shown.length ? `<div class="hint">Reihenfolge ändern: das Kästchen ⠿ rechts festhalten und den Punkt nach oben oder unten ziehen. Zum Löschen lange auf einen Punkt drücken.</div>` : ""}`;
  } else if (V.tab === "protokolle") {
    body = `<button class="btn primary" data-act="protokoll-neu" data-id="${esc(id)}">+ Protokoll erstellen</button>
    <div class="hint">Zum Löschen lange auf ein Protokoll drücken.</div>
    <div class="stack">${prots.map((p) => `<div class="card" data-lp="protokoll" data-b="${esc(id)}" data-id="${esc(p.id)}"><div class="title">Protokoll Nr. ${p.nr} · ${fmtDate(p.datum)}</div>
      <div class="meta"><span>${p.punkte?.length || 0} ${p.punkte?.length === 1 ? "Punkt" : "Punkte"}</span>${p.verfasser ? `<span>${esc(p.verfasser)}</span>` : ""}<span>${S.queue.some((q) => q.name === p.datei || q.name === p.wordDatei) ? "⏳ wird in Dropbox gespeichert" : "☁ in Dropbox gespeichert"}${p.wordDatei ? " · PDF + Word" : ""}</span></div>
      <div class="row"><button class="btn primary" data-act="protokoll-ansehen" data-b="${esc(id)}" data-id="${esc(p.id)}">Ansehen</button>${PC && p.wordDatei ? `<button class="btn" data-act="protokoll-word" data-b="${esc(id)}" data-id="${esc(p.id)}">In Word bearbeiten</button>` : ""}<button class="btn" data-act="protokoll-senden" data-b="${esc(id)}" data-id="${esc(p.id)}">Mail vorbereiten</button>${p.nr === prots[0].nr ? `<button class="btn" data-act="protokoll-neu-erstellen" data-b="${esc(id)}" data-id="${esc(p.id)}">Neu erstellen</button>` : ""}</div></div>`).join("") || `<div class="empty">Noch kein Protokoll.</div>`}</div>`;
  } else {
    body = `<div class="row"><button class="btn primary" data-act="beteiligte-waehlen">+ Aus Adressbuch</button><button class="btn" data-act="beteiligte-speichern">Liste in Dropbox speichern (PDF + Word)</button><button class="btn" data-act="mail-alle">Liste an alle (Mail vorbereiten)</button></div>
    ${[...groupBy(bet, "gewerk")].map(([g, ks]) => `<section class="group"><h3>${esc(g)}</h3>${ks.map((k) => contactCard(k, id)).join("")}</section>`).join("") || `<div class="empty">Noch keine Beteiligten. Tippe auf „Aus Adressbuch“.</div>`}`;
  }
  return `<div class="top"><a class="iconbtn" href="#start" aria-label="Zurück">←</a><div class="grow"><h1>${esc(b.name)}</h1><div class="sub">${esc([b.ort, b.bauherr && "Bauherr: " + b.bauherr].filter(Boolean).join(" · "))}</div></div><button class="iconbtn" data-act="baustelle-edit" data-id="${esc(id)}" aria-label="Bearbeiten">✎</button></div>
    ${b.ordner ? "" : `<div class="banner">Für diese Baustelle ist noch kein Dropbox-Ordner gewählt. Tippe auf ✎.</div>`}
    <button class="btn primary big" data-act="begehung" data-id="${esc(id)}">${rg ? `▶ Begehung fortsetzen (${rg.punkte.filter(punktHatInhalt).length} Punkte)` : "▶ Begehung starten"}</button>
    <div class="row"><button class="btn" style="flex:1" data-act="eintrag-neu" data-id="${esc(id)}">+ Einzelner Eintrag</button>${neuSeitProt ? `<button class="btn" style="flex:1" data-act="protokoll-neu" data-id="${esc(id)}">Protokoll erstellen (${neuSeitProt} neu)</button>` : ""}</div>
    <div class="seg" style="grid-template-columns:1fr 1fr 1fr"><button aria-pressed="${V.tab === "eintraege"}" data-act="tab" data-v="eintraege">Punkte</button><button aria-pressed="${V.tab === "protokolle"}" data-act="tab" data-v="protokolle">Protokolle</button><button aria-pressed="${V.tab === "beteiligte"}" data-act="tab" data-v="beteiligte">Beteiligte</button></div>
    ${body}`;
}

function entryCard(e) {
  const ks = (e.kontaktIds || []).map(kontakt).filter(Boolean);
  return `<button class="card${e.status !== "erledigt" ? " mitgriff" : ""}" data-act="eintrag-edit" data-lp="eintrag" data-id="${esc(e.id)}" data-b="${esc(e.baustelleId)}">
    <div class="row"><span class="pill ${e.status === "erledigt" ? "erledigt" : "offen"}">${e.status === "erledigt" ? "erledigt" : "offen"}</span><span class="pill art">${esc(e.art || "Notiz")}</span>${e.nr ? `<span class="pill art">Nr. ${esc(e.nr)}</span>` : `<span class="pill art">neu</span>`}${e.mailGesendet ? `<span class="pill art">Mail ✓</span>` : ""}</div>
    ${e.status !== "erledigt" ? `<span class="griff" data-griff aria-label="Verschieben">⠿</span>` : ""}
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
  const w = einst().wordName; const wd = V.wordDatei;
  const wordKarte = wd || w ? `<div class="card"><div>${w ? `Quelle: Word-Liste <b>${esc(w)}</b>` : `Word-Liste gefunden: <b>${esc(wd.name)}</b>`}</div>
      <div class="hint">${w ? `Eingelesen: Stand ${einst().wordStand ? fmtDT(einst().wordStand) : "?"}. ` : ""}${wd?.neu ? `<b style="color:var(--open)">In Dropbox liegt eine neuere Version (${fmtDT(wd.stand)}).</b> ` : w ? "Aktuell. " : ""}Einlesen kostet ein paar Cent (Claude).</div>
      <div class="row"><button class="btn ${wd?.neu ? "primary" : ""}" data-act="word-neu">Word-Liste einlesen</button>${PC ? "" : `<button class="btn" data-act="kontakt-abgleich">Mit Handykontakten abgleichen</button>`}</div><div class="hint">Neue Kontakte und neue Nummern/Mails aus der App werden automatisch in die Word-Datei geschrieben. Andere Änderungen (Name, Adresse) bitte direkt in Word.</div></div>`
    : `<div class="hint">Tipp: Lege eure Word-Liste der Firmen in den gemeinsamen App-Ordner. Dann kannst du sie hier mit einem Knopf einlesen.</div>`;
  return `<div class="top"><div class="grow"><h1>Adressbuch</h1><div class="sub">${live(S.kontakte).length} Kontakte</div></div><button class="btn primary" data-act="kontakt-neu">+ Neu</button></div>
    ${wordKarte}
    <input type="search" id="search" placeholder="Suchen: Firma, Name, Gewerk …" value="${esc(V.search)}" autocomplete="off">
    ${[...groupBy(all, "gewerk")].map(([g, ks]) => `<section class="group"><h3>${esc(g)} (${ks.length})</h3>${ks.map((k) => contactCard(k)).join("")}</section>`).join("") || `<div class="empty">Nichts gefunden.</div>`}`;
}
function viewSettings() {
  const s = einst();
  const f = (id, label, val, ph = "") => `<label for="${id}">${label}<input type="text" id="${id}" value="${esc(val || "")}" placeholder="${esc(ph)}"></label>`;
  return `<div class="top"><div class="grow"><h1>Einstellungen</h1></div></div>
  <form class="card stack" id="settings-form">
    <h2>Mails und Protokolle</h2>
    ${f("s-meinname", "Dein Name (als Verfasser im Protokoll, nur auf diesem Handy)", S.meinName)}
    ${f("s-buero", "Büro (oben auf PDFs)", s.buero)}
    ${f("s-gruss", "Grußformel vor deiner eM-Client-Signatur", s.gruss, "Mit freundlichen Grüßen")}
    <label for="s-anrede">Anrede<select id="s-anrede"><option value="Sie">Sie</option><option value="Du" ${s.anrede === "Du" ? "selected" : ""}>Du</option></select></label>
    <label for="s-sprache">Sprache von Mails und Protokollen<select id="s-sprache">${["Deutsch", "Italienisch"].map((l) => `<option ${(s.sprache || "Deutsch") === l ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label for="s-diktat">Sprache beim Sprechen<select id="s-diktat">${[["de-DE", "Deutsch"], ["it-IT", "Italienisch"]].map(([v, l]) => `<option value="${v}" ${(s.diktat || "de-DE") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label for="s-fotos">Fotos im Protokoll<select id="s-fotos"><option value="punkt">beim jeweiligen Punkt</option><option value="ende" ${s.fotos === "ende" ? "selected" : ""}>gesammelt am Ende</option><option value="keine" ${s.fotos === "keine" ? "selected" : ""}>keine Fotos</option></select></label>
    <h2 style="margin-top:8px">Zusammenfassen mit Claude</h2>
    <label for="s-apikey">API-Schlüssel von Anthropic (beginnt mit sk-ant-)<input type="text" id="s-apikey" value="${esc(s.apiKey || "")}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div class="hint">Wird über euren Dropbox-Ordner mit deinem Partner geteilt. Ohne Schlüssel übernimmt die App deinen Text unverändert.</div>
    <div class="row"><button class="btn primary" type="submit">Speichern</button><button class="btn" type="button" data-act="ki-test">Schlüssel testen</button></div>
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
    <div class="box"><h3>Dropbox-Ordner</h3><div class="hint">Wähle im Projektordner den Baustellen-Ordner (z. B. <b>05-BAUSTELLE</b>). Dort landen Fotos und Berichte.</div>
      <div>${b.ordner ? "📁 " + esc(b.ordner.anzeige) : "<i>noch keiner gewählt</i>"}</div>${b.ordner?.privat ? `<div class="banner">Dieser Ordner ist nicht geteilt – dein Partner sieht ihn nicht.</div>` : ""}
      <div class="row"><button class="btn" data-x="ordner">Ordner wählen</button>${b.ordner ? `<button class="btn" data-x="pruefen">In Dropbox prüfen</button>` : ""}</div><div id="b-diag" class="hint" style="white-space:pre-wrap;overflow-wrap:anywhere"></div></div>
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
      folderPicker("Baustellen-Ordner wählen", start, (ref) => {
        b.ordner = ref;
        if (!b.name) { const parts = ref.anzeige.split("/").filter(Boolean); b.name = parts.length > 1 && /baustelle/i.test(parts.at(-1)) ? parts.at(-2) : parts.at(-1); }
        sheetBaustelleReopen();
      });
      return;
    }
    if (t.dataset.x === "pruefen") {
      const out = document.getElementById("b-diag"); out.textContent = "Prüfe …";
      try {
        const zeilen = ["Pfad für die App: " + Dropbox.refPath(b.ordner)];
        try { const m = await Dropbox.rpc("files/get_metadata", { path: Dropbox.refPath(b.ordner) }); zeilen.push("Ordner laut Dropbox: " + (m.path_display || "(geteilter Ordner, Pfad aus deiner Sicht unbekannt)")); } catch (e) { zeilen.push("Ordner: " + (e.summary || e.message)); }
        for (const sub of ["", "/Fotos", "/Protokolle"]) {
          try {
            const r = await Dropbox.rpc("files/list_folder", { path: Dropbox.refPath(b.ordner, sub) });
            zeilen.push("", (sub || "Ordner") + ": " + r.entries.length + " Einträge");
            for (const e of r.entries.slice(0, 12)) zeilen.push("  " + e.name + (e.server_modified ? "  (" + new Date(e.server_modified).toLocaleString("de-DE") + ")" : ""));
          } catch (e) { zeilen.push("", (sub || "Ordner") + ": " + (e.notFound ? "existiert nicht" : e.summary || e.message)); }
        }
        zeilen.push("", "Warteschlange: " + S.queue.filter((q) => q.bid === b.id).length + " Datei(en)");
        out.textContent = zeilen.join("\n");
      } catch (e) { out.textContent = "Fehler: " + (e.message || e); }
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
      <div class="row"><button class="btn primary" data-x="kamera">${PC ? "Fotos hinzufügen" : "Foto aufnehmen"}</button>${PC ? "" : `<button class="btn" data-x="galerie">Aus Galerie</button>`}</div>
    </div>
    <div class="box"><h3>Beschreibung</h3>
      <button class="mic ${Diktat.aktiv ? "on" : ""}" data-x="mic"><span class="dot"></span>${Diktat.aktiv ? "Aufnahme läuft · tippen = fertig" : PC ? "Diktieren: ins Textfeld klicken, dann Windows-Taste + H" : "Sprechen"}</button>
      <div class="partial" id="e-partial"></div>
      <textarea id="e-text" placeholder="z. B. Im Bad OG ist die Silikonfuge an der Dusche gerissen.">${esc(E.text)}</textarea>
      <button class="btn" data-x="aufbereiten">${einst().apiKey ? "✦ Aufbereiten: Titel, Zuständig, Frist, Mail" : "Zuständig aus dem Text erkennen"}</button><div class="hint" id="e-ki"></div>
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
    if (E.status === "erledigt" && !E.erledigtAm) E.erledigtAm = Date.now();
    if (E.status !== "erledigt") delete E.erledigtAm;
    upsert(S.eintraege[bid], { ...E, geaendert: Date.now() });
    changed();
    return true;
  };

  openSheet("", () => { if (Diktat.aktiv) Diktat.stop(); });
  V.eintragOffen = true;
  $panel.onclick = async (ev) => {
    const t = ev.target.closest("[data-x]"); if (!t) return;
    const x = t.dataset.x;
    if (x === "kamera") {
      read();
      try { for (const pfad of await fotoAufnehmen()) await addFoto(pfad); draw(); }
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
      if (Diktat.aktiv) { await Diktat.stop(); return; }
      Diktat.start({
        append: (txt) => { const ta = document.getElementById("e-text"); if (!ta) return; ta.value = satzAnhaengen(ta.value, txt); E.text = ta.value; },
        partial: (txt) => { const el = document.getElementById("e-partial"); if (el) el.textContent = txt; },
        state: () => { read(); draw(); },
      });
      return;
    }
    if (x === "aufbereiten") {
      read();
      if (Diktat.aktiv) await Diktat.stop();
      if (!E.text.trim()) { toast("Erst etwas sprechen oder schreiben"); return; }
      const st = document.getElementById("e-ki"); if (st) st.textContent = einst().apiKey ? "Claude fasst zusammen …" : "";
      try {
        const [r] = await punkteAufbereiten(b, [{ i: 0, text: E.text, fotos: E.fotos.length }], { mitMail: true });
        read();
        if (r.titel) E.titel = r.titel; if (ART.includes(r.art)) E.art = r.art; if (r.beschreibung) E.text = r.beschreibung;
        if (r.kontaktIds?.length) E.kontaktIds = r.kontaktIds; if (r.frist) E.frist = r.frist;
        if (r.mail?.text) E.mail = { betreff: r.mail.betreff || E.mail.betreff, text: r.mail.text + "\n\n" + (einst().gruss || "Mit freundlichen Grüßen") };
        draw(); toast("Ausgefüllt – bitte kurz prüfen");
      } catch (e) { const st2 = document.getElementById("e-ki"); if (st2) st2.textContent = "Zusammenfassen nicht möglich: " + (e.message || e); }
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

// ---------- Diktat (durchgehend, auch bei Sprechpausen) ----------
const Diktat = {
  aktiv: false, ziel: null, bereit: false,
  async init() {
    if (!NATIVE || this.bereit) return;
    this.bereit = true;
    DiktatP.addListener("partial", (e) => this.ziel?.partial?.(e.text || ""));
    DiktatP.addListener("final", (e) => { this.ziel?.partial?.(""); if (e.text) this.ziel?.append?.(e.text); });
    DiktatP.addListener("state", (e) => { const war = this.aktiv; this.aktiv = !!e.active; if (war !== this.aktiv) this.ziel?.state?.(this.aktiv); });
    DiktatP.addListener("error", (e) => { this.aktiv = false; toast("Sprechen: " + (e.message || "Fehler")); this.ziel?.state?.(false); });
  },
  async start(ziel) {
    this.ziel = ziel;
    if (PC) { const ta = document.getElementById("e-text") || document.getElementById("r-text"); ta?.focus(); toast("Jetzt Windows-Taste + H drücken und sprechen"); return; }
    if (!NATIVE) { toast("Sprechen geht nur in der App"); return; }
    try { await DiktatP.start({ language: einst().diktat || "de-DE" }); }
    catch (e) { toast(e.message || String(e)); }
  },
  async stop() { if (NATIVE) { try { await DiktatP.stop(); } catch {} } this.aktiv = false; },
};
function satzAnhaengen(alt, neu) {
  neu = String(neu).trim(); if (!neu) return alt;
  neu = neu.charAt(0).toUpperCase() + neu.slice(1);
  if (!/[.!?]$/.test(neu)) neu += ".";
  alt = String(alt || "").replace(/\s+$/, "");
  return alt ? alt + " " + neu : neu;
}

// ---------- Claude: Punkte zusammenfassen ----------
const MODELLE = ["claude-sonnet-5-5", "claude-haiku-5-5"];
async function claude(prompt, maxTokens = 4000, onFortschritt, { modelle = MODELLE, onWarten } = {}) {
  const key = (einst().apiKey || "").trim();
  if (!key) throw new Error("Kein API-Schlüssel eingetragen");
  let letzter, wartungen = 0;
  for (let mi = 0; mi < modelle.length; mi++) {
    const model = modelle[mi];
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: prompt }] }),
      });
    } catch (e) { throw new Error("Keine Verbindung zu Claude – Netz prüfen und nochmal versuchen"); }
    if (r.ok) {
      // Antwort Stück für Stück lesen (hält die Verbindung am Leben)
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let puffer = "", text = "";
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          puffer += dec.decode(value, { stream: true });
          let nl;
          while ((nl = puffer.indexOf("\n")) >= 0) {
            const zeile = puffer.slice(0, nl).trim(); puffer = puffer.slice(nl + 1);
            if (!zeile.startsWith("data:")) continue;
            let ev; try { ev = JSON.parse(zeile.slice(5)); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta?.text) { text += ev.delta.text; onFortschritt?.(text.length); }
            if (ev.type === "error") throw new Error("Claude: " + (ev.error?.message || "Fehler"));
          }
        }
      } catch (e) { if (/Claude:/.test(e.message)) throw e; throw new Error("Verbindung zu Claude abgebrochen – bitte nochmal versuchen"); }
      return text;
    }
    let msg = ""; try { msg = (await r.json()).error?.message || ""; } catch {}
    // Limit pro Minute erreicht oder Claude ausgelastet: abwarten und dasselbe Modell nochmal
    if ((r.status === 429 || r.status === 529) && wartungen < 6) {
      wartungen++;
      let sek = parseInt(r.headers.get("retry-after") || "", 10); if (!(sek > 0)) sek = 20 * wartungen; sek = Math.min(sek + 2, 90);
      for (let rest = sek; rest > 0; rest--) { onWarten?.(rest, r.status); await new Promise((ok) => setTimeout(ok, 1000)); }
      mi--; continue;
    }
    letzter = new Error(r.status === 401 ? "API-Schlüssel ungültig" : r.status === 400 && /credit/i.test(msg) ? "Guthaben bei Anthropic aufgebraucht" : r.status === 529 || r.status === 429 ? "Claude ist gerade ausgelastet – bitte gleich nochmal" : `Fehler ${r.status} ${msg}`);
    if (r.status !== 404 && !/model/i.test(msg)) break;
  }
  throw letzter;
}
// Eine JSON-Zeile pro Objekt; eine abgeschnittene letzte Zeile wird einfach ignoriert
function jsonZeilen(text) {
  const out = [];
  for (let z of String(text).split("\n")) {
    z = z.trim().replace(/,$/, "");
    if (!z.startsWith("{")) continue;
    try {
      const o = JSON.parse(z);
      if (!o.typ && (o.ergaenzungen || o.neu)) out.push(...(o.ergaenzungen || []).map((x) => ({ typ: "ergaenzung", ...x })), ...(o.neu || []).map((x) => ({ typ: "neu", ...x })));
      else out.push(o);
    } catch {}
  }
  if (!out.length) {   // falls Claude doch ein Array geschickt hat
    try { const a = jsonAus(text); const arr = Array.isArray(a) ? a : [...(a.ergaenzungen || []).map((x) => ({ typ: "ergaenzung", ...x })), ...(a.neu || []).map((x) => ({ typ: "neu", ...x }))]; if (arr.length) return arr; } catch {}
    throw new Error("Antwort nicht lesbar" + (String(text).trim() ? "" : " (leer)"));
  }
  return out;
}
function jsonAus(text) {
  const t = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.search(/[[{]/), z = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  if (a >= 0 && z > a) return JSON.parse(t.slice(a, z + 1));
  throw new Error("Antwort nicht lesbar");
}
// Ohne Claude: Zuständige über Gewerk-Stichwörter erkennen
const STICHWORTE = [
  [/fliese|fliesen|piastrell|silikon|fuge/i, /fliesen/i],
  [/elektr|steckdose|schalter|licht|lampe|kabel|strom|elettric/i, /elektr/i],
  [/hydraul|install|sanit|wasser|heizung|abfluss|rohr|idraul/i, /hydraul/i],
  [/maler|gips|anstrich|ausmal|spachtel|pittor|cartongesso/i, /maler|gips/i],
  [/fenster|finestr/i, /fenster/i], [/t[üu]r|porta/i, /t[üu]ren|tischler/i], [/tischler|m[öo]bel|küche/i, /tischler/i],
  [/zimmer|dach|holzbau|tetto/i, /zimmer/i], [/schlosser|geländer|metall|fabbro/i, /schlosser/i],
  [/maurer|baufirma|baumeister|beton|mauer|estrich|muratore|impresa/i, /baufirma|baumeister/i],
  [/bagger|erdarbeit|aushub|scavo/i, /erdarbeit/i], [/markise|rollo|raffstore|verschatt|tenda/i, /verschatt/i],
  [/photovoltaik|\bpv\b|wärmepumpe|fotovolt/i, /photovoltaik/i], [/statik|statiker/i, /statiker/i],
];
function zustaendigRaten(text, bet) {
  const treffer = new Set();
  for (const k of bet) {
    if (k.firma && new RegExp("\\b" + k.firma.split(/\s+/)[0].replace(/[^\wäöüÄÖÜß]/g, ""), "i").test(text)) treffer.add(k.id);
    if (k.person && k.person.length > 2 && new RegExp("\\b" + k.person.split(/\s+/)[0], "i").test(text)) treffer.add(k.id);
  }
  if (!treffer.size) for (const [wort, gewerk] of STICHWORTE) if (wort.test(text)) for (const k of bet) if (gewerk.test(k.gewerk)) treffer.add(k.id);
  return [...treffer];
}
async function punkteAufbereiten(b, punkte, { mitMail = false } = {}) {
  const bet = beteiligte(b);
  if (!(einst().apiKey || "").trim()) {
    return punkte.map((p) => ({ i: p.i, titel: p.text.split(/[.\n,]/)[0].trim().slice(0, 60), art: "Mangel", beschreibung: p.text, kontaktIds: zustaendigRaten(p.text, bet), frist: "" }));
  }
  const it = einst().sprache === "Italienisch";
  const d = new Date();
  const prompt = `Du bist Bauleiter in Südtirol und schreibst ein Baustellenprotokoll.
Heute ist ${d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })} (ISO ${today()}).
Baustelle: ${b.name}${b.ort ? ", " + b.ort : ""}.
Beteiligte (id | Gewerk | Firma | Ansprechpartner):
${bet.map((k) => `${k.id} | ${k.gewerk} | ${k.firma} | ${k.person || "-"}`).join("\n") || "(keine)"}

Diktierte Punkte (Spracherkennung, kann Hör- und Grammatikfehler enthalten):
${punkte.map((p) => `[${p.i}] ${p.text}${p.fotos ? ` (${p.fotos} Foto${p.fotos > 1 ? "s" : ""})` : ""}`).join("\n")}

Mache aus jedem Punkt genau einen Protokollpunkt:
- titel: kurz, höchstens 8 Wörter
- art: "Mangel", "Aufgabe" oder "Notiz"
- beschreibung: sachlich und knapp im Protokollstil, 1–3 Sätze, ${it ? "auf Italienisch" : "auf Deutsch"}; Diktierfehler und Füllwörter korrigieren, nichts dazuerfinden
- kontaktIds: ids der zuständigen Beteiligten (über Gewerk, Firmen- oder Personennamen), sonst []
- frist: YYYY-MM-DD, wenn eine Frist genannt ist (z. B. "bis Freitag" relativ zu heute), sonst ""
${mitMail ? `- mail: {"betreff": "...", "text": "..."} an die Zuständigen, ${it ? "auf Italienisch" : "auf Deutsch"}, Anrede ${einst().anrede === "Du" ? "per Du" : "per Sie"} (mit Namen des Ansprechpartners, falls bekannt), kurz und freundlich, mit Baustelle, Problem und Frist; ${punkte[0]?.fotos ? "Hinweis auf Fotos im Anhang; " : ""}OHNE Grußformel und Signatur am Ende` : ""}
Antworte nur mit einem JSON-Array: [{"i":0,"titel":"","art":"Mangel","beschreibung":"","kontaktIds":[],"frist":""${mitMail ? ',"mail":{"betreff":"","text":""}' : ""}}]`;
  const arr = jsonAus(await claude(prompt, 1500 + punkte.length * 400));
  const ids = new Set(bet.map((k) => k.id));
  return punkte.map((p) => {
    const r = (Array.isArray(arr) ? arr : []).find((x) => +x.i === p.i) || {};
    return { i: p.i, titel: String(r.titel || p.text.slice(0, 60)), art: ART.includes(r.art) ? r.art : "Mangel", beschreibung: String(r.beschreibung || p.text),
      kontaktIds: (r.kontaktIds || []).map(String).filter((id) => ids.has(id)), frist: /^\d{4}-\d{2}-\d{2}$/.test(r.frist || "") ? r.frist : "", mail: r.mail };
  });
}

// ---------- Begehung (Rundgang) ----------
const punktHatInhalt = (p) => (p.text || "").trim() || (p.fotos || []).length;
function sheetBegehung(bid) {
  const b = baustelle(bid);
  let R = S.begehung[bid];
  const bet = beteiligte(b);
  const speichern = () => { S.begehung[bid] = R; persist(); };
  const aktuell = () => R.punkte[R.idx];

  const drawStart = () => {
    const sel = new Set(R?.anwesende || []);
    $panel.innerHTML = `<div class="bar"><h2>Begehung starten</h2><button class="iconbtn" data-x="close">×</button></div>
      <div class="sub">${esc(b.name)} · ${fmtDate(today())}</div>
      <div class="box"><h3>Anwesend</h3><div class="chips">${bet.map((k) => `<button class="chip" data-x="anw" data-id="${esc(k.id)}" aria-pressed="${sel.has(k.id)}">${esc(k.gewerk)}: ${esc(k.firma)}</button>`).join("") || `<span class="hint">Keine Beteiligten gewählt.</span>`}</div>
        <label for="r-sonst">Weitere Anwesende (Freitext)<input type="text" id="r-sonst" value="${esc(R?.sonstige || "")}" placeholder="z. B. Bauherr Fam. Dorfer"></label>
        <label for="r-wetter">Wetter (optional)<input type="text" id="r-wetter" value="${esc(R?.wetter || "")}" placeholder="z. B. sonnig, 8 °C"></label></div>
      <button class="btn primary big" data-x="los">Los geht's</button>`;
    $panel._anw = sel;
  };
  const drawAufnahme = () => {
    const p = aktuell(); const n = R.idx + 1;
    $panel.innerHTML = `<div class="bar"><h2>Punkt ${n}</h2><button class="btn" data-x="beenden">Beenden</button><button class="iconbtn" data-x="close" aria-label="Pause">⏸</button></div>
      <div class="box">
        <div class="photos">${p.fotos.map((f, i) => `<div class="photo">${fotoImg(bid, f)}<button data-x="foto-weg" data-i="${i}" aria-label="Foto entfernen">×</button></div>`).join("")}</div>
        <div class="row"><button class="btn primary" style="flex:2" data-x="kamera">${PC ? "Fotos hinzufügen" : "📷 Foto"}</button>${PC ? "" : `<button class="btn" style="flex:1" data-x="galerie">Galerie</button>`}</div>
      </div>
      <button class="mic ${Diktat.aktiv ? "on" : ""}" data-x="mic"><span class="dot"></span>${Diktat.aktiv ? "Aufnahme läuft · tippen = fertig" : PC ? "Diktieren: ins Textfeld klicken, dann Windows-Taste + H" : "Sprechen"}</button>
      <div class="partial" id="r-partial"></div>
      <textarea id="r-text" placeholder="z. B. Fliesenleger, im Bad OG ist die Silikonfuge gerissen, bis Freitag richten">${esc(p.text)}</textarea>
      <button class="btn primary big" data-x="weiter">Nächster Punkt ›</button>
      ${R.punkte.length > 1 ? `<div class="stack"><div class="hint">Bisher erfasst – antippen zum Ändern</div>${R.punkte.map((q, i) => `<button class="punkt ${i === R.idx ? "aktuell" : ""}" data-x="springe" data-i="${i}"><span><span class="nr">${i + 1}.</span> ${esc((q.text || "").slice(0, 90) || "(ohne Text)")}</span><span class="hint">${q.fotos.length} Foto${q.fotos.length === 1 ? "" : "s"}</span></button>`).join("")}</div>` : ""}`;
  };
  const leseText = () => { const ta = document.getElementById("r-text"); if (ta && R) { aktuell().text = ta.value; speichern(); } };
  const addFoto = async (path) => {
    const name = `${today()}_${slug(b.name)}_${Date.now().toString(36)}.jpg`;
    const rel = "fotos/" + name;
    await Filesystem.copy({ from: path, to: rel, toDirectory: DATA });
    S.lokal[name] = rel; aktuell().fotos.push(name); speichern();
  };
  const neuerPunkt = () => { R.punkte.push({ id: newId("p"), text: "", fotos: [], ts: Date.now() }); R.idx = R.punkte.length - 1; speichern(); };

  openSheet("", () => { if (Diktat.aktiv) Diktat.stop(); });
  V.eintragOffen = true;
  $panel.onclick = async (ev) => {
    const t = ev.target.closest("[data-x]"); if (!t) return;
    const x = t.dataset.x;
    if (x === "close") { leseText(); closeSheet(); render(); return; }
    if (x === "anw") { const id = t.dataset.id; const sel = $panel._anw; sel.has(id) ? sel.delete(id) : sel.add(id); t.setAttribute("aria-pressed", sel.has(id)); return; }
    if (x === "los") {
      R = { id: newId("g"), datum: today(), start: Date.now(), anwesende: [...$panel._anw], sonstige: document.getElementById("r-sonst").value.trim(), wetter: document.getElementById("r-wetter").value.trim(), punkte: [], idx: 0 };
      neuerPunkt(); drawAufnahme(); return;
    }
    if (x === "kamera") {
      leseText();
      try { for (const pfad of await fotoAufnehmen()) await addFoto(pfad); drawAufnahme(); }
      catch (e) { if (!/cancel/i.test(e.message || "")) toast("Kamera: " + (e.message || e)); }
      return;
    }
    if (x === "galerie") {
      leseText();
      try { const r = await Camera.pickImages({ quality: 80, width: 1800, limit: 10 }); for (const ph of r.photos) await addFoto(ph.path); drawAufnahme(); }
      catch (e) { if (!/cancel/i.test(e.message || "")) toast("Galerie: " + (e.message || e)); }
      return;
    }
    if (x === "foto-weg") { leseText(); aktuell().fotos.splice(+t.dataset.i, 1); speichern(); drawAufnahme(); return; }
    if (x === "mic") {
      leseText();
      if (Diktat.aktiv) { await Diktat.stop(); return; }
      Diktat.start({
        append: (txt) => { const ta = document.getElementById("r-text"); if (!ta) return; ta.value = satzAnhaengen(ta.value, txt); aktuell().text = ta.value; speichern(); },
        partial: (txt) => { const el = document.getElementById("r-partial"); if (el) el.textContent = txt; },
        state: () => { leseText(); drawAufnahme(); },
      });
      return;
    }
    if (x === "weiter") {
      if (Diktat.aktiv) await Diktat.stop();
      leseText();
      if (!punktHatInhalt(aktuell())) { toast("Dieser Punkt ist noch leer"); return; }
      const leer = R.punkte.findIndex((q, i) => i !== R.idx && !punktHatInhalt(q));
      if (leer >= 0) R.idx = leer; else neuerPunkt();
      drawAufnahme(); $panel.scrollTop = 0; return;
    }
    if (x === "springe") { if (Diktat.aktiv) await Diktat.stop(); leseText(); R.idx = +t.dataset.i; speichern(); drawAufnahme(); $panel.scrollTop = 0; return; }
    if (x === "beenden") {
      if (Diktat.aktiv) await Diktat.stop();
      leseText();
      const punkte = R.punkte.filter(punktHatInhalt);
      if (!punkte.length) { delete S.begehung[bid]; persist(); closeSheet(); render(); return; }
      t.disabled = true;
      $panel.innerHTML = `<div class="bar"><h2>Begehung auswerten</h2></div><div class="empty">${einst().apiKey ? "Claude fasst " + punkte.length + " Punkte zusammen …<br>(dauert ca. 10–30 Sekunden)" : "Punkte werden übernommen …"}</div>`;
      let res;
      try { res = await punkteAufbereiten(b, punkte.map((q, i) => ({ i, text: q.text || "(nur Foto)", fotos: q.fotos.length }))); }
      catch (e) {
        toast("Zusammenfassen nicht möglich – Text wird unverändert übernommen (" + (e.message || e) + ")");
        res = punkte.map((q, i) => ({ i, titel: (q.text || "Foto").split(/[.\n,]/)[0].slice(0, 60), art: "Mangel", beschreibung: q.text, kontaktIds: zustaendigRaten(q.text || "", bet), frist: "" }));
      }
      S.eintraege[bid] = S.eintraege[bid] || [];
      punkte.forEach((q, i) => {
        const r = res[i] || {};
        const E = { id: newId("e"), baustelleId: bid, ts: q.ts || Date.now(), begehungId: R.id, titel: r.titel, art: r.art || "Mangel", text: r.beschreibung || q.text, diktat: q.text,
          kontaktIds: r.kontaktIds || [], frist: r.frist || "", status: "offen", fotos: q.fotos, mail: { betreff: "", text: "" }, mailGesendet: false };
        upsert(S.eintraege[bid], E);
        for (const name of q.fotos) S.queue.push({ art: "foto", bid, name, lokal: S.lokal[name] });
      });
      S.letzteBegehung = S.letzteBegehung || {};
      S.letzteBegehung[bid] = { id: R.id, datum: R.datum, anwesende: R.anwesende, sonstige: R.sonstige, wetter: R.wetter };
      delete S.begehung[bid];
      closeSheet(); V.tab = "eintraege"; V.filter = "offen"; changed();
      toast(punkte.length + " Punkte übernommen – kurz prüfen, dann Protokoll erstellen");
      return;
    }
  };
  if (R) drawAufnahme(); else drawStart();
}

// ---------- Protokoll ----------
const protokolleVon = (bid) => live(S.protokolle[bid] || []).sort((a, b) => b.nr - a.nr);
function protokollPunkte(bid) {
  const letztes = protokolleVon(bid)[0];
  return eintraegeVon(bid).reverse().filter((e) => e.status !== "erledigt" || !e.protokollNr || (letztes && (e.erledigtAm || 0) > (letztes.erstellt || 0)));
}
function sheetProtokoll(bid) {
  const b = baustelle(bid); const bet = beteiligte(b);
  const nr = (protokolleVon(bid)[0]?.nr || 0) + 1;
  const lb = S.letzteBegehung?.[bid] || {};
  const sel = new Set(lb.anwesende || []);
  const punkte = protokollPunkte(bid);
  openSheet(`<div class="bar"><h2>Protokoll Nr. ${nr}</h2><button class="iconbtn" data-act="close-sheet">×</button></div>
    <label for="p-datum">Datum der Begehung<input type="date" id="p-datum" value="${esc(lb.datum || today())}"></label>
    <div class="box"><h3>Anwesend</h3><div class="chips">${bet.map((k) => `<button class="chip" data-pa="${esc(k.id)}" aria-pressed="${sel.has(k.id)}">${esc(k.gewerk)}: ${esc(k.firma)}</button>`).join("")}</div>
      <label for="p-sonst">Weitere Anwesende<input type="text" id="p-sonst" value="${esc(lb.sonstige || "")}"></label>
      <label for="p-wetter">Wetter<input type="text" id="p-wetter" value="${esc(lb.wetter || "")}"></label></div>
    <div class="box"><h3>Inhalt: ${punkte.length} Punkte</h3><div class="hint">${punkte.filter((e) => !e.protokollNr).length} neu · ${punkte.filter((e) => e.protokollNr && e.status !== "erledigt").length} weiterhin offen · ${punkte.filter((e) => e.status === "erledigt").length} erledigt</div></div>
    <button class="btn primary big" data-act="protokoll-go" data-id="${esc(bid)}">PDF erstellen</button>
    <div class="hint">Danach kannst du es ansehen und erst dann an alle senden.</div>`);
  V.protSel = sel;
  $panel.onclick = (ev) => { const c = ev.target.closest("[data-pa]"); if (!c) return; const id = c.dataset.pa; sel.has(id) ? sel.delete(id) : sel.add(id); c.setAttribute("aria-pressed", sel.has(id)); };
}
async function protokollErstellen(bid) {
  const b = baustelle(bid);
  const nr = (protokolleVon(bid)[0]?.nr || 0) + 1;
  const punkte = protokollPunkte(bid);
  const prot = { id: newId("pr"), nr, datum: document.getElementById("p-datum").value || today(), anwesende: [...V.protSel],
    sonstige: document.getElementById("p-sonst").value.trim(), wetter: document.getElementById("p-wetter").value.trim(), verfasser: S.meinName || S.auth?.name || "", erstellt: Date.now(), punkte: [] };
  closeSheet(); toast("Protokoll wird erstellt …");
  let lauf = 0;
  for (const e of punkte) {
    if (!e.protokollNr) { lauf++; e.nr = `${nr}.${String(lauf).padStart(2, "0")}`; e.protokollNr = nr; upsert(S.eintraege[bid], e); }
    prot.punkte.push(e.id);
  }
  // Fotos des Partners für das PDF holen
  if (einst().fotos !== "keine") for (const e of punkte) for (const f of e.fotos || []) { try { await ensureLocal(bid, f); } catch {} }
  const name = `Protokoll_${String(nr).padStart(2, "0")}_${slug(b.name)}_${prot.datum}.pdf`;
  prot.datei = name;
  const rel = "pdf/" + name;
  await Filesystem.writeFile({ path: rel, directory: DATA, data: await pdfProtokoll(b, prot, punkte) });
  S.lokal[name] = rel;
  await protokollWord(b, prot, punkte, true);
  S.protokolle[bid] = S.protokolle[bid] || [];
  upsert(S.protokolle[bid], prot);
  S.queue.push({ art: "protokoll", bid, name, lokal: rel });
  if (S.letzteBegehung) delete S.letzteBegehung[bid];
  V.tab = "protokolle"; changed();
  protokollFertigSheet(bid, prot);
}
function protokollFertigSheet(bid, prot) {
  openSheet(`<div class="bar"><h2>Protokoll Nr. ${prot.nr} erstellt</h2><button class="iconbtn" data-act="close-sheet">×</button></div>
    <div class="hint">☁ Wird automatisch in Dropbox gespeichert: 05-BAUSTELLE/Protokolle/${esc(prot.datei)}${prot.wordDatei ? " – dazu dieselbe Fassung als Word-Datei (.docx) zum Bearbeiten am PC" : ""}, auch ohne Senden.</div>
    <button class="btn big" data-act="protokoll-ansehen" data-b="${esc(bid)}" data-id="${esc(prot.id)}">Ansehen</button>
    <button class="btn primary big" data-act="protokoll-senden" data-b="${esc(bid)}" data-id="${esc(prot.id)}">Mail an alle vorbereiten (eM Client)</button>
    <div class="hint">Öffnet nur den Entwurf in eM Client – gesendet wird erst, wenn du dort auf Senden tippst.</div>
    <div class="hint">Fehler gefunden? Schließen, den Punkt unter „Punkte“ korrigieren und im Tab „Protokolle“ auf „Neu erstellen“ tippen.</div>`);
}
async function protokollAnsehen(bid, pid) {
  const prot = (S.protokolle[bid] || []).find((p) => p.id === pid);
  const rel = await ensureLocal(bid, prot.datei, "Protokolle");
  if (!NATIVE) { window.open(fileSrc(rel)); return; }
  await Mail.open({ path: absPath(rel), mime: "application/pdf" });
}
async function protokollNeuErstellen(bid, pid) {
  const b = baustelle(bid);
  const prot = { ...(S.protokolle[bid] || []).find((p) => p.id === pid) };
  if (S.meinName) prot.verfasser = S.meinName;   // geänderten Namen übernehmen
  const punkte = prot.punkte.map((id) => (S.eintraege[bid] || []).find((e) => e.id === id)).filter((e) => e && !e.geloescht);
  // neue Punkte seit dem Erstellen dieses Protokolls ebenfalls aufnehmen
  let lauf = punkte.filter((e) => e.protokollNr === prot.nr).length;
  for (const e of eintraegeVon(bid).reverse()) if (!e.protokollNr) { lauf++; e.nr = `${prot.nr}.${String(lauf).padStart(2, "0")}`; e.protokollNr = prot.nr; upsert(S.eintraege[bid], e); punkte.push(e); prot.punkte.push(e.id); }
  toast("Protokoll wird neu erstellt …");
  if (einst().fotos !== "keine") for (const e of punkte) for (const f of e.fotos || []) { try { await ensureLocal(bid, f); } catch {} }
  const rel = "pdf/" + prot.datei;
  await Filesystem.writeFile({ path: rel, directory: DATA, data: await pdfProtokoll(b, prot, punkte) });
  S.lokal[prot.datei] = rel;
  await protokollWord(b, prot, punkte, !prot.wordDatei);
  upsert(S.protokolle[bid], prot);
  S.queue = S.queue.filter((q) => q.name !== prot.datei);
  S.queue.push({ art: "protokoll", bid, name: prot.datei, lokal: rel });
  changed();
  protokollFertigSheet(bid, prot);
}
async function protokollSenden(bid, pid) {
  const b = baustelle(bid); const prot = (S.protokolle[bid] || []).find((p) => p.id === pid);
  const rel = await ensureLocal(bid, prot.datei, "Protokolle");
  const addrs = beteiligte(b).map(firstMail).filter(Boolean);
  const it = einst().sprache === "Italienisch"; const du = einst().anrede === "Du";
  const offen = (prot.punkte || []).map((id) => (S.eintraege[bid] || []).find((e) => e.id === id)).filter((e) => e && e.status !== "erledigt").length;
  const body = it
    ? `${du ? "Ciao a tutti" : "Gentili Signori"},\n\nin allegato il verbale di cantiere n. ${prot.nr} del ${fmtDate(prot.datum)} per il cantiere ${b.name}.\nPunti aperti: ${offen}. ${du ? "Vi prego" : "Vi preghiamo"} di rispettare le scadenze indicate.\n\n${einst().gruss || "Cordiali saluti"}`
    : `${du ? "Hallo zusammen" : "Sehr geehrte Damen und Herren"},\n\nanbei das Baustellenprotokoll Nr. ${prot.nr} vom ${fmtDate(prot.datum)} zur Baustelle ${b.name}.\nOffene Punkte: ${offen}. ${du ? "Bitte haltet" : "Wir bitten um Einhaltung"} der angegebenen Fristen${du ? " ein" : ""}.\n\n${einst().gruss || "Mit freundlichen Grüßen"}`;
  await openMail({ bcc: addrs, subject: (it ? `Verbale di cantiere n. ${prot.nr} – ` : `Baustellenprotokoll Nr. ${prot.nr} – `) + b.name, body, files: [rel] });
}
function protL() {
  const it = einst().sprache === "Italienisch";
  return it ? { titel: "Verbale di cantiere", nr: "n.", datum: "Sopralluogo del", anw: "Presenti", wetter: "Meteo", verf: "Redatto da", zust: "Competenza", frist: "Scadenza", offen: "aperto", erl: "completato", neu: "nuovo", seit: "dal verbale", allg: "Generale", uebers: "Riepilogo", fotos: "Foto" }
    : { titel: "Baustellenprotokoll", nr: "Nr.", datum: "Begehung am", anw: "Anwesend", wetter: "Wetter", verf: "Verfasst von", zust: "Zuständig", frist: "Frist", offen: "offen", erl: "erledigt", neu: "neu", seit: "seit Protokoll", allg: "Allgemein", uebers: "Übersicht", fotos: "Fotos" };
}
// Punkte nach Gewerk gruppiert (gleich für PDF und Word)
function protGruppen(b, punkte, L) {
  const gruppe = (e) => { const k = (e.kontaktIds || []).map(kontakt).filter(Boolean)[0]; return k ? k.gewerk : L.allg; };
  const order = beteiligte(b).map((k) => k.gewerk);
  return [...groupBy(punkte.map((e) => ({ ...e, _g: gruppe(e) })), "_g")].sort((a, c) => ((a[0] === L.allg) - (c[0] === L.allg)) || (order.indexOf(a[0]) - order.indexOf(c[0])));
}
async function pdfProtokoll(b, prot, punkte) {
  const L = protL();
  const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), X = 15, CW = W - 30;
  let y;
  const need = (h) => { if (y + h > H - 15) { doc.addPage(); y = 18; } };
  const text = (str, size = 10, style = "normal", color = 30) => { doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(color); };
  // Kopf
  text("", 9, "normal", 110);
  if (einst().buero) doc.text(pdfSafe(einst().buero), X, 14);
  doc.text(fmtDate(today()), W - X, 14, { align: "right" });
  text("", 18, "bold", 20); doc.text(pdfSafe(`${L.titel} ${L.nr} ${prot.nr}`), X, 26);
  text("", 11.5, "bold", 20); doc.text(pdfSafe([b.name, b.ort].filter(Boolean).join("  ·  ")), X, 33);
  doc.setDrawColor(232, 163, 23); doc.setLineWidth(0.8); doc.line(X, 37, W - X, 37);
  y = 44;
  const zeile = (label, wert) => { if (!wert) return; text("", 9.5, "bold", 60); doc.text(pdfSafe(label + ":"), X, y); text("", 9.5, "normal", 30); const l = doc.splitTextToSize(pdfSafe(wert), CW - 32); doc.text(l, X + 32, y); y += l.length * 4.3 + 1.2; };
  zeile(L.datum.replace(/ am$| del$/, ""), fmtDate(prot.datum));
  zeile(L.anw, [...prot.anwesende.map(kontakt).filter(Boolean).map((k) => k.firma + (k.person ? " (" + k.person + ")" : "")), prot.sonstige].filter(Boolean).join(", "));
  zeile(L.wetter, prot.wetter);
  zeile(L.verf, prot.verfasser);
  const anzahl = { neu: punkte.filter((e) => e.protokollNr === prot.nr).length, offen: punkte.filter((e) => e.status !== "erledigt").length, erl: punkte.filter((e) => e.status === "erledigt").length };
  zeile(L.uebers, `${anzahl.neu} ${L.neu} · ${anzahl.offen} ${L.offen} · ${anzahl.erl} ${L.erl}`);
  y += 3;
  // Punkte nach Gewerk
  const gruppen = protGruppen(b, punkte, L);
  const fotoModus = einst().fotos || "punkt";
  const alleFotos = [];
  const bild = async (name) => { const rel = S.lokal[name]; if (!rel) return null; try { const bl = await (await fetch(fileSrc(rel))).blob(); const bmp = await createImageBitmap(bl); return { url: "data:image/jpeg;base64," + await blobToB64(bl), w: bmp.width, h: bmp.height }; } catch { return null; } };
  const fotoReihe = async (namen, breite) => {
    const proZeile = Math.max(1, Math.floor((CW + 4) / (breite + 4)));
    for (let i = 0; i < namen.length; i += proZeile) {
      const bilder = (await Promise.all(namen.slice(i, i + proZeile).map(bild))).filter(Boolean);
      if (!bilder.length) continue;
      const hs = bilder.map((p) => Math.min(breite * p.h / p.w, breite * 1.1)); const rowH = Math.max(...hs);
      need(rowH + 2);
      bilder.forEach((p, j) => { const h = hs[j]; doc.addImage(p.url, "JPEG", X + j * (breite + 4), y, h * p.w / p.h, h); });
      y += rowH + 3;
    }
  };
  for (const [g, es] of gruppen) {
    need(14);
    doc.setFillColor(29, 36, 40); doc.rect(X, y - 4.5, CW, 7, "F");
    text("", 10.5, "bold", 255); doc.text(pdfSafe(g), X + 2, y);
    y += 6;
    for (const e of es) {
      const ks = (e.kontaktIds || []).map(kontakt).filter(Boolean);
      need(16);
      text("", 10.5, "bold", 20); doc.text(pdfSafe(e.nr || ""), X, y);
      const tl = doc.splitTextToSize(pdfSafe(e.titel || ""), CW - 50); doc.text(tl, X + 15, y);
      const st = e.status === "erledigt" ? L.erl : L.offen;
      if (e.status === "erledigt") doc.setTextColor(47, 122, 79); else doc.setTextColor(180, 71, 31);
      doc.text(pdfSafe(st.toUpperCase()), W - X, y, { align: "right" });
      y += tl.length * 4.8;
      text("", 9, "normal", 90);
      const meta = [ks.length ? `${L.zust}: ${ks.map((k) => k.firma).join(", ")}` : "", e.frist ? `${L.frist}: ${fmtDate(e.frist)}` : "", e.protokollNr && e.protokollNr !== prot.nr ? `${L.seit} ${e.protokollNr}` : ""].filter(Boolean).join("   ·   ");
      if (meta) { const ml = doc.splitTextToSize(pdfSafe(meta), CW - 15); doc.text(ml, X + 15, y); y += ml.length * 4 + 0.5; }
      text("", 10, "normal", 30);
      for (const line of doc.splitTextToSize(pdfSafe(e.text || ""), CW - 15)) { need(5); doc.text(line, X + 15, y); y += 4.6; }
      const fotos = (e.fotos || []).filter((f) => S.lokal[f]);
      if (fotos.length && fotoModus === "punkt") { y += 1.5; const xs = X; await (async () => { const alt = X; await fotoReihe(fotos, 52); })(); }
      if (fotos.length && fotoModus === "ende") { alleFotos.push([e.nr, fotos]); text("", 9, "italic", 110); doc.text(pdfSafe(`${L.fotos}: ${fotos.length}`), X + 15, y); y += 4.5; }
      y += 2.5; doc.setDrawColor(220); doc.setLineWidth(0.2); doc.line(X + 15, y - 1.5, W - X, y - 1.5); y += 2;
    }
    y += 2;
  }
  if (fotoModus === "ende" && alleFotos.length) {
    doc.addPage(); y = 20; text("", 14, "bold", 20); doc.text(pdfSafe(L.fotos), X, y); y += 8;
    for (const [nr, fotos] of alleFotos) { need(10); text("", 10, "bold", 20); doc.text(pdfSafe(nr || ""), X, y); y += 4; await fotoReihe(fotos, 84); }
  }
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) { doc.setPage(i); text("", 8, "normal", 130); doc.text(pdfSafe(`${b.name} · ${L.titel} ${L.nr} ${prot.nr} · ${i}/${n}`), W - X, H - 8, { align: "right" }); }
  return doc.output("datauristring").split(",")[1];
}

// Protokoll als Word-Datei (zum Weiterbearbeiten am PC)
async function wordProtokoll(b, prot, punkte) {
  const D = window.docx; const L = protL();
  const R = (text, o = {}) => new D.TextRun({ text: String(text ?? ""), size: o.size || 20, bold: !!o.bold, italics: !!o.italic, color: o.color });
  const P = (runs, o = {}) => new D.Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { after: o.after ?? 60, before: o.before ?? 0 }, indent: o.indent ? { left: o.indent } : undefined, keepNext: !!o.keepNext, alignment: o.align });
  const fotoModus = einst().fotos || "punkt";
  const bild = async (name, breiteMm) => {
    const rel = S.lokal[name]; if (!rel) return null;
    try {
      const bl = await (await fetch(fileSrc(rel))).blob(); const bmp = await createImageBitmap(bl);
      const w = Math.round(breiteMm * 3.78); const h = Math.round(Math.min(w * bmp.height / bmp.width, w * 1.1));
      return new D.ImageRun({ type: "jpg", data: new Uint8Array(await bl.arrayBuffer()), transformation: { width: Math.round(h * bmp.width / bmp.height), height: h } });
    } catch { return null; }
  };
  const fotoAbsatz = async (namen, breiteMm, indent) => {
    const imgs = (await Promise.all(namen.map((n) => bild(n, breiteMm)))).filter(Boolean);
    if (!imgs.length) return [];
    const runs = []; imgs.forEach((im, i) => { if (i) runs.push(R("  ")); runs.push(im); });
    return [P(runs, { indent, after: 120 })];
  };
  const anzahl = { neu: punkte.filter((e) => e.protokollNr === prot.nr).length, offen: punkte.filter((e) => e.status !== "erledigt").length, erl: punkte.filter((e) => e.status === "erledigt").length };
  const kopfZeile = (label, wert) => wert ? [P([R(label + ": ", { bold: true, color: "3C3C3C" }), R(wert)])] : [];
  const kinder = [
    ...(einst().buero ? [P(R(einst().buero, { size: 17, color: "6E6E6E" }))] : []),
    P(R(`${L.titel} ${L.nr} ${prot.nr}`, { size: 36, bold: true, color: "1D2428" }), { after: 40 }),
    new D.Paragraph({ children: [R([b.name, b.ort].filter(Boolean).join("  ·  "), { size: 24, bold: true })], spacing: { after: 160 }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: "E8A317", space: 4 } } }),
    ...kopfZeile(L.datum.replace(/ am$| del$/, ""), fmtDate(prot.datum)),
    ...kopfZeile(L.anw, [...prot.anwesende.map(kontakt).filter(Boolean).map((k) => k.firma + (k.person ? " (" + k.person + ")" : "")), prot.sonstige].filter(Boolean).join(", ")),
    ...kopfZeile(L.wetter, prot.wetter),
    ...kopfZeile(L.verf, prot.verfasser),
    ...kopfZeile(L.uebers, `${anzahl.neu} ${L.neu} · ${anzahl.offen} ${L.offen} · ${anzahl.erl} ${L.erl}`),
  ];
  const alleFotos = [];
  for (const [g, es] of protGruppen(b, punkte, L)) {
    kinder.push(new D.Paragraph({ children: [R(g, { bold: true, color: "FFFFFF", size: 21 })], shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "1D2428" }, spacing: { before: 240, after: 100 }, keepNext: true }));
    for (const e of es) {
      const ks = (e.kontaktIds || []).map(kontakt).filter(Boolean);
      const erl = e.status === "erledigt";
      kinder.push(P([R((e.nr || "") + "   ", { bold: true }), R(e.titel || "", { bold: true }), R("   " + (erl ? L.erl : L.offen).toUpperCase(), { bold: true, size: 17, color: erl ? "2F7A4F" : "B4471F" })], { keepNext: true, after: 40 }));
      const meta = [ks.length ? `${L.zust}: ${ks.map((k) => k.firma).join(", ")}` : "", e.frist ? `${L.frist}: ${fmtDate(e.frist)}` : "", e.protokollNr && e.protokollNr !== prot.nr ? `${L.seit} ${e.protokollNr}` : ""].filter(Boolean).join("   ·   ");
      if (meta) kinder.push(P(R(meta, { size: 17, color: "5A5A5A" }), { indent: 600, after: 40 }));
      for (const z of String(e.text || "").split("\n")) kinder.push(P(R(z), { indent: 600, after: 40 }));
      const fotos = (e.fotos || []).filter((f) => S.lokal[f]);
      if (fotos.length && fotoModus === "punkt") kinder.push(...await fotoAbsatz(fotos, 52, 600));
      if (fotos.length && fotoModus === "ende") { alleFotos.push([e.nr, fotos]); kinder.push(P(R(`${L.fotos}: ${fotos.length}`, { italic: true, size: 17, color: "6E6E6E" }), { indent: 600 })); }
      kinder.push(new D.Paragraph({ children: [], spacing: { after: 120 }, indent: { left: 600 }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 2, color: "DCDCDC", space: 2 } } }));
    }
  }
  if (fotoModus === "ende" && alleFotos.length) {
    kinder.push(new D.Paragraph({ pageBreakBefore: true, children: [R(L.fotos, { bold: true, size: 28 })], spacing: { after: 160 } }));
    for (const [nr, fotos] of alleFotos) { kinder.push(P(R(nr || "", { bold: true }), { keepNext: true })); kinder.push(...await fotoAbsatz(fotos, 84, 0)); }
  }
  const doc = new D.Document({
    styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 850, right: 850 } } },
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [R(`${b.name} · ${L.titel} ${L.nr} ${prot.nr} · `, { size: 16, color: "828282" }), new D.TextRun({ children: [D.PageNumber.CURRENT], size: 16, color: "828282" }), R("/", { size: 16, color: "828282" }), new D.TextRun({ children: [D.PageNumber.TOTAL_PAGES], size: 16, color: "828282" })] })] }) },
      children: kinder,
    }],
  });
  return await D.Packer.toBase64String(doc);
}
const wordName = (pdf) => pdf.replace(/\.pdf$/i, ".docx");
// Word-Datei des Protokolls schreiben und hochladen – aber nie eine von Hand geänderte überschreiben
async function protokollWord(b, prot, punkte, neu) {
  const name = wordName(prot.datei);
  if (!neu && prot.wordRev && S.auth && V.online) {
    try {
      const m = await Dropbox.rpc("files/get_metadata", { path: bPath(b, "/Protokolle/" + name) });
      if (m.rev && m.rev !== prot.wordRev) { toast("Word-Datei wurde von Hand geändert – sie bleibt unverändert, nur das PDF ist neu"); return; }
    } catch (e) { if (!e.notFound) { toast("Word-Datei nicht geprüft – bleibt unverändert"); return; } }
  }
  try {
    const rel = "pdf/" + name;
    await Filesystem.writeFile({ path: rel, directory: DATA, data: await wordProtokoll(b, prot, punkte) });
    S.lokal[name] = rel; prot.wordDatei = name;
    S.queue = S.queue.filter((q) => q.name !== name);
    S.queue.push({ art: "protokoll", bid: b.id, name, lokal: rel, word: prot.id });
  } catch (e) { console.error(e); toast("Word-Datei konnte nicht erstellt werden: " + (e.message || e)); }
}
// Am PC: die Word-Datei direkt im Dropbox-Ordner öffnen (Änderungen landen so in Dropbox)
async function protokollWordOeffnen(bid, pid) {
  const b = baustelle(bid); const prot = (S.protokolle[bid] || []).find((p) => p.id === pid);
  const name = prot.wordDatei;
  if (S.queue.some((q) => q.name === name)) { toast("Word-Datei wird noch hochgeladen – gleich nochmal versuchen"); scheduleSync(100); return; }
  try {
    const m = await Dropbox.rpc("files/get_metadata", { path: bPath(b, "/Protokolle/" + name) });
    const pfad = await window.desktop.invoke("dropbox:lokal", { pfad: m.path_display });
    if (pfad) { await Mail.open({ path: pfad }); toast("Geöffnet aus deinem Dropbox-Ordner – Speichern in Word genügt"); return; }
    toast("Dropbox-Ordner auf diesem PC nicht gefunden – öffne die Datei bitte direkt im Dropbox-Ordner (Protokolle)");
  } catch (e) { toast("Öffnen fehlgeschlagen: " + (e.summary || e.message || e)); }
}

// ---------- Word-Liste der Beteiligten (Quelle des Adressbuchs) ----------
// Liegt eine .docx im gemeinsamen App-Ordner, ist sie die Quelle: Bei jeder Änderung
// liest die App sie neu ein (mit Claude) und gleicht das Adressbuch ab.
async function wordText(blob) {
  const zip = await JSZip.loadAsync(blob);
  const xml = await zip.file("word/document.xml").async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const zeilen = [];
  for (const p of doc.getElementsByTagNameNS(W, "p")) {
    let t = "";
    for (const n of p.getElementsByTagNameNS(W, "*")) {
      if (n.localName === "t") t += n.textContent;
      else if (n.localName === "tab") t += " ";
      else if (n.localName === "br") t += "\n";
    }
    if (t.trim()) zeilen.push(t.trim());
  }
  return zeilen.join("\n");
}
const normFirma = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\b(gmbh|kg|ohg|snc|sas|srl|srls|ag|des|di|d\.|&|co\.?|und)\b/g, "").replace(/[^a-z0-9]/g, "");
async function wordListeAbgleichen(erzwingen = false) {
  const e0 = einst();
  let eintraege;
  try { eintraege = (await Dropbox.rpc("files/list_folder", { path: appPath("") })).entries; } catch { return; }
  const datei = eintraege.filter((e) => e[".tag"] === "file" && /\.docx$/i.test(e.name) && !e.name.startsWith("~$")).sort((a, b) => (b.server_modified > a.server_modified ? 1 : -1))[0];
  V.wordDatei = datei ? { name: datei.name, stand: datei.server_modified, neu: e0.wordRev !== datei.rev } : null;
  if (!datei || !erzwingen) return;   // eingelesen wird nur auf Knopfdruck
  if (!(e0.apiKey || "").trim()) { S.syncFehler = "Word-Liste gefunden – zum Einlesen bitte API-Schlüssel eintragen"; return; }
  V.wordStatus = "Lese Word-Liste „" + datei.name + "“ ein … (dauert ca. 1 Minute)"; renderSync();
  try {
    const blob = await Dropbox.download(datei.path_lower);
    const text = (await wordText(blob)).slice(0, 60000);
    const prompt = `Hier ist eine Firmen- und Technikerliste eines Architekturbüros in Südtirol (Text aus einer Word-Datei). Zwischenüberschriften wie "Elektriker", "Hydrauliker", "Statiker" geben das Gewerk bzw. die Rolle der folgenden Einträge an.

Mache daraus eine Kontaktliste. Für jede Firma bzw. Person genau ein Eintrag:
- gewerk: das Gewerk/die Rolle aus der Zwischenüberschrift (kurz, z. B. "Elektriker", "Fliesen", "Baufirma", "Statiker", "Fenster", "Zimmerer")
- gruppe: "Techniker" für Planer, Techniker, Statiker, Geologen, Geometer, Sicherheitskoordinatoren, Architekten, Akustiker, Klimahaus-Techniker; sonst "Firma"
- firma: Firmen- bzw. Personenname wie in der Liste
- person: Ansprechpartner, falls genannt (z. B. Name in Klammern hinter einer Telefonnummer), sonst ""
- adresse: Straße, PLZ, Ort in einer Zeile, sonst ""
- tel: Liste von {"nr": "...", "name": "..."} (name = Person zur Nummer, sonst "")
- email: normale E-Mail-Adressen; pec: PEC-Adressen (zertifizierte Mail, oft "pec" oder "legalmail" im Namen oder als PEC bezeichnet)
- notiz: kurze sonstige Hinweise aus der Liste (z. B. "Empfehlung von …", "neu seit …"), sonst ""
Lass Steuernummern, MwSt.-Nummern, Geburtsdaten, Handelskammer-Daten und Ähnliches weg. Erfinde nichts.

Antworte nur mit einem JSON-Array.

LISTE:
${text}`;
    const arr = jsonAus(await claude(prompt, 32000));
    if (!Array.isArray(arr) || arr.length < 3) throw new Error("Liste nicht erkannt");
    // Abgleich: bestehende Kontakte am Namen bzw. an der Mailadresse wiedererkennen (IDs bleiben)
    const alt = live(S.kontakte);
    const verwendet = new Set(S.baustellen.flatMap((b) => b.beteiligte || []));
    const gesehen = new Set();
    let neu = 0, geaendert = 0;
    for (const r of arr) {
      if (!r || !r.firma) continue;
      const mails = [...(r.email || []), ...(r.pec || [])].map((m) => String(m).toLowerCase());
      const k = alt.find((x) => !gesehen.has(x.id) && normFirma(x.firma) === normFirma(r.firma) && (x.gewerk || "") === (r.gewerk || x.gewerk))
        || alt.find((x) => !gesehen.has(x.id) && normFirma(x.firma) === normFirma(r.firma))
        || alt.find((x) => !gesehen.has(x.id) && mails.length && [...(x.email || []), ...(x.pec || [])].some((m) => mails.includes(String(m).toLowerCase())));
      const rec = { id: k ? k.id : newId("k"), quelle: "word", gewerk: String(r.gewerk || "Sonstige"), gruppe: r.gruppe === "Techniker" ? "Techniker" : "Firma", firma: String(r.firma), person: String(r.person || ""),
        adresse: String(r.adresse || ""), tel: (r.tel || []).map((t) => (typeof t === "string" ? { nr: t, name: "" } : { nr: String(t.nr || ""), name: String(t.name || "") })).filter((t) => t.nr),
        email: (r.email || []).map(String), pec: (r.pec || []).map(String), notiz: String(r.notiz || "") };
      gesehen.add(rec.id);
      if (!k) { neu++; upsert(S.kontakte, rec); }
      else { const vorher = JSON.stringify({ ...k, geaendert: 0 }); const nachher = JSON.stringify({ ...k, ...rec, geaendert: 0 }); if (vorher !== nachher) { geaendert++; upsert(S.kontakte, { ...k, ...rec }); } }
    }
    let entfernt = 0;
    for (const k of alt) if (!gesehen.has(k.id)) {
      if (verwendet.has(k.id)) { if (!/nicht mehr in der Word-Liste/.test(k.notiz || "")) upsert(S.kontakte, { ...k, notiz: ((k.notiz || "") + " · nicht mehr in der Word-Liste").replace(/^ · /, "") }); }
      else { upsert(S.kontakte, { ...k, geloescht: true }); entfernt++; }
    }
    upsert(S.einst, { ...einst(), id: "allgemein", wordRev: datei.rev, wordName: datei.name, wordStand: datei.server_modified });
    V.wordDatei.neu = false;
    toast(`Word-Liste eingelesen: ${neu} neu, ${geaendert} geändert, ${entfernt} entfernt`);
  } catch (e) {
    S.syncFehler = "Word-Liste konnte nicht eingelesen werden: " + (e.message || e);
  } finally { V.wordStatus = ""; }
}

// ---------- Handykontakte abgleichen und in die Word-Liste schreiben ----------
const Contacts = registerPlugin("Contacts");
const GEWERK_WORTE = /maler|gips|baumeister|bauunternehm|baufirma|maurer|fliese|plattenleg|elektr|hydraul|installat|sanit[äa]r|heizung|l[üu]ftung|klima|tischler|schreiner|zimmer|holzbau|dachdeck|spengler|schlosser|metallbau|schmied|fenster|t[üu]ren|glaser|boden|parkett|estrich|putz|isolier|d[äa]mm|gerüst|kran|bagger|erdbau|erdarbeit|tiefbau|transport|abbruch|pflaster|gärtner|garten|stein|marmor|naturstein|statik|statiker|geometer|geologe|vermess|architekt|ingenieur|\bing\.|\bgeom\.|\barch\.|planer|photovolt|\bpv\b|solar|w[äa]rmepumpe|alarm|markise|rollo|jalousie|verschatt|aufzug|lift|küche|möbel|schwimmbad|pool|imbianc|pittor|piastrell|idraul|elettric|falegnam|carpent|fabbro|lattoniere|impresa|edil|muratore|geometra|ingegnere|serrament|cantiere/i;
async function handyKontakteLesen() {
  const p = await Contacts.requestPermissions();
  if (p.contacts !== "granted") throw new Error("Zugriff auf die Kontakte wurde nicht erlaubt");
  const r = await Contacts.getContacts({ projection: { name: true, organization: true, phones: true, emails: true, note: true } });
  return (r.contacts || []).map((c) => ({
    name: c.name?.display || [c.name?.given, c.name?.family].filter(Boolean).join(" "),
    firma: c.organization?.company || "", titel: c.organization?.jobTitle || "", notiz: (c.note || "").slice(0, 80),
    tel: (c.phones || []).map((x) => x.number).filter(Boolean), email: (c.emails || []).map((x) => x.address).filter(Boolean),
  })).filter((c) => (c.name || c.firma) && (c.tel.length || c.email.length));
}
// Auf dem Handy vorsortieren: nur Kontakte, die zu einer Firma der Liste passen oder ein Gewerk im Namen tragen
function kandidaten(handy, liste) {
  const woerter = new Set();
  const ALLGEMEIN = /^(gmbh|des|und|der|die|das|elektro|bauunternehmen|bauunternehmung|tischlerei|zimmerei|holzbau|metallbau|malerarbeiten|fenster|fensterbau|technik|service|italien|italia|ohg|snc|sas|srl|srls|bau|baufirma|hydraulik|thomas|andreas|martin|michael|robert|walter|paul|franz|josef|peter|markus|stefan|christian|manfred|werner|hannes|simon|tobias|alexander|luca|marco|giulio|andrea|alessandro|roman|norbert|diego|enzio|erich|ivan)$/;
  for (const k of liste) for (const w of String(k.firma || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/))
    if (w.length >= 5 && !ALLGEMEIN.test(w)) woerter.add(w);
  const mails = new Set(liste.flatMap((k) => [...(k.email || []), ...(k.pec || [])]).map((m) => m.toLowerCase()));
  const domains = new Set([...mails].map((m) => m.split("@")[1]).filter((d) => d && !/gmail|yahoo|hotmail|libero|alice|virgilio|outlook|gmx|rolmail|pec|legalmail|tin\.it|icloud/.test(d)));
  return handy.filter((c) => {
    const txt = [c.name, c.firma, c.titel, c.notiz].join(" ");
    const norm = txt.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (GEWERK_WORTE.test(txt)) return true;
    if (c.email.some((m) => mails.has(m.toLowerCase()) || domains.has(m.toLowerCase().split("@")[1]))) return true;
    return norm.split(/[^a-z0-9]+/).some((w) => w.length >= 5 && woerter.has(w));
  }).slice(0, 300);
}
async function kontakteAbgleichen() {
  const liste = live(S.kontakte);
  V.kaStatus = "Lese Handykontakte …"; sheetKontaktAbgleich();
  const handy = await handyKontakteLesen();
  const kand = kandidaten(handy, liste);
  if (!kand.length) throw new Error("Keine passenden Handykontakte gefunden");
  const PORTION = 30, teile = Math.ceil(kand.length / PORTION);
  const r = { ergaenzungen: [], neu: [] };
  for (let t = 0; t < teile; t++) {
    const teil = kand.slice(t * PORTION, (t + 1) * PORTION);
    V.kaStatus = `Claude vergleicht ${kand.length} von ${handy.length} Handykontakten mit eurer Liste … Teil ${t + 1} von ${teile}`; sheetKontaktAbgleich();
    const prompt = `Abgleich zwischen der Firmenliste eines Architekturbüros in Südtirol und den Handykontakten des Architekten.

  FIRMENLISTE (id | Gewerk | Firma | Ansprechpartner | Telefon | E-Mail/PEC):
  ${liste.map((k) => `${k.id} | ${k.gewerk} | ${k.firma} | ${k.person || "-"} | ${(k.tel || []).map((t) => t.nr).join(", ") || "-"} | ${[...(k.email || []), ...(k.pec || [])].join(", ") || "-"}`).join("\n")}

  HANDYKONTAKTE (Nr | Name | Firma | Telefon | E-Mail):
  ${teil.map((c, i) => `${i} | ${c.name} | ${c.firma || "-"} | ${c.tel.join(", ") || "-"} | ${c.email.join(", ") || "-"}`).join("\n")}

  Aufgaben:
  1. ergaenzungen: Für Firmen der Liste, zu denen ein Handykontakt eindeutig passt (gleiche Firma, gleicher Ansprechpartner oder gleiche E-Mail), schlage Telefonnummern und E-Mail-Adressen vor, die in der Liste noch FEHLEN. Nichts vorschlagen, was schon drinsteht (auch nicht in anderer Schreibweise).
  2. neu: Handykontakte, die erkennbar Handwerker, Baufirmen, Techniker oder Planer sind (z. B. "Maler Tobias", "Baumeister Gius", "Fliesen Huber", Firmennamen mit Gewerk), aber in der Liste fehlen. Leite das Gewerk ab und verwende möglichst die Gewerk-Bezeichnungen der Liste. Private Kontakte ohne Bezug zum Bau weglassen.
  Bei unsicheren Zuordnungen "sicher": false.

  Antworte NUR mit JSON-Zeilen, genau ein Objekt pro Zeile, ohne Code-Block und ohne weiteren Text:
  {"typ":"ergaenzung","id":"…","tel":["…"],"email":["…"],"handy":"Name des Handykontakts","sicher":true}
  {"typ":"neu","gewerk":"…","gruppe":"Firma","firma":"…","person":"…","tel":["…"],"email":["…"],"handy":"Name des Handykontakts","sicher":true}
  Wenn es nichts gibt, antworte mit genau einer Zeile: {"typ":"nichts"}`;
    let antwort, versuch = 0;
    for (;;) {
      try {
        antwort = jsonZeilen(await claude(prompt, 8000, null, {
          modelle: ["claude-haiku-5-5", ...MODELLE],
          onWarten: (rest, st) => { V.kaStatus = `Teil ${t + 1} von ${teile}: ${st === 429 ? "Claude-Limit pro Minute erreicht" : "Claude ist ausgelastet"} – warte ${rest} s …`; sheetKontaktAbgleich(); },
        }));
        break;
      } catch (e) {
        if (++versuch >= 3) throw new Error(`Teil ${t + 1} von ${teile}: ${e.message || e}`);
        V.kaStatus = `Teil ${t + 1} von ${teile}: ${e.message || "Fehler"} – neuer Versuch in 10 s …`; sheetKontaktAbgleich(); await new Promise((ok) => setTimeout(ok, 10000));
      }
    }
    r.ergaenzungen.push(...antwort.filter((x) => x.typ === "ergaenzung"));
    for (const n of antwort.filter((x) => x.typ === "neu")) if (!r.neu.some((x) => normFirma(x.firma) === normFirma(n.firma))) r.neu.push(n);
  }
  const ids = new Set(liste.map((k) => k.id));
  V.kaVorschlaege = {
    ergaenzungen: Object.values((r.ergaenzungen || []).filter((e) => ids.has(e.id) && ((e.tel || []).length || (e.email || []).length)).reduce((m, e) => {
      const x = m[e.id] || (m[e.id] = { ...e, tel: [], email: [] });
      for (const t of e.tel || []) if (!x.tel.includes(t)) x.tel.push(t);
      for (const a of e.email || []) if (!x.email.includes(a)) x.email.push(a);
      if (e.sicher === false) x.sicher = false; return m; }, {})).map((e, i) => ({ ...e, key: "e" + i, an: e.sicher !== false })),
    neu: (r.neu || []).filter((n) => n.firma).map((n, i) => ({ ...n, key: "n" + i, an: n.sicher !== false })),
  };
  V.kaStatus = ""; sheetKontaktAbgleich();
}
function sheetKontaktAbgleich() {
  const v = V.kaVorschlaege;
  let body;
  if (V.kaStatus) body = `<div class="empty">${esc(V.kaStatus)}</div>`;
  else if (!v) body = `<div class="card stack"><div>Die App sucht in deinen Handykontakten nach</div><ul style="margin:0;padding-left:20px"><li>fehlenden <b>Telefonnummern und E-Mails</b> von Firmen eurer Liste</li><li><b>neuen Firmen</b> wie „Maler Tobias“ oder „Fliesen Huber“</li></ul>
      <div class="hint">Nur Kontakte, die zu einer Firma passen oder ein Gewerk im Namen haben, gehen an Claude – private Kontakte nicht. Kosten: ein paar Cent.</div>
      <button class="btn primary big" data-ka="start">Handykontakte durchsuchen</button></div>`;
  else {
    const ers = v.ergaenzungen, neu = v.neu;
    const kn = (id) => kontakt(id);
    body = `${ers.length ? `<h3>Ergänzungen (${ers.length})</h3>${ers.map((e) => `<label class="pick"><input type="checkbox" data-kak="${e.key}" ${e.an ? "checked" : ""}><span><b>${esc(kn(e.id)?.firma || "?")}</b><br>${[...(e.tel || []).map((t) => "☎ " + esc(t)), ...(e.email || []).map((m) => "@ " + esc(m))].join("<br>")}<br><span class="hint">aus „${esc(e.handy || "")}“${e.sicher === false ? " · unsicher" : ""}</span></span></label>`).join("")}` : ""}
      ${neu.length ? `<h3 style="margin-top:12px">Neue Firmen (${neu.length})</h3>${neu.map((n) => `<label class="pick"><input type="checkbox" data-kak="${n.key}" ${n.an ? "checked" : ""}><span><b>${esc(n.gewerk)}: ${esc(n.firma)}</b>${n.person ? " · " + esc(n.person) : ""}<br>${[...(n.tel || []).map((t) => "☎ " + esc(t)), ...(n.email || []).map((m) => "@ " + esc(m))].join("<br>")}<br><span class="hint">aus „${esc(n.handy || "")}“${n.sicher === false ? " · unsicher" : ""}</span></span></label>`).join("")}` : ""}
      ${!ers.length && !neu.length ? `<div class="empty">Nichts gefunden – die Liste ist schon vollständig.</div>` : `<button class="btn primary big" data-ka="schreiben">Angehakte in die Word-Liste schreiben</button><div class="hint">Vorher wird automatisch eine Sicherungskopie der Word-Datei angelegt (Ordner „Sicherungen“).</div>`}`;
  }
  openSheet(`<div class="bar"><h2>Mit Handykontakten abgleichen</h2><button class="iconbtn" data-ka="zu">×</button></div>${V.kaFehler ? `<div class="banner">Abgebrochen: ${esc(V.kaFehler)}</div>` : ""}${body}`);
  $panel.onchange = (ev) => { const k = ev.target.dataset?.kak; if (!k) return; const x = [...(v?.ergaenzungen || []), ...(v?.neu || [])].find((y) => y.key === k); if (x) x.an = ev.target.checked; };
  $panel.onclick = async (ev) => {
    const t = ev.target.closest("[data-ka]"); if (!t) return;
    if (t.dataset.ka === "zu") { if (!V.kaStatus) { V.kaVorschlaege = null; closeSheet(); } return; }
    if (t.dataset.ka === "start") { try { await kontakteAbgleichen(); } catch (e) { V.kaStatus = ""; V.kaFehler = e.message || String(e); sheetKontaktAbgleich(); V.kaFehler = ""; } }
    if (t.dataset.ka === "schreiben") { try { await inWordSchreiben(); } catch (e) { console.error(e); V.kaStatus = ""; V.kaFehler = "Schreiben: " + (e.message || e); sheetKontaktAbgleich(); V.kaFehler = ""; } }
  };
}
// Word-Datei bearbeiten: Absätze einfügen, Format der Nachbarzeile übernehmen
async function inWordSchreiben(ersIn, neuIn, { mitziehen = true } = {}) {
  const v = V.kaVorschlaege;
  const ers = ersIn || v.ergaenzungen.filter((e) => e.an), neu = neuIn || v.neu.filter((n) => n.an);
  if (!ers.length && !neu.length) { toast("Nichts angehakt"); return; }
  V.kaStatus = "Word-Datei wird vorbereitet …"; sheetKontaktAbgleich();
  const eintr = (await Dropbox.rpc("files/list_folder", { path: appPath("") })).entries;
  const datei = eintr.filter((e) => e[".tag"] === "file" && /\.docx$/i.test(e.name) && !e.name.startsWith("~$")).sort((a, b) => (b.server_modified > a.server_modified ? 1 : -1))[0];
  if (!datei) throw new Error("Keine Word-Datei im gemeinsamen Ordner");
  const blob = await Dropbox.download(datei.path_lower);
  const zip = await JSZip.loadAsync(blob);
  const xml = await zip.file("word/document.xml").async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const body = doc.getElementsByTagNameNS(WNS, "body")[0];
  const absaetze = [...doc.getElementsByTagNameNS(WNS, "p")];
  const textVon = (p) => [...p.getElementsByTagNameNS(WNS, "t")].map((n) => n.textContent).join("").trim();
  const nummeriert = absaetze.map((p, i) => [i, textVon(p)]).filter(([, t]) => t);
  // Claude bestimmt, wo eingefügt wird und welche Zeile als Formatvorlage dient
  const auftraege = [
    ...ers.map((e) => ({ art: "ergaenzung", firma: kontakt(e.id)?.firma, gewerk: kontakt(e.id)?.gewerk, tel: e.tel || [], email: e.email || [] })),
    ...neu.map((n) => ({ art: "neu", firma: n.firma, person: n.person || "", gewerk: n.gewerk, tel: n.tel || [], email: n.email || [] })),
  ];
  // In Portionen planen lassen (gleiche Gewerke zusammen, damit eine neue Überschrift nur einmal entsteht)
  auftraege.sort((a, b) => String(a.gewerk).localeCompare(String(b.gewerk), "de"));
  const absatzListe = nummeriert.map(([i, t]) => `${i}: ${t}`).join("\n");
  const PORTION = 15, teile = Math.ceil(auftraege.length / PORTION);
  const plan = [];
  for (let t = 0; t < teile; t++) {
    const teil = auftraege.slice(t * PORTION, (t + 1) * PORTION);
    V.kaStatus = `Claude sucht die richtigen Stellen in der Word-Datei … Teil ${t + 1} von ${teile}`; sheetKontaktAbgleich();
    const prompt = `Hier sind die nummerierten Absätze einer Word-Firmenliste (Nr: Text). Zwischenüberschriften geben das Gewerk an, darunter folgen die Firmen mit Adresse, E-Mail, Tel usw.

${absatzListe}

Folgende Änderungen sollen eingefügt werden:
${teil.map((a, i) => `[${i}] ${a.art === "neu" ? `NEUE FIRMA unter Gewerk "${a.gewerk}": ${a.firma}${a.person ? " (Ansprechpartner " + a.person + ")" : ""}` : `ERGÄNZUNG bei "${a.firma}" (${a.gewerk})`} – Telefon: ${a.tel.join(", ") || "-"} – E-Mail: ${a.email.join(", ") || "-"}`).join("\n")}

Gib für jede Änderung an, nach welchem Absatz eingefügt wird und welche neuen Zeilen es sind:
- ERGÄNZUNG: nach dem letzten Absatz dieses Firmeneintrags; Zeilen im Stil der Liste, z. B. "Tel: 0471 123456" bzw. die E-Mail-Adresse allein (wie bei den anderen Einträgen).
- NEUE FIRMA: am Ende des passenden Gewerk-Abschnitts; gibt es das Gewerk nicht, am Ende der Liste mit einer neuen Überschrift (Stil wie die anderen Überschriften; bei mehreren neuen Firmen desselben neuen Gewerks die Überschrift nur einmal). Zeilen: ggf. Überschrift, Firmenname, dann E-Mail und "Tel: …" (mit Ansprechpartner in Klammern hinter der Nummer, wie in der Liste üblich).
- vorlage: Nummer eines bestehenden Absatzes mit gleichem Zweck, dessen Formatierung übernommen werden soll (für jede Zeile einzeln).

Antworte NUR mit JSON-Zeilen, genau ein Objekt pro Änderung und Zeile, ohne Code-Block und ohne weiteren Text:
{"i":0,"nach":123,"zeilen":[{"text":"Tel: …","vorlage":120}]}`;
    let antwort, versuch = 0;
    for (;;) {
      try {
        antwort = jsonZeilen(await claude(prompt, 8000, null, {
          onWarten: (rest, st) => { V.kaStatus = `Teil ${t + 1} von ${teile}: ${st === 429 ? "Claude-Limit pro Minute erreicht" : "Claude ist ausgelastet"} – warte ${rest} s …`; sheetKontaktAbgleich(); },
        }));
        break;
      } catch (e) {
        if (++versuch >= 3) throw new Error(`Teil ${t + 1} von ${teile}: ${e.message || e} – die Word-Datei wurde NICHT verändert`);
        V.kaStatus = `Teil ${t + 1} von ${teile}: ${e.message || "Fehler"} – neuer Versuch in 10 s …`; sheetKontaktAbgleich(); await new Promise((ok) => setTimeout(ok, 10000));
      }
    }
    plan.push(...antwort.filter((x) => Number.isInteger(+x.nach) && Array.isArray(x.zeilen)));
  }
  if (!plan.length) throw new Error("Einfügestellen nicht erkannt – die Word-Datei wurde NICHT verändert");
  // Sicherung anlegen
  V.kaStatus = "Sicherungskopie und Speichern …"; sheetKontaktAbgleich();
  const stempel = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  await Dropbox.rpc("files/copy_v2", { from_path: datei.path_lower, to_path: appPath("/Sicherungen/" + datei.name.replace(/\.docx$/i, "") + " Sicherung " + stempel + ".docx"), autorename: true });
  // Einfügen (von hinten nach vorne, damit Nummern stimmen)
  const neuerAbsatz = (vorlage, text) => {
    const p = vorlage.cloneNode(true);
    const runs = [...p.getElementsByTagNameNS(WNS, "r")];
    const ersterRun = runs.find((r) => r.getElementsByTagNameNS(WNS, "t").length) || runs[0];
    for (const c of [...p.childNodes]) if (c.localName !== "pPr") p.removeChild(c);
    const r = ersterRun ? ersterRun.cloneNode(true) : doc.createElementNS(WNS, "w:r");
    for (const c of [...r.childNodes]) if (c.localName !== "rPr") r.removeChild(c);
    const t = doc.createElementNS(WNS, "w:t"); t.setAttribute("xml:space", "preserve"); t.textContent = text;
    r.appendChild(t); p.appendChild(r);
    return p;
  };
  for (const s of plan.slice().sort((a, b) => b.nach - a.nach)) {
    const ref = absaetze[s.nach] || absaetze[absaetze.length - 1];
    let nachKnoten = ref;
    for (const z of s.zeilen || []) {
      const vorlage = absaetze[z.vorlage] || ref;
      const p = neuerAbsatz(vorlage, String(z.text || ""));
      nachKnoten.parentNode.insertBefore(p, nachKnoten.nextSibling);
      nachKnoten = p;
    }
  }
  zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
  const neuBlob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  let res;
  try { res = await Dropbox.uploadUpdate(datei.path_lower, neuBlob, datei.rev); }
  catch (e) { if (e.status === 409) throw new Error("Die Word-Datei wurde gerade woanders geändert – bitte nochmal versuchen"); throw e; }
  // Adressbuch der App direkt mitziehen
  if (mitziehen) for (const e of ers) { const k = kontakt(e.id); if (!k) continue; upsert(S.kontakte, { ...k, tel: [...(k.tel || []), ...(e.tel || []).map((nr) => ({ nr, name: "" }))], email: [...(k.email || []), ...(e.email || [])] }); }
  if (mitziehen) for (const n of neu) upsert(S.kontakte, { id: newId("k"), quelle: "word", gewerk: n.gewerk, gruppe: n.gruppe === "Techniker" ? "Techniker" : "Firma", firma: n.firma, person: n.person || "", adresse: "", tel: (n.tel || []).map((nr) => ({ nr, name: "" })), email: n.email || [], pec: [], notiz: "" });
  upsert(S.einst, { ...einst(), id: "allgemein", wordRev: res.rev, wordName: res.name, wordStand: res.server_modified });
  V.kaVorschlaege = null; V.kaStatus = ""; closeSheet(); changed();
  toast(`In die Word-Liste geschrieben: ${ers.length} Ergänzungen, ${neu.length} neue Firmen`);
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
  return doc.output("datauristring").split(",")[1];
}
async function wordBeteiligte(b) {
  const D = window.docx;
  const ks = beteiligte(b);
  const zelle = (txt, opt = {}) => new D.TableCell({
    children: String(txt || "").split("\n").map((z) => new D.Paragraph({ children: [new D.TextRun({ text: z, size: 17, bold: !!opt.bold, color: opt.color })] })),
    shading: opt.fill ? { fill: opt.fill, type: D.ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
  const kopf = ["Gewerk", "Firma / Ansprechpartner", "Adresse", "Telefon", "E-Mail"].map((h) => zelle(h, { bold: true, fill: "1D2428", color: "FFFFFF" }));
  const zeilen = ks.map((k, i) => new D.TableRow({ children: [
    zelle(k.gewerk, { bold: true }), zelle(k.firma + (k.person ? "\n" + k.person : "")), zelle(k.adresse),
    zelle((k.tel || []).map((t) => t.nr + (t.name ? " (" + t.name + ")" : "")).join("\n")),
    zelle([...(k.email || []), ...(k.pec || []).map((x) => x + " (PEC)")].join("\n")),
  ].map((c) => (i % 2 ? c : c)) }));
  const doc = new D.Document({
    styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 900, right: 900 } } },
      children: [
        ...(einst().buero ? [new D.Paragraph({ children: [new D.TextRun({ text: einst().buero, size: 18, color: "6E6E6E" })] })] : []),
        new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun({ text: "Beteiligtenliste", bold: true, size: 36, color: "1D2428" })] }),
        new D.Paragraph({ children: [new D.TextRun({ text: [b.name, b.ort, b.bauherr ? "Bauherr: " + b.bauherr : ""].filter(Boolean).join("  ·  "), size: 22 })] }),
        new D.Paragraph({ spacing: { after: 200 }, children: [new D.TextRun({ text: "Stand: " + fmtDate(today()), size: 18, color: "6E6E6E" })] }),
        new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, columnWidths: [1700, 2400, 2100, 1700, 2400], rows: [new D.TableRow({ tableHeader: true, children: kopf }), ...zeilen] }),
      ],
    }],
  });
  return await D.Packer.toBase64String(doc);
}
// Beteiligtenliste als PDF und Word direkt in den Baustellen-Ordner (immer aktuelle Version, gleicher Name)
async function beteiligteSpeichern(b) {
  const basis = `Beteiligtenliste_${slug(b.name)}`;
  const dateien = [[basis + ".pdf", await pdfBeteiligte(b)], [basis + ".docx", await wordBeteiligte(b)]];
  for (const [name, data] of dateien) {
    const rel = "pdf/" + name;
    await Filesystem.writeFile({ path: rel, directory: DATA, data });
    S.lokal[name] = rel;
    S.queue = S.queue.filter((q) => !(q.name === name && q.bid === b.id));
    S.queue.push({ art: "ordner", bid: b.id, name, lokal: rel });
  }
  persist(); scheduleSync(300);
  return "pdf/" + basis + ".pdf";
}

// ---------- Punkte verschieben (Kästchen rechts festhalten und ziehen) ----------
let zug = null;
document.addEventListener("pointerdown", (ev) => {
  const g = ev.target.closest("[data-griff]"); if (!g) return;
  const card = g.closest(".card"); const liste = card?.parentElement; if (!liste) return;
  ev.preventDefault(); ev.stopPropagation();
  try { g.setPointerCapture(ev.pointerId); } catch {}
  zug = { card, liste, g, y: ev.clientY, dy: 0, bewegt: false };
  card.classList.add("zieht"); try { navigator.vibrate?.(15); } catch {}
}, true);
document.addEventListener("pointermove", (ev) => {
  if (!zug) return; ev.preventDefault();
  const { card, liste } = zug;
  zug.dy = ev.clientY - zug.y; zug.bewegt = zug.bewegt || Math.abs(zug.dy) > 4;
  card.style.transform = `translateY(${zug.dy}px)`;
  // Am Rand mitscrollen
  const vh = window.innerHeight; if (ev.clientY < 90) window.scrollBy(0, -12); else if (ev.clientY > vh - 110) window.scrollBy(0, 12);
  // Nachbarn überholt? Dann im DOM tauschen
  const geschw = [...liste.children].filter((c) => c !== card && c.classList.contains("card"));
  const mitte = card.getBoundingClientRect().top + card.offsetHeight / 2;
  const vorher = card.previousElementSibling, nachher = card.nextElementSibling;
  if (nachher?.classList.contains("card")) { const r = nachher.getBoundingClientRect(); if (mitte > r.top + r.height / 2) { const alt = card.getBoundingClientRect().top; liste.insertBefore(nachher, card); zug.y += card.getBoundingClientRect().top - alt; zug.dy = ev.clientY - zug.y; card.style.transform = `translateY(${zug.dy}px)`; } }
  if (vorher?.classList.contains("card")) { const r = vorher.getBoundingClientRect(); if (mitte < r.top + r.height / 2) { const alt = card.getBoundingClientRect().top; liste.insertBefore(card, vorher); zug.y += card.getBoundingClientRect().top - alt; zug.dy = ev.clientY - zug.y; card.style.transform = `translateY(${zug.dy}px)`; } }
  void geschw;
}, { capture: true, passive: false });
const zugEnde = () => {
  if (!zug) return;
  const { card, liste, bewegt } = zug; zug = null;
  card.classList.remove("zieht"); card.style.transform = "";
  if (!bewegt) return;
  const bid = card.dataset.b, id = card.dataset.id;
  const e = (S.eintraege[bid] || []).find((x) => x.id === id); if (!e) return;
  // Anzeige-Reihenfolge aller Punkte (ohne den verschobenen)
  const absteigend = !S.umgekehrt;
  const D = eintraegeVon(bid).filter((x) => x.id !== id); if (!absteigend) D.reverse();
  const vor = card.previousElementSibling?.dataset?.id, nach = card.nextElementSibling?.dataset?.id;
  let i = vor ? D.findIndex((x) => x.id === vor) + 1 : nach ? D.findIndex((x) => x.id === nach) : -1;
  if (i < 0) { render(); return; }
  const kp = D[i - 1] ? reihe(D[i - 1]) : null, kn = D[i] ? reihe(D[i]) : null;
  const schritt = absteigend ? -60000 : 60000;
  e.pos = kp != null && kn != null ? (kp + kn) / 2 : kp != null ? kp + schritt : kn != null ? kn - schritt : reihe(e);
  upsert(S.eintraege[bid], e); changed();
};
document.addEventListener("pointerup", zugEnde, true);
document.addEventListener("pointercancel", zugEnde, true);
// Tippen auf das Kästchen öffnet den Punkt nicht
document.addEventListener("click", (ev) => { if (ev.target.closest("[data-griff]")) { ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);

// ---------- Lange drücken: Löschen ----------
let lp = null;
document.addEventListener("pointerdown", (ev) => {
  if (ev.target.closest("[data-griff]")) return;
  const el = ev.target.closest("[data-lp]"); if (!el || ev.target.closest("[data-act]:not([data-lp])")) return;
  lp = { el, x: ev.clientX, y: ev.clientY, t: setTimeout(() => { lp.fired = true; try { navigator.vibrate?.(30); } catch {} loeschenFragen(el.dataset.lp, el.dataset.b, el.dataset.id); }, 550) };
});
const lpAbbruch = (ev) => { if (!lp) return; if (ev.type === "pointermove" && Math.hypot(ev.clientX - lp.x, ev.clientY - lp.y) < 12) return; clearTimeout(lp.t); if (!lp.fired) lp = null; };
for (const t of ["pointerup", "pointercancel", "pointermove"]) document.addEventListener(t, lpAbbruch, { passive: true });
document.addEventListener("click", (ev) => { if (lp?.fired) { ev.stopImmediatePropagation(); ev.preventDefault(); lp = null; } }, true);
document.addEventListener("contextmenu", (ev) => { if (ev.target.closest("[data-lp]")) ev.preventDefault(); });

function loeschenFragen(art, bid, id) {
  let titel, info;
  if (art === "eintrag") {
    const e = (S.eintraege[bid] || []).find((x) => x.id === id); if (!e) return;
    titel = `Punkt löschen?`; info = `<b>${esc(e.nr ? e.nr + " " : "")}${esc(e.titel || "")}</b><div class="hint">Die Fotos bleiben in Dropbox erhalten.${e.protokollNr ? " In bereits erstellten Protokoll-PDFs bleibt der Punkt stehen." : ""}</div>`;
  } else {
    const p = (S.protokolle[bid] || []).find((x) => x.id === id); if (!p) return;
    const letztes = protokolleVon(bid)[0]?.id === id;
    titel = `Protokoll Nr. ${p.nr} löschen?`;
    info = `<div>Vom ${fmtDate(p.datum)}. PDF und Word-Datei werden auch aus Dropbox gelöscht.</div>${letztes ? `<div class="hint">Die Punkte daraus gelten danach wieder als „neu“ und kommen ins nächste Protokoll.</div>` : `<div class="hint">Es ist nicht das neueste Protokoll – die Nummerierung der späteren bleibt, wie sie ist.</div>`}`;
  }
  openSheet(`<div class="bar"><h2>${titel}</h2><button class="iconbtn" data-act="close-sheet">×</button></div>${info}
    <button class="btn big danger" data-act="loeschen-ok" data-art="${art}" data-b="${esc(bid)}" data-id="${esc(id)}">Löschen</button>
    <button class="btn big" data-act="close-sheet">Abbrechen</button>`);
}
async function loeschen(art, bid, id) {
  if (art === "eintrag") {
    const e = (S.eintraege[bid] || []).find((x) => x.id === id);
    upsert(S.eintraege[bid], { ...e, geloescht: true });
    toast("Punkt gelöscht");
  } else {
    const p = (S.protokolle[bid] || []).find((x) => x.id === id);
    const letztes = protokolleVon(bid)[0]?.id === id;
    upsert(S.protokolle[bid], { ...p, geloescht: true });
    if (letztes) for (const e of S.eintraege[bid] || []) if (e.protokollNr === p.nr) { delete e.protokollNr; delete e.nr; upsert(S.eintraege[bid], e); }
    S.queue = S.queue.filter((q) => q.name !== p.datei && q.name !== p.wordDatei);
    if (p.wordDatei) {
      if (S.lokal[p.wordDatei]) { try { await Filesystem.deleteFile({ path: S.lokal[p.wordDatei], directory: DATA }); } catch {} delete S.lokal[p.wordDatei]; }
      try { await Dropbox.rpc("files/delete_v2", { path: bPath(baustelle(bid), "/Protokolle/" + p.wordDatei) }); } catch {}
    }
    if (p.datei) {
      if (S.lokal[p.datei]) { try { await Filesystem.deleteFile({ path: S.lokal[p.datei], directory: DATA }); } catch {} delete S.lokal[p.datei]; }
      const b = baustelle(bid);
      try { await Dropbox.rpc("files/delete_v2", { path: bPath(b, "/Protokolle/" + p.datei) }); } catch (e) { if (!e.notFound) toast("PDF in Dropbox konnte nicht gelöscht werden – bitte dort von Hand löschen"); }
    }
    toast("Protokoll gelöscht");
  }
  changed();
}

// ---------- Ereignisse ----------
document.addEventListener("click", async (ev) => {
  if (V.eintragOffen && ev.target.closest("#sheet")) return;
  const t = ev.target.closest("[data-act]"); if (!t) return;
  if (t.tagName === "A" && t.getAttribute("href") === "#") ev.preventDefault();
  const act = t.dataset.act, id = t.dataset.id, r = route();
  switch (act) {
    case "close-sheet": closeSheet(); break;
    case "loeschen-ok": closeSheet(); try { await loeschen(t.dataset.art, t.dataset.b, id); } catch (e) { toast("Löschen: " + (e.message || e)); } break;
    case "login":
      try { const url = await Dropbox.startLogin(); await Browser.open({ url }); } catch (e) { toast(e.message || String(e)); }
      break;
    case "logout": if (!t.dataset.confirm) { t.dataset.confirm = "1"; t.textContent = "Wirklich abmelden?"; break; } Dropbox.logout(); S.appOrdner = null; persist(); render(); break;
    case "pick-appordner": folderPicker("Gemeinsamen App-Ordner wählen", S.appOrdner?.anzeige || "", (ref) => { S.appOrdner = ref; if (ref.privat) toast("Achtung: Ordner ist nicht geteilt"); persist(); render(); sync(); }); break;
    case "sync": S.abgleich = {}; sync(); break;
    case "kontakt-abgleich": if (!(einst().apiKey || "").trim()) { toast("Dafür bitte erst den API-Schlüssel eintragen"); break; } V.kaVorschlaege = null; V.kaStatus = ""; sheetKontaktAbgleich(); break;
    case "word-neu": V.wordErzwingen = true; sync(); toast("Word-Liste wird neu eingelesen …"); break;
    case "baustelle-neu": sheetBaustelle(null); break;
    case "baustelle-edit": sheetBaustelle(id); break;
    case "tab": V.tab = t.dataset.v; render(); break;
    case "filter": V.filter = t.dataset.v; render(); break;
    case "protokoll-word": protokollWordOeffnen(t.dataset.b, t.dataset.id); break;
    case "umkehren": S.umgekehrt = !S.umgekehrt; persist(); render(); break;
    case "eintrag-neu": sheetEintrag(id, null); break;
    case "begehung": sheetBegehung(id); break;
    case "protokoll-neu": sheetProtokoll(id); break;
    case "protokoll-go": try { await protokollErstellen(id); } catch (e) { console.error(e); toast("Protokoll: " + (e.message || e)); } break;
    case "protokoll-ansehen": try { await protokollAnsehen(t.dataset.b, id); } catch (e) { toast("Ansehen: " + (e.message || e)); } break;
    case "protokoll-neu-erstellen": try { await protokollNeuErstellen(t.dataset.b, id); } catch (e) { console.error(e); toast("Neu erstellen: " + (e.message || e)); } break;
    case "protokoll-senden": try { await protokollSenden(t.dataset.b, id); } catch (e) { toast("Senden: " + (e.message || e)); } break;
    case "ki-test": {
      const key = document.getElementById("s-apikey")?.value.trim();
      if (key) upsert(S.einst, { ...einst(), id: "allgemein", apiKey: key });
      t.disabled = true; t.textContent = "Teste …";
      try { await claude("Antworte nur mit: OK", 10); toast("Schlüssel funktioniert ✓"); persist(); scheduleSync(); } catch (e) { toast(e.message || String(e)); }
      t.disabled = false; t.textContent = "Schlüssel testen"; break;
    }
    case "eintrag-edit": sheetEintrag(t.dataset.b, id); break;
    case "beteiligte-waehlen": sheetBeteiligte(r.id); break;
    case "beteiligte-ok": { const b = { ...baustelle(id), beteiligte: [...V.pickSel] }; closeSheet(); upsert(S.baustellen, b); changed(); break; }
    case "beteiligt-weg": { const b = baustelle(t.dataset.b); upsert(S.baustellen, { ...b, beteiligte: (b.beteiligte || []).filter((x) => x !== id) }); changed(); break; }
    case "beteiligte-speichern": try { await beteiligteSpeichern(baustelle(r.id)); toast("Wird in Dropbox gespeichert: Beteiligtenliste als PDF und Word"); } catch (e) { console.error(e); toast("Speichern: " + (e.message || e)); } break;
    case "mail-einzel": openMail({ to: [t.dataset.to] }).catch((e) => toast(e.message || e)); break;
    case "mail-alle": {
      const b = baustelle(r.id); const addrs = beteiligte(b).map(firstMail).filter(Boolean);
      if (!addrs.length) { toast("Keine Adressen vorhanden"); break; }
      try {
        const rel = await beteiligteSpeichern(b); const it = einst().sprache === "Italienisch"; const du = einst().anrede === "Du";
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
    const alt = kontakt(f.dataset.id);
    const old = alt || {};
    const rec = { ...old, id: f.dataset.id, firma: v("k-firma"), person: v("k-person"), gewerk: v("k-gewerk"), gruppe: v("k-gruppe"), adresse: v("k-adresse"), tel, email: split(v("k-email")), pec: split(v("k-pec")), notiz: v("k-notiz") };
    if (einst().wordName || V.wordDatei) rec.quelle = "word";
    upsert(S.kontakte, rec);
    closeSheet(); changed(); toast("Kontakt gespeichert");
    // In die Word-Liste übernehmen: neuer Kontakt bzw. neu hinzugekommene Nummern/Mails
    if ((einst().wordName || V.wordDatei) && (einst().apiKey || "").trim()) {
      const norm = (x) => String(x).replace(/[^\d+]/g, "");
      let ers = [], neu = [];
      if (!alt) neu = [{ gewerk: rec.gewerk, gruppe: rec.gruppe, firma: rec.firma, person: rec.person, tel: tel.map((t) => t.nr + (t.name ? " (" + t.name + ")" : "")), email: [...rec.email, ...rec.pec] }];
      else {
        const neueTel = tel.filter((t) => !(alt.tel || []).some((a) => norm(a.nr) === norm(t.nr))).map((t) => t.nr);
        const neueMail = [...rec.email, ...rec.pec].filter((m) => ![...(alt.email || []), ...(alt.pec || [])].map((x) => x.toLowerCase()).includes(m.toLowerCase()));
        if (neueTel.length || neueMail.length) ers = [{ id: rec.id, tel: neueTel, email: neueMail }];
        const sonst = ["firma", "person", "adresse", "gewerk"].some((k) => (alt[k] || "") !== (rec[k] || ""));
        if (sonst) toast("Hinweis: Namens-/Adressänderungen bitte auch in der Word-Datei machen");
      }
      if (ers.length || neu.length) {
        V.kaVorschlaege = { ergaenzungen: [], neu: [] };
        inWordSchreiben(ers, neu, { mitziehen: false }).catch((e) => { V.kaStatus = ""; closeSheet(); toast("Word-Datei: " + (e.message || e)); });
      }
    }
  }
  if (f.id === "settings-form") {
    S.meinName = v("s-meinname");
    upsert(S.einst, { ...einst(), id: "allgemein", buero: v("s-buero"), gruss: v("s-gruss"), anrede: v("s-anrede"), sprache: v("s-sprache"), diktat: v("s-diktat"), fotos: v("s-fotos"), apiKey: v("s-apikey") });
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
  Diktat.init();
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
