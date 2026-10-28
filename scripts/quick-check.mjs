// Schnellcheck: sucht alle paar Minuten neu eingestellte Sofort-Kaufen-Angebote und meldet per ntfy,
// wenn sich ein Weiterverkauf lohnt. Für wenige eBay-Abfragen werden alle Modelle in wenigen
// Oder-Suchen gebündelt ("(3070,3080,…)"); Modellzuordnung und Filter laufen lokal wie im stündlichen
// Lauf. Als Verkaufspreis dient der günstigste Sofortkauf aus dem letzten stündlichen Lauf.
//
// Umgebung: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, NTFY_TOPIC (ohne: nur Ausgabe im Log),
// MARKETS_FILE (markets.json aus dem Branch data), RAM_MARKETS_FILE (ram-markets.json aus dem Branch data),
// NOTIFIED_FILE (bereits gemeldete Angebote), USAGE_FILE (API-Verbrauch aus dem stündlichen Lauf).

import { readFile, writeFile } from "node:fs/promises";
import { config, getToken, search, totalPrice, rejectReason } from "./lib.mjs";
import { ramConfig, parseRam, marketKey, rejectReason as ramRejectReason } from "./ram-lib.mjs";

const now = Date.now();
const HOUR = 3.6e6, DAY = 24 * HOUR;
const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, NTFY_TOPIC, NTFY_URL = "https://ntfy.sh" } = process.env;
const marketsFile = process.env.MARKETS_FILE ?? "data/markets.json";
const ramMarketsFile = process.env.RAM_MARKETS_FILE ?? "data/ram-markets.json";
const notifiedFile = process.env.NOTIFIED_FILE ?? "data/notified.json";
const usageFile = process.env.USAGE_FILE ?? "data/usage.json";
const notify = config.notify ?? {};

if (process.env.QUICK_TEST === "true") {
  if (!NTFY_TOPIC) throw new Error("Secret NTFY_TOPIC fehlt.");
  const res = await fetch(NTFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: NTFY_TOPIC, title: "Testnachricht Grafikkarten-Schnäppchen",
      message: "Wenn du das liest, kommen die Meldungen vom Schnellcheck an.", tags: ["white_check_mark"] }),
  });
  console.log(`Testnachricht gesendet: ${res.status}`);
  process.exit(res.ok ? 0 : 1);
}

const markets = (await readFile(marketsFile, "utf8").then(JSON.parse).catch(() => null))?.markets;
const ramMarkets = (await readFile(ramMarketsFile, "utf8").then(JSON.parse).catch(() => null))?.markets;
if (!markets && !ramMarkets) {
  console.log("Noch keine Marktwerte aus dem stündlichen Lauf – Schnellcheck übersprungen.");
  process.exit(0);
}
// Budget: eBay erlaubt 5.000 Abfragen am Tag. Der stündliche Lauf hat Vorrang – reicht der Rest bis zum
// Zurücksetzen nicht mehr für ihn, setzt der Schnellcheck aus. Stand aus dem letzten stündlichen Lauf,
// seitdem verbrauchte Schnellcheck-Abfragen werden geschätzt.
const HOURLY_RUN_CALLS = 150, QUICK_CALLS = 4, QUICK_PER_HOUR = 12;
const usage = (await readFile(usageFile, "utf8").then(JSON.parse).catch(() => null));
const rate = usage?.rates?.find((x) => x.resource === "buy.browse");
if (rate?.reset && usage.updatedAt) {
  const reset = Date.parse(rate.reset), since = Date.parse(usage.updatedAt);
  if (reset > now && since > reset - DAY) { // Stand vom aktuellen Tageszeitraum
    const left = rate.remaining - (now - since) / HOUR * QUICK_PER_HOUR * QUICK_CALLS;
    const reserve = Math.ceil((reset - now) / HOUR) * HOURLY_RUN_CALLS;
    if (left - QUICK_CALLS < reserve) {
      console.log(`Budget knapp: noch etwa ${Math.round(left)} Abfragen, ${reserve} für die stündlichen Läufe bis zum Zurücksetzen reserviert – Schnellcheck setzt aus.`);
      process.exit(0);
    }
    console.log(`Budget: noch etwa ${Math.round(left)} Abfragen bis ${new Date(reset).toISOString()}, Reserve ${reserve}.`);
  }
}
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET fehlen.");
const notified = await readFile(notifiedFile, "utf8").then(JSON.parse).catch(() => ({}));

const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
const hits = [];
const fresh = (i, maxAgeMinutes) => !notified[i.itemId] && now - (i.itemCreationDate ? Date.parse(i.itemCreationDate) : now) <= maxAgeMinutes * 60e3;

