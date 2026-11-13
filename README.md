# Baustellen-Doku

Android-App für die Baustellendokumentation: Fotos, Sprechen statt Tippen, Mails mit Anhängen über eM Client, Ablage in den Dropbox-Projektordnern.

**Installieren:** Unter „Releases“ → „Baustellen-Doku“ die Datei `Baustellen-Doku.apk` aufs Handy laden und öffnen. Updates einfach drüber installieren, die Daten bleiben erhalten.

## Ablage in Dropbox
- Gemeinsamer App-Ordner (geteilt): `Adressbuch.json`, `Baustellen.json`, `Einstellungen.json`
- Pro Baustelle im Projektordner `…/Baustelle/`: `Baustellen-Doku.json`, `Fotos/`, `Berichte/`

## Aufbau
- `www/` – Oberfläche (HTML/JS), `www/dropbox.js` – Dropbox-Anbindung
- `android/` – Android-Hülle (Capacitor), `MailPlugin.java` öffnet Mails mit Anhängen
- `.github/workflows/build.yml` – baut die APK bei jeder Änderung
