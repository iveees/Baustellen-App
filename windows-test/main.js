// Test: Kann eine Windows-App eine fertige Mail mit Empfänger, Betreff, Text
// und mehreren Anhängen (Foto + PDF) an eM Client übergeben?
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const EM_PFADE = [
  "C:\\Program Files (x86)\\eM Client\\MailClient.exe",
  "C:\\Program Files\\eM Client\\MailClient.exe",
  path.join(os.homedir(), "AppData\\Local\\Programs\\eM Client\\MailClient.exe"),
];
const emClient = () => EM_PFADE.find((p) => fs.existsSync(p));

// Testdateien: kleines JPG (orange Fläche) und ein einfaches PDF
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAQABABAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAAAE//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oACAEBAAAAEH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==", "base64");
function pdf(text) {
  const inhalt = `BT /F1 20 Tf 60 760 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${inhalt.length} >>\nstream\n${inhalt}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
function testDateien() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailtest-"));
  const foto = path.join(dir, "Testfoto_Baustelle.jpg"); fs.writeFileSync(foto, JPG);
  const prot = path.join(dir, "Protokoll_Test.pdf"); fs.writeFileSync(prot, pdf("Baustellenprotokoll Test"));
  return { dir, foto, prot };
}
const BETREFF = "Test Baustellen-App Windows – Protokoll Nr. 1";
const TEXT = "Sehr geehrte Damen und Herren,\n\nanbei das Baustellenprotokoll (Test).\nÄ Ö Ü ß – Umlaute-Test.\n\nMit freundlichen Grüßen";
const mailto = (an) => `mailto:${encodeURIComponent(an)}?subject=${encodeURIComponent(BETREFF)}&body=${encodeURIComponent(TEXT)}`;

function starte(exe, args) {
  return new Promise((ok, no) => {
    const p = spawn(exe, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: false });
    p.on("error", no); p.unref(); setTimeout(() => ok("gestartet: " + path.basename(exe) + " " + args.map((a) => (a.length > 60 ? a.slice(0, 60) + "…" : a)).join(" ")), 500);
  });
}

ipcMain.handle("test", async (_e, { variante, an }) => {
  const em = emClient();
  const { dir, foto, prot } = testDateien();
  switch (variante) {
    case "cli-mehrere":
      if (!em) throw new Error("eM Client nicht gefunden");
      return starte(em, [foto, prot, "/mailurl", mailto(an)]);
    case "cli-eine":
      if (!em) throw new Error("eM Client nicht gefunden");
      return starte(em, [prot, "/mailurl", mailto(an)]);
    case "mapi": {
      const job = path.join(dir, "job.json");
      fs.writeFileSync(job, JSON.stringify({ to: [an], subject: BETREFF, body: TEXT, files: [foto, prot] }), "utf8");
      const ps1 = path.join(process.resourcesPath && fs.existsSync(path.join(__dirname, "mapi.ps1")) ? __dirname : __dirname, "mapi.ps1");
      const kopie = path.join(dir, "mapi.ps1"); fs.copyFileSync(ps1, kopie);
      return new Promise((ok, no) => execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", kopie, job], { windowsHide: true, timeout: 600000 },
        (err, stdout, stderr) => (err && !stdout ? no(new Error((stderr || err.message).slice(0, 400))) : ok("MAPI-Ergebnis: " + (stdout || "").trim() + (stderr ? " / " + stderr.trim().slice(0, 300) : "")))));
    }
    case "eml": {
      const grenze = "----=_Teil_" + Date.now();
      const b64 = (buf) => buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
      const enc = (s) => "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
      const eml = [
        `To: ${an}`, `Subject: ${enc(BETREFF)}`, "X-Unsent: 1", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${grenze}"`, "",
        `--${grenze}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(Buffer.from(TEXT, "utf8")), "",
        `--${grenze}`, 'Content-Type: image/jpeg; name="Testfoto_Baustelle.jpg"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="Testfoto_Baustelle.jpg"', "", b64(fs.readFileSync(foto)), "",
        `--${grenze}`, 'Content-Type: application/pdf; name="Protokoll_Test.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="Protokoll_Test.pdf"', "", b64(fs.readFileSync(prot)), "",
        `--${grenze}--`, "",
      ].join("\r\n");
      const datei = path.join(dir, "Entwurf.eml"); fs.writeFileSync(datei, eml);
      if (em) return starte(em, ["/open", datei]);
      const fehler = await shell.openPath(datei); if (fehler) throw new Error(fehler); return "geöffnet: " + datei;
    }
    case "ordner": shell.openPath(dir); return "Ordner geöffnet";
  }
  throw new Error("unbekannte Variante");
});
ipcMain.handle("info", () => ({ em: emClient() || "nicht gefunden" }));

app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 720, height: 760, title: "Mail-Test Windows", webPreferences: { nodeIntegration: true, contextIsolation: false } });
  w.setMenuBarVisibility(false);
  w.loadFile("index.html");
});
app.on("window-all-closed", () => app.quit());
