// Schnellcheck: sucht alle paar Minuten neu eingestellte Sofort-Kaufen-Angebote und meldet per ntfy,
// wenn sich ein Weiterverkauf lohnt. Für wenige eBay-Abfragen werden alle Modelle in wenigen
// Oder-Suchen gebündelt ("(3070,3080,…)"); Modellzuordnung und Filter laufen lokal wie im stündlichen
// Lauf. Als Verkaufspreis dient der günstigste Sofortkauf aus dem letzten stündlichen Lauf.
//
// Umgebung: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, NTFY_TOPIC (ohne: nur Ausgabe im Log),
// MARKETS_FILE (markets.json aus dem Branch data), NOTIFIED_FILE (bereits gemeldete Angebote).

import { readFile, writeFile } from "node:fs/promises";
import { config, getToken, search, totalPrice, rejectReason } from "./lib.mjs";

const now = Date.now();
const HOUR = 3.6e6, DAY = 24 * HOUR;
const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, NTFY_TOPIC, NTFY_URL = "https://ntfy.sh" } = process.env;
const marketsFile = process.env.MARKETS_FILE ?? "data/markets.json";
const notifiedFile = process.env.NOTIFIED_FILE ?? "data/notified.json";
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
if (!markets) {
  console.log("Noch keine Marktwerte aus dem stündlichen Lauf – Schnellcheck übersprungen.");
  process.exit(0);
}
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET fehlen.");
const notified = await readFile(notifiedFile, "utf8").then(JSON.parse).catch(() => ({}));

// Modellnummern bündeln, je Suche höchstens 6 Begriffe.
const numbers = [...new Set(config.searches.flatMap((s) => s.query.match(/\d{4}/g) ?? []))];
const chunks = [];
for (let i = 0; i < numbers.length; i += 6) chunks.push(numbers.slice(i, i + 6));

const where = `priceCurrency:${config.currency},itemLocationCountry:DE`
  + (config.conditionIds ? `,conditionIds:{${config.conditionIds}}` : "")
  + ",buyingOptions:{FIXED_PRICE}";
const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
const items = new Map();
for (const chunk of chunks) {
  const found = await search(token, { q: `(${chunk.join(",")})`, filter: where, sort: "newlyListed", limit: "200" });
  for (const i of found) items.set(i.itemId, i);
}

// Zur Kontrolle: Alter der neuesten Angebote (zeigt, ob die Sortierung nach Einstelldatum greift).
const ages = [...items.values()].map((i) => i.itemCreationDate ? Math.round((now - Date.parse(i.itemCreationDate)) / 60e3) : null);
console.log(`Alter der ersten Treffer (Minuten): ${ages.slice(0, 5).join(", ")} … neuestes: ${Math.min(...ages.filter((x) => x != null))}`);

const r = config.resale ?? { shipping: 0, packaging: 0, feeRate: 0 };
const maxAge = (notify.maxAgeMinutes ?? 90) * 60e3;
const hits = [];
let fresh = 0;
for (const i of items.values()) {
  if (i.buyingOptions?.includes("AUCTION")) continue; // Auktion mit Sofort-Kaufen: Preis wäre das Gebot
  const created = i.itemCreationDate ? Date.parse(i.itemCreationDate) : now;
  if (now - created > maxAge || notified[i.itemId]) continue;
  fresh++;
  // Erstes Modell, für das das Angebot alle Filter besteht (z. B. 4070 schließt "Ti" aus, 4070 Ti nicht).
  const s = config.searches.find((x) => !rejectReason(i, x));
  const m = s && markets[s.label];
  if (!m) continue;
  const resale = m.cheapestBin && m.cheapestBin.id !== i.itemId ? m.cheapestBin.price : m.nextBin?.price;
  if (!resale) continue;
  const total = totalPrice(i);
  const fee = notify.business ? resale * r.feeRate : 0;
  const profit = resale - fee - r.shipping - r.packaging - total;
  if (profit >= (notify.minProfit ?? 30)) hits.push({ i, s, total, resale, profit });
}
console.log(`${items.size} Angebote geprüft, ${fresh} neu, ${hits.length} lohnend.`);

const euro = (v) => `${Math.round(v)} €`;
for (const { i, s, total, resale, profit } of hits.sort((a, b) => b.profit - a.profit)) {
  const message = `${i.title}\n${euro(total)} inkl. Versand · günstigster Sofortkauf sonst ${euro(resale)}`
    + `\nVerkäufer: ${i.seller?.feedbackScore ?? "?"} Bewertungen`;
  console.log(`  ${s.label}: ${euro(total)}, Gewinn ≈ ${euro(profit)} – ${i.title}`);
  if (NTFY_TOPIC) {
    const res = await fetch(NTFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title: `${s.label} für ${euro(total)} · Gewinn ≈ ${euro(profit)}`,
        message,
        click: i.itemWebUrl,
        tags: ["moneybag"],
        priority: profit >= 2 * (notify.minProfit ?? 30) ? 5 : 4,
      }),
    });
    if (!res.ok) { console.warn(`  ntfy fehlgeschlagen: ${res.status} ${await res.text()}`); continue; }
  }
  notified[i.itemId] = now;
}

// Gemeldete Angebote eine Woche lang merken, damit nichts doppelt kommt.
for (const [id, t] of Object.entries(notified)) if (t < now - 7 * DAY) delete notified[id];
await writeFile(notifiedFile, JSON.stringify(notified));
