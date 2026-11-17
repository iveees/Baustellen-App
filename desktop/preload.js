// Brücke zwischen Oberfläche und Windows-Funktionen
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  invoke: (kanal, daten) => ipcRenderer.invoke(kanal, daten),
  on: (kanal, fn) => ipcRenderer.on(kanal, (_e, d) => fn(d)),
});
