// PC-Brücke: ersetzt Capacitor (Handy) durch Windows-Funktionen. Gleiche Schnittstelle,
// damit www/app.js unverändert läuft.
(() => {
  const D = window.desktop;
  window.IS_DESKTOP = true;
  let datenUri = "";
  const listener = (fn) => ({ remove() {}, then: (r) => r({ remove() {} }) });
  const abgebrochen = () => { const e = new Error("User cancelled photos app"); return e; };

  const plugins = {
    Filesystem: {
      writeFile: (o) => D.invoke("fs:write", o),
      readFile: (o) => D.invoke("fs:read", o),
      mkdir: (o) => D.invoke("fs:mkdir", o),
      deleteFile: (o) => D.invoke("fs:delete", o),
      copy: (o) => D.invoke("fs:copy", o),
      async getUri() { datenUri = (await D.invoke("fs:datenUri")).replace(/\/$/, ""); return { uri: datenUri }; },
    },
    Camera: {
      async getPhoto() { const [p] = await D.invoke("fotos:waehlen", { mehrere: false }).catch(() => { throw abgebrochen(); }); return { path: p }; },
      async pickImages() { const ps = await D.invoke("fotos:waehlen", { mehrere: true }).catch(() => { throw abgebrochen(); }); return { photos: ps.map((p) => ({ path: p })) }; },
    },
    Browser: { open: ({ url }) => D.invoke("browser:open", { url }), close: async () => {} },
    App: {
      addListener(evt, fn) {
        if (evt === "appUrlOpen") D.on("appUrlOpen", fn);
        if (evt === "resume") D.on("resume", fn);
        return listener(fn);
      },
      getInfo: () => D.invoke("app:info"),
      minimizeApp: async () => {},
    },
    Network: {
      getStatus: async () => ({ connected: navigator.onLine }),
      addListener(evt, fn) {
        window.addEventListener("online", () => fn({ connected: true }));
        window.addEventListener("offline", () => fn({ connected: false }));
        return listener(fn);
      },
    },
    Mail: {
      compose: (o) => D.invoke("mail:compose", o),
      open: (o) => D.invoke("datei:oeffnen", o),
    },
    Diktat: {
      start: async () => { throw new Error("Am PC: ins Textfeld klicken und Windows-Taste + H drücken"); },
      stop: async () => {},
      addListener: (evt, fn) => listener(fn),
    },
    Contacts: {
      requestPermissions: async () => { throw new Error("Der Abgleich mit Handykontakten geht nur in der Handy-App"); },
      getContacts: async () => ({ contacts: [] }),
    },
  };

  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "windows",
    convertFileSrc(uri) {
      if (datenUri && uri.startsWith(datenUri)) return "app://daten/" + uri.slice(datenUri.length).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
      return uri;
    },
  };
  const registerPlugin = (name) => plugins[name] || new Proxy({}, { get: () => async () => { throw new Error(name + " gibt es am PC nicht"); } });
  window.capacitorExports = { Capacitor, registerPlugin };
  window.Capacitor = Capacitor;
})();
