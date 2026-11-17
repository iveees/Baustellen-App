// Baustellen-Doku für Windows: dieselbe Oberfläche wie die Handy-App (www/),
// die Handy-Funktionen werden hier durch Windows-Varianten ersetzt (siehe shim.js).
const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, nativeImage } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs"), fsp = require("fs/promises"), os = require("os"), path = require("path"), url = require("url");

app.commandLine.appendSwitch("lang", "de-DE");   // Datumsfelder auf Deutsch
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const DATEN = path.join(app.getPath("userData"), "daten");
fs.mkdirSync(DATEN, { recursive: true });
const WWW = path.join(__dirname, "www");
const sicher = (basis, rel) => { const p = path.resolve(basis, rel); if (!p.startsWith(path.resolve(basis))) throw new Error("Pfad nicht erlaubt"); return p; };
const ausUri = (p) => { if (!p) return p; if (p.startsWith("file:")) return url.fileURLToPath(p); p = p.replace(/^\/([A-Za-z]:)/, "$1"); try { if (/%[0-9A-Fa-f]{2}/.test(p)) p = decodeURIComponent(p); } catch {} return p; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf", ".svg": "image/svg+xml" };

let fenster = null;

// ---------- Einzelinstanz + Rückkehr vom Dropbox-Login ----------
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", (_e, argv) => {
  const link = argv.find((a) => a.startsWith("baustellendoku://"));
  if (fenster) { if (fenster.isMinimized()) fenster.restore(); fenster.focus(); if (link) fenster.webContents.send("appUrlOpen", { url: link }); }
});
if (process.defaultApp) app.setAsDefaultProtocolClient("baustellendoku", process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient("baustellendoku");

// ---------- Dateien ----------
ipcMain.handle("fs:write", async (_e, { path: rel, data, encoding }) => {
  const ziel = sicher(DATEN, rel); await fsp.mkdir(path.dirname(ziel), { recursive: true });
  await fsp.writeFile(ziel, encoding === "utf8" ? data : Buffer.from(data, "base64")); return { uri: url.pathToFileURL(ziel).href };
});
ipcMain.handle("fs:read", async (_e, { path: rel, encoding }) => {
  const buf = await fsp.readFile(sicher(DATEN, rel)); return { data: encoding === "utf8" ? buf.toString("utf8") : buf.toString("base64") };
});
ipcMain.handle("fs:mkdir", async (_e, { path: rel }) => { await fsp.mkdir(sicher(DATEN, rel), { recursive: true }); });
ipcMain.handle("fs:delete", async (_e, { path: rel }) => { await fsp.rm(sicher(DATEN, rel), { force: true }); });
ipcMain.handle("fs:copy", async (_e, { from, to }) => {
  const ziel = sicher(DATEN, to); await fsp.mkdir(path.dirname(ziel), { recursive: true }); await fsp.copyFile(ausUri(from), ziel);
});
ipcMain.handle("fs:datenUri", () => url.pathToFileURL(DATEN).href);

// ---------- Fotos auswählen (statt Kamera), auf 1800 px verkleinert ----------
ipcMain.handle("fotos:waehlen", async (_e, { mehrere }) => {
  const r = await dialog.showOpenDialog(fenster, { title: "Fotos hinzufügen", properties: ["openFile", ...(mehrere ? ["multiSelections"] : [])], filters: [{ name: "Bilder", extensions: ["jpg", "jpeg", "png", "heic", "webp"] }] });
  if (r.canceled || !r.filePaths.length) throw new Error("User cancelled photos app");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "baustelle-"));
  return r.filePaths.map((p, i) => {
    let img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return p;
    const { width } = img.getSize(); if (width > 1800) img = img.resize({ width: 1800, quality: "best" });
    const ziel = path.join(tmp, `foto_${i}.jpg`); fs.writeFileSync(ziel, img.toJPEG(82)); return ziel;
  });
});

// ---------- Links, Dateien öffnen ----------
ipcMain.handle("browser:open", (_e, { url: u }) => shell.openExternal(u));
ipcMain.handle("datei:oeffnen", async (_e, { path: p }) => { const fehler = await shell.openPath(ausUri(p)); if (fehler) throw new Error(fehler); });
ipcMain.handle("app:info", () => ({ version: app.getVersion() }));