// ---- Grafikkarten ----
if (markets) {
  // Modellnummern bündeln, je Suche höchstens 6 Begriffe.
  const numbers = [...new Set(config.searches.flatMap((s) => s.query.match(/\d{4}/g) ?? []))];
  const chunks = [];
  for (let i = 0; i < numbers.length; i += 6) chunks.push(numbers.slice(i, i + 6));

  const where = `priceCurrency:${config.currency},itemLocationCountry:DE`
    + (config.conditionIds ? `,conditionIds:{${config.conditionIds}}` : "")
    + ",buyingOptions:{FIXED_PRICE}";
  const items = new Map();
  for (const chunk of chunks) {
    const found = await search(token, { q: `(${chunk.join(",")})`, filter: where, sort: "newlyListed", limit: "200" });
    for (const i of found) items.set(i.itemId, i);
  }

  // Zur Kontrolle: Alter der neuesten Angebote (zeigt, ob die Sortierung nach Einstelldatum greift).
  const ages = [...items.values()].map((i) => i.itemCreationDate ? Math.round((now - Date.parse(i.itemCreationDate)) / 60e3) : null);
  console.log(`Alter der ersten Treffer (Minuten): ${ages.slice(0, 5).join(", ")} … neuestes: ${Math.min(...ages.filter((x) => x != null))}`);

  const r = config.resale ?? { shipping: 0, packaging: 0, feeRate: 0 };
  let freshCount = 0;
  for (const i of items.values()) {
    if (i.buyingOptions?.includes("AUCTION")) continue; // Auktion mit Sofort-Kaufen: Preis wäre das Gebot
    if (!fresh(i, notify.maxAgeMinutes ?? 90)) continue;
    freshCount++;
    // Erstes Modell, für das das Angebot alle Filter besteht (z. B. 4070 schließt "Ti" aus, 4070 Ti nicht).
    const s = config.searches.find((x) => !rejectReason(i, x));
    const m = s && markets[s.label];
    if (!m) continue;
    // Verkaufspreis: günstigster anderer Sofortkauf, aber höchstens der Median echter Verkäufe –
    // ein einzelnes überteuertes Angebot soll keinen Gewinn vortäuschen.
    let resale = m.cheapestBin && m.cheapestBin.id !== i.itemId ? m.cheapestBin.price : m.nextBin?.price;
    if (m.soldCount >= (r.soldCapMin ?? 2) && m.soldMedian && (!resale || m.soldMedian < resale)) resale = m.soldMedian;
    if (!resale) continue;
    const total = totalPrice(i);
    const fee = notify.business ? resale * r.feeRate : 0;
    const profit = resale - fee - r.shipping - r.packaging - total;
    // Mindestgewinn absolut und relativ zum Kaufpreis: 100 € bei einer 5.900-€-Karte sind kein Schnäppchen.
    const required = Math.max(notify.minProfit ?? 30, total * (notify.minProfitPercent ?? 10) / 100);
    if (profit >= required) hits.push({ i, label: s.label, total, resale, profit, required });
  }
  console.log(`Grafikkarten: ${items.size} Angebote geprüft, ${freshCount} neu, ${hits.length} lohnend.`);
}


// ---- Arbeitsspeicher: eine Suche für DDR4 und DDR5 ----
if (ramMarkets) {
  const rn = ramConfig.notify ?? {}, rr = ramConfig.resale;
  const ramWhere = `priceCurrency:${ramConfig.currency},itemLocationCountry:DE,conditionIds:{${ramConfig.conditionIds}},buyingOptions:{FIXED_PRICE}`;
  const found = await search(token, { q: "(ddr4,ddr5)", category_ids: ramConfig.categoryIds, filter: ramWhere, sort: "newlyListed", limit: "200" });
  let freshRam = 0, ramHits = 0;
  for (const i of found) {
    if (i.buyingOptions?.includes("AUCTION") || !fresh(i, rn.maxAgeMinutes ?? 90) || ramRejectReason(i)) continue;
    freshRam++;
    const key = marketKey(parseRam(i.title)), m = ramMarkets[key];
    if (!m || m.offers < 3) continue; // zu wenig Vergleich
    const resale = m.cheapestBin && m.cheapestBin.id !== i.itemId ? m.cheapestBin.price : m.nextBin?.price;
    if (!resale) continue;
    const total = totalPrice(i);
    const profit = resale - rr.shipping - rr.packaging - total;
    const required = Math.max(rn.minProfit ?? 15, total * (rn.minProfitPercent ?? 10) / 100);
    if (profit >= required) { hits.push({ i, label: key, total, resale, profit, required }); ramHits++; }
  }
  console.log(`Arbeitsspeicher: ${found.length} Angebote geprüft, ${freshRam} neu, ${ramHits} lohnend.`);
}

const euro = (v) => `${Math.round(v)} €`;
for (const { i, label, total, resale, profit, required } of hits.sort((a, b) => b.profit - a.profit)) {
  const message = `${i.title}\n${euro(total)} inkl. Versand · günstigster Sofortkauf sonst ${euro(resale)}`
    + ` · Gewinn ${Math.round(profit / total * 100)} %`
    + `\nVerkäufer: ${i.seller?.feedbackScore ?? "?"} Bewertungen`;
  console.log(`  ${label}: ${euro(total)}, Gewinn ≈ ${euro(profit)} – ${i.title}`);
  if (NTFY_TOPIC) {
    const res = await fetch(NTFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title: `${label} für ${euro(total)} · Gewinn ≈ ${euro(profit)}`,
        message,
        click: i.itemWebUrl,
        tags: ["moneybag"],
        priority: profit >= 2 * required ? 5 : 4,
      }),
    });
    if (!res.ok) { console.warn(`  ntfy fehlgeschlagen: ${res.status} ${await res.text()}`); continue; }
  }
  notified[i.itemId] = now;
}

// Gemeldete Angebote eine Woche lang merken, damit nichts doppelt kommt.
for (const [id, t] of Object.entries(notified)) if (t < now - 7 * DAY) delete notified[id];
await writeFile(notifiedFile, JSON.stringify(notified));
