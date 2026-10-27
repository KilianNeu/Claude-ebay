# Grafikkarten-Schnäppchen

Eine GitHub-Pages-Seite, die Grafikkarten (neu und gebraucht) auf eBay.de unter Marktpreis anzeigt.
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
- `minSellerFeedback: 10`, `minSellerPositive: 97` – Verkäufer mit weniger Bewertungen oder
  weniger positiven Bewertungen werden ausgeschlossen
- `resale` – Kosten beim Weiterverkauf für die Gewinnrechnung: Versand, Verpackung und Gebührensatz
  (Gebühren nur, wenn auf der Seite „Gewerblich verkaufen“ angehakt ist)
- `minPrice` je Modell – Sofort-Kaufen-Angebote darunter gelten als Zubehör
- `excludeParts` – Wortteile, die auch in Zusammensetzungen greifen (z. B. „Kühlkörper“ in „Lüfter+Kühlkörper“)
- `categoryIds: "27386"` – eBay-Kategorie Grafikkarten; ohne sie liefert die Suche nach „5080“ auch
  Aufkleber und Lego-Teile
- `conditionIds` – neue, gebrauchte und generalüberholte Karten; „Als Ersatzteil / defekt“ (7000) ist
  ausgeschlossen. Neue (1000, 1500) und gebrauchte Karten werden gegen den Median ihrer eigenen Gruppe bewertet

## Lokal testen

```sh
EBAY_CLIENT_ID=… EBAY_CLIENT_SECRET=… node scripts/fetch-deals.mjs
python3 -m http.server   # dann http://localhost:8000
```

## Schnellcheck mit Push-Benachrichtigung

