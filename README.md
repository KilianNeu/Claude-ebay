# Grafikkarten-Schnäppchen

Eine GitHub-Pages-Seite, die gebrauchte Grafikkarten auf eBay.de unter Marktpreis anzeigt.
Eine GitHub Action fragt stündlich die eBay Browse API ab, vergleicht jedes Angebot
(inkl. Versand) mit dem Marktpreis des Modells und zeigt
alles an, was mindestens 15 % darunter liegt. Defekte Karten, Zubehör und
Komplett-PCs werden über Ausschlusswörter herausgefiltert.

## Verkaufspreise

Die öffentliche eBay-API liefert keine verkauften Preise. Deshalb baut die Action eine eigene
Historie auf (Branch `data`, Datei `history.json`):

- **Auktionen** werden bis kurz vor Ende beobachtet; das letzte Gebot gilt als Verkaufspreis
  (Untergrenze, weil in den letzten Minuten oft noch geboten wird).
- **Sofort-Kaufen-Angebote**, die verschwinden, werden per `getItem` geprüft. Ist das Angebot
  beendet, zählt der letzte Preis als „vermutlich verkauft“ (Preisvorschläge sind nicht sichtbar).

Ab 5 Verkäufen in 30 Tagen ersetzt der Median dieser Verkäufe den Angebotspreis als Referenz.

Zusätzlich speichert jeder Lauf je Modell Angebots-Median, Anzahl und günstigstes Angebot.
Daraus erzeugt das Skript `data/stats.json` für die **Preisstatistik** auf der Seite:
Kennzahlen (Median und Spanne der Verkäufe), Preisverlauf mit einzelnen Verkäufen und eine
Liste der letzten Verkäufe mit Link.

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

`searches.json` bearbeiten: je Modell `label`, `query`, optional `exclude` (zusätzliche
Ausschlusswörter) und eine kurze `note`. Globale Einstellungen:

- `dealThreshold: 0.85` – höchstens 85 % des üblichen Preises
- `floorRatio: 0.4` – alles unter 40 % gilt als Zubehör/Fake und wird ignoriert
- `exclude` – Wörter, die nie im Titel vorkommen dürfen (ganze Wörter)
- `categoryIds: "27386"` – eBay-Kategorie Grafikkarten
- `condition: "USED"` – nur gebrauchte Karten (Referenz und Treffer)

## Lokal testen

```sh
EBAY_CLIENT_ID=… EBAY_CLIENT_SECRET=… node scripts/fetch-deals.mjs
python3 -m http.server   # dann http://localhost:8000
```
