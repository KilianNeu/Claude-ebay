# eBay Schnäppchen

Eine GitHub-Pages-Seite, die günstige eBay.de-Angebote mit Wiederverkaufspotenzial anzeigt.
Eine GitHub Action fragt alle 3 Stunden die eBay Browse API ab, vergleicht jedes Angebot
(inkl. Versand) mit dem Median der üblichen Sofort-Kaufen-Preise derselben Suche und zeigt
alles an, was mindestens 35 % darunter liegt.

## Einrichten

1. **eBay-API-Keys holen:** Auf <https://developer.ebay.com> kostenlos registrieren und ein
   *Production*-Keyset anlegen (App ID = Client ID, Cert ID = Client Secret).
2. **Secrets hinterlegen:** Im Repo unter *Settings → Secrets and variables → Actions*
   `EBAY_CLIENT_ID` und `EBAY_CLIENT_SECRET` anlegen.
3. **Pages aktivieren:** *Settings → Pages → Source: GitHub Actions*.
4. Unter *Actions → Angebote aktualisieren → Run workflow* einmal starten.

Ohne Keys baut die Seite trotzdem: Dann fehlen die Angebotskarten, aber der Link-Generator
und die vorbereiteten eBay-Suchen (günstigste zuerst, Auktionen enden bald, verkaufte Preise)
funktionieren.

## Suchen anpassen

`searches.json` bearbeiten: je Suche `label`, `query`, `maxPrice` (in €) und eine kurze `note`.
`dealThreshold: 0.65` heißt: höchstens 65 % des üblichen Preises.

## Lokal testen

```sh
EBAY_CLIENT_ID=… EBAY_CLIENT_SECRET=… node scripts/fetch-deals.mjs
python3 -m http.server   # dann http://localhost:8000
```
