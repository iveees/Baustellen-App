"use strict";
// Dropbox-Anbindung: Anmeldung (PKCE), API-Aufrufe, Pfade in geteilten Ordnern.
// Geteilte Ordner werden über ihre Namespace-ID angesprochen ("ns:123/…"),
// damit es egal ist, wo der Ordner im Dropbox des jeweiligen Nutzers liegt.

const Dropbox = (() => {
  let auth = null;            // { access, refresh, expires, account }
  let onAuthChange = () => {};

  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (x) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"[x % 66]).join(""); };
  // Dropbox-API-Arg muss reines ASCII sein: Umlaute als \uXXXX
  const headerJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4));

  class DbxError extends Error {
    constructor(status, summary) { super(summary || "HTTP " + status); this.status = status; this.summary = summary || ""; }
    get notFound() { return this.status === 409 && /not_found/.test(this.summary); }
  }

  async function startLogin() {
    const key = window.DROPBOX_APP_KEY;
    if (!key) throw new Error("Dropbox-App-Key fehlt noch (config.js)");
    const verifier = randomString(64);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem("pkce", verifier);
    try { localStorage.setItem("pkce", verifier); } catch {}
    const u = new URL("https://www.dropbox.com/oauth2/authorize");
    u.searchParams.set("client_id", key);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("redirect_uri", window.DROPBOX_REDIRECT);
    u.searchParams.set("token_access_type", "offline");
    return u.toString();
  }

  async function finishLogin(url) {
    const code = new URL(url.replace("baustellendoku://", "https://x/")).searchParams.get("code");
    if (!code) throw new Error("Anmeldung abgebrochen");
    const verifier = sessionStorage.getItem("pkce") || localStorage.getItem("pkce");
    const body = new URLSearchParams({ code, grant_type: "authorization_code", client_id: window.DROPBOX_APP_KEY, code_verifier: verifier, redirect_uri: window.DROPBOX_REDIRECT });
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body });
    if (!r.ok) throw new Error("Anmeldung fehlgeschlagen (" + r.status + ")");
    const t = await r.json();
    auth = { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000, account: t.account_id };
    try { const acc = await rpc("users/get_current_account", null); auth.name = acc.name?.display_name || ""; auth.email = acc.email || ""; } catch {}
    onAuthChange(auth);
    return auth;
  }

  async function refresh() {
    if (!auth?.refresh) throw new DbxError(401, "nicht angemeldet");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refresh, client_id: window.DROPBOX_APP_KEY });
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body });
    if (!r.ok) { if (r.status === 400 || r.status === 401) { auth = null; onAuthChange(null); } throw new DbxError(r.status, "Token erneuern fehlgeschlagen"); }
    const t = await r.json();
    auth.access = t.access_token; auth.expires = Date.now() + t.expires_in * 1000;
    onAuthChange(auth);
  }
  async function token() {
    if (!auth) throw new DbxError(401, "nicht angemeldet");
    if (Date.now() > auth.expires - 60000) await refresh();
    return auth.access;
  }
  async function call(url, init, retry = true) {
    init.headers = { ...(init.headers || {}), Authorization: "Bearer " + await token() };
    const r = await fetch(url, init);
    if (r.status === 401 && retry) { await refresh(); return call(url, init, false); }
    if (r.status === 429 && retry) { await new Promise((ok) => setTimeout(ok, 2000)); return call(url, init, false); }
    if (!r.ok) { let s = ""; try { const j = await r.clone().json(); s = j.error_summary || ""; } catch { try { s = await r.text(); } catch {} } throw new DbxError(r.status, s); }
    return r;
  }
  async function rpc(endpoint, args) {
    const r = await call("https://api.dropboxapi.com/2/" + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: args === null ? "null" : JSON.stringify(args) });
    return r.json();
  }
  async function download(path) {
    try {
      const r = await call("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { "Dropbox-API-Arg": headerJson({ path }) } });
      return await r.blob();
    } catch (e) { if (e.notFound) return null; throw e; }
  }
  async function thumbnail(path) {
    try {
      const r = await call("https://content.dropboxapi.com/2/files/get_thumbnail_v2", { method: "POST", headers: { "Dropbox-API-Arg": headerJson({ resource: { ".tag": "path", path }, format: "jpeg", size: "w480h320", mode: "fitone_bestfit" }) } });
      return await r.blob();
    } catch (e) { if (e.notFound) return null; throw e; }
  }
  async function upload(path, data) {
    const r = await call("https://content.dropboxapi.com/2/files/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerJson({ path, mode: "overwrite", mute: true }) }, body: data });
    return r.json();
  }
  // Nur überschreiben, wenn die Datei seit dem Lesen unverändert ist
  async function uploadUpdate(path, data, rev) {
    const r = await call("https://content.dropboxapi.com/2/files/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerJson({ path, mode: { ".tag": "update", update: rev }, autorename: false, mute: true }) }, body: data });
    return r.json();
  }
  async function listFolders(path) {
    let res = await rpc("files/list_folder", { path, include_mounted_folders: true, limit: 2000 });
    const out = [...res.entries];
    while (res.has_more) { res = await rpc("files/list_folder/continue", { cursor: res.cursor }); out.push(...res.entries); }
    return out.filter((e) => e[".tag"] === "folder").sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  async function createFolder(path) {
    try { await rpc("files/create_folder_v2", { path, autorename: false }); } catch (e) { if (!(e.status === 409 && /conflict/.test(e.summary))) throw e; }
  }
  // Ordner -> stabiler Verweis, der auf beiden Konten funktioniert
  async function folderRef(pathLower) {
    const m = await rpc("files/get_metadata", { path: pathLower });
    const si = m.sharing_info || {};
    const anzeige = m.path_display;
    if (si.shared_folder_id && !si.parent_shared_folder_id) return { ns: si.shared_folder_id, rel: "", anzeige };
    const ns = si.parent_shared_folder_id || si.shared_folder_id;
    if (ns) {
      const sf = await rpc("sharing/get_folder_metadata", { shared_folder_id: ns });
      const mount = sf.path_lower || "";
      if (mount && m.path_lower.startsWith(mount)) return { ns, rel: m.path_display.slice(mount.length), anzeige };
    }
    return { path: m.path_lower, anzeige, privat: true };
  }
  const refPath = (ref, sub = "") => (ref.ns ? "ns:" + ref.ns + ref.rel : ref.path) + sub;

  return {
    get auth() { return auth; }, set auth(a) { auth = a; },
    onAuth(fn) { onAuthChange = fn; },
    startLogin, finishLogin, rpc, download, thumbnail, upload, uploadUpdate, listFolders, createFolder, folderRef, refPath,
    logout() { auth = null; onAuthChange(null); },
  };
})();