// ---------- Mail: fertiger Entwurf (.eml) in eM Client, sonst Windows-MAPI ----------
const EM = [
  "C:\\Program Files (x86)\\eM Client\\MailClient.exe",
  "C:\\Program Files\\eM Client\\MailClient.exe",
  path.join(os.homedir(), "AppData\\Local\\Programs\\eM Client\\MailClient.exe"),
].find((p) => fs.existsSync(p));
const mimeVon = (n) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[path.extname(n).toLowerCase()] || "application/octet-stream");
const kopf = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=");
const b64 = (buf) => buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
function emlBauen({ to = [], bcc = [], subject = "", body = "", dateien = [] }) {
  const g = "----=_Baustelle_" + Date.now();
  const teile = [
    ...(to.length ? [`To: ${to.join(", ")}`] : []), ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${kopf(subject)}`, "X-Unsent: 1", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${g}"`, "",
    `--${g}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(Buffer.from(body, "utf8")), "",
  ];
  for (const d of dateien) {
    const name = path.basename(d);
    teile.push(`--${g}`, `Content-Type: ${mimeVon(name)}; name="${kopf(name)}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${kopf(name)}"`, "", b64(fs.readFileSync(d)), "");
  }
  teile.push(`--${g}--`, "");
  return teile.join("\r\n");
}
ipcMain.handle("mail:compose", async (_e, { to = [], bcc = [], subject = "", body = "", attachments = [] }) => {
  const dateien = attachments.map(ausUri).filter((p) => fs.existsSync(p));
  if (EM) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "baustelle-mail-"));
    const eml = path.join(dir, "Entwurf.eml");
    await fsp.writeFile(eml, emlBauen({ to, bcc, subject, body, dateien }));
    const p = spawn(EM, ["/open", eml], { detached: true, stdio: "ignore" }); p.unref();
    return { attachments: dateien.length, emClient: true };
  }
  // Ohne eM Client: Standard-Mailprogramm über MAPI
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "baustelle-mapi-"));
  const job = path.join(dir, "job.json");
  await fsp.writeFile(job, JSON.stringify({ to: [...to, ...bcc], subject, body, files: dateien }), "utf8");
  const ps1 = path.join(dir, "mapi.ps1"); await fsp.copyFile(path.join(__dirname, "mapi.ps1"), ps1);
  await new Promise((ok, no) => execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps1, job], { windowsHide: true, timeout: 600000 }, (err, out) => (err ? no(err) : ok(out))));
  return { attachments: dateien.length, emClient: false };
});

// ---------- Fenster ----------
app.whenReady().then(() => {
  protocol.handle("app", async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    let datei;
    if (u.host === "daten") datei = sicher(DATEN, rel);
    else if (rel === "lib/capacitor.js") datei = path.join(__dirname, "shim.js");   // Handy-Brücke durch PC-Brücke ersetzen
    else datei = sicher(WWW, rel || "index.html");
    try {
      const buf = await fsp.readFile(datei);
      return new Response(buf, { headers: { "content-type": MIME[path.extname(datei).toLowerCase()] || "application/octet-stream" } });
    } catch { return new Response("nicht gefunden", { status: 404 }); }
  });
  fenster = new BrowserWindow({
    width: 1100, height: 900, minWidth: 420, title: "Baustellen-Doku", backgroundColor: "#eef0ee",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  fenster.setMenuBarVisibility(false);
  fenster.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: "deny" }; });
  fenster.webContents.on("will-navigate", (e, u) => { if (!u.startsWith("app://")) { e.preventDefault(); if (/^(https?|mailto|tel):/.test(u)) shell.openExternal(u); } });
  fenster.on("focus", () => fenster.webContents.send("resume", {}));
  fenster.loadURL("app://www/index.html");
  const link = process.argv.find((a) => a.startsWith("baustellendoku://"));
  if (link) fenster.webContents.once("did-finish-load", () => fenster.webContents.send("appUrlOpen", { url: link }));
});
app.on("window-all-closed", () => app.quit());