`scripts/quick-check.mjs` (Workflow „Schnellcheck“) sucht alle 5 Minuten neu eingestellte
Sofort-Kaufen-Angebote – alle Modelle gebündelt in drei Oder-Suchen – und prüft sie mit denselben
Filtern wie der stündliche Lauf (`scripts/lib.mjs`). Lohnt sich ein Weiterverkauf (Gewinn gegenüber
dem günstigsten Sofortkauf mindestens `notify.minProfit` = 30 € und mindestens
`notify.minProfitPercent` = 10 % des Kaufpreises), kommt eine Nachricht über
[ntfy](https://ntfy.sh). Jedes Angebot wird nur einmal gemeldet (Branch `notify`).

Einrichten:

1. ntfy-App installieren und ein Thema mit schwer erratbarem Namen abonnieren.
2. Den Namen als Secret `NTFY_TOPIC` im Repo hinterlegen.
3. Bei cron-job.org einen zweiten Job anlegen wie für den stündlichen Lauf, aber mit
   `…/actions/workflows/quick.yml/dispatches` und Zeitplan alle 5 Minuten.

Verbrauch: 3 eBay-Abfragen je Schnellcheck, bei 5 Minuten also etwa 900 am Tag.

## Mini-PCs (eigene Kategorie)

`scripts/minipc.mjs` mit eigener Konfiguration `minipcs.json`, unabhängig von den Grafikkarten
(eigene Ausgabe `data/minipc.json`, Reiter „Mini-PCs“; im Workflow mit `continue-on-error`).

- Baureihen: Intel/ASUS NUC, ThinkCentre Tiny, EliteDesk/ProDesk Mini, OptiPlex Micro, Esprimo Mini
- höchstens 6 Jahre alt: Intel ab `minIntelGen` (11), AMD ab `minRyzenSeries` (5000)
- CPU, RAM, SSD, Barebone und „ohne Netzteil“ werden aus dem Titel gelesen; steht die CPU nicht
  im Titel, lädt das Skript die Artikelmerkmale nach (max. 80 je Lauf, zwischengespeichert in
  `minipc-cache.json` im Branch `data`). Titel wie „i5 11. Gen“ zählen über CPU-Klasse und Generation
- Marktwert = Barebone-Wert der CPU + RAM × €/GB + SSD × €/GB. Die €/GB misst das Skript selbst
  (SO-DIMM DDR4/DDR5, NVMe); der Barebone-Wert ist der Median aus Preis minus Bauteilwert über alle
  Angebote mit dieser CPU (bei weniger als `minCpuSamples` über CPU-Klasse und Generation)
- Schnäppchen: Preis höchstens `dealThreshold` (85 %) des Marktwerts
- Preisstatistik (Reiter „Mini-PC-Statistik“): Jede ausgewertete Auktion wird samt geschätztem Wert
  gemerkt und nach dem Ende per getItem mit dem echten Endpreis erfasst (max. 40 je Lauf); dazu je
  Lauf und CPU der günstigste Sofortkauf und der Barebone-Wert. Gespeichert in `minipc-history.json`
  im Branch `data` (30 Tage), für die Seite als `data/minipc-stats.json`. „Endpreis vs. Schätzung“
  zeigt, wie gut der geschätzte Marktwert die echten Verkäufe trifft
- Modellnamen → CPU: Steht die CPU nicht im Titel, wertet das Skript den Modellnamen aus. Die feste
  Tabelle steht je Baureihe unter `models` in `minipcs.json` (Muster, Generation, bei NUCs die genaue
  CPU je Klasse, z. B. NUC12WSHi7 → i7-1260P). Zu alte Modelle (M920q, 800 G6 …) fliegen so ohne
  Nachschlagen raus; bei bekannter Klasse („M70q Gen 3 i5“) wird über Klasse und Generation bewertet.
  Zusätzlich lernt das Skript aus Angeboten mit Modell und CPU im Titel (gespeichert in
  `minipc-history.json`): Stecken in mindestens 3 Angeboten eines Modells zu ≥ 80 % dieselbe CPU,
  gilt sie als Vermutung („vermutet“ auf der Karte, zählt nicht in den Barebone-Wert); bei freiem
  Abfragebudget wird die Vermutung per Artikelmerkmale geprüft
- RAM-Typ (DDR4/DDR5) im gleichen Stil: Angabe im Titel/in den Merkmalen, sonst Tabelle `ddrByModel`
  in `minipcs.json` (z. B. NUC 12/13 Pro → DDR4, NUC 14 Pro und HP 800 G9 → DDR5), sonst gelernt aus
  Angeboten mit Modell und DDR-Angabe (ab 3 Angeboten, 80 % Anteil), zuletzt nach CPU-Generation (bis
  11. Gen/Ryzen 5000 sicher DDR4). Unsichere Fälle (12./13. Gen ohne Angabe) werden bei freiem Budget
  per Artikelmerkmale geprüft; die Karte zeigt, woher die DDR-Generation stammt

## Arbeitsspeicher (eigene Kategorie)

`scripts/ram.mjs` mit eigener Konfiguration `ram.json`, unabhängig von Grafikkarten und Mini-PCs
(Ausgabe `data/ram.json` und `data/ram-stats.json`, Reiter „RAM“ und „RAM-Statistik“; Verlauf in
`ram-history.json` im Branch `data`; im Workflow mit `continue-on-error`).

- DDR4 und DDR5, SO-DIMM (Laptop) und DIMM (Desktop), ab `minCapacity` (8 GB); Server-RAM
  (ECC/Registered) und Konvolute sind ausgeschlossen
- Markt = DDR-Generation × Bauform × Gesamtkapazität, z. B. „DDR4 SO-DIMM 32 GB“ (Kits wie 2×16 GB
  zählen als 32 GB); der Takt wird erkannt und angezeigt, bildet aber keinen eigenen Markt
- Referenz: Median der beobachteten Auktions-Endpreise ab `minSold` (5) Verkäufen, sonst das günstigste
  Viertel der Sofort-Kaufen-Angebote; Schnäppchen ab 15 % darunter (mind. 3 Vergleichsangebote)
- Gewinn: günstigster anderer Sofortkauf − Versand/Verpackung (`resale`, 5 + 1 €) − Kaufpreis
- Beendete Auktionen werden per getItem mit echtem Endpreis erfasst (max. 40 je Lauf)
- Schnellcheck: neue RAM-Sofortkäufe (eine Oder-Suche „(ddr4,ddr5)“ je Lauf) werden wie Grafikkarten per
  ntfy gemeldet, wenn der Gewinn gegenüber dem günstigsten anderen Sofortkauf des Markts mindestens
  `notify.minProfit` (15 €) und `notify.minProfitPercent` (10 %) erreicht; Verkaufspreise aus
  `ram-markets.json` im Branch `data`

## eBay-API-Verbrauch

`scripts/usage.mjs` fragt stündlich den Tagesverbrauch der Browse API über die Developer Analytics API
ab (alle Läufe zusammen, inkl. Schnellcheck) und zeigt ihn in der Fußzeile der Seite.
