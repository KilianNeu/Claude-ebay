// Schnellcheck: sucht alle paar Minuten neu eingestellte Sofort-Kaufen-Angebote und meldet per ntfy,
// wenn sich ein Weiterverkauf lohnt. Für wenige eBay-Abfragen werden alle Modelle in wenigen
// Oder-Suchen gebündelt ("(3070,3080,…)"); Modellzuordnung und Filter laufen lokal wie im stündlichen
// Lauf. Als Verkaufspreis dient der günstigste Sofortkauf aus dem letzten stündlichen Lauf.
//
// Umgebung: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, NTFY_TOPIC (ohne: nur Ausgabe im Log),
// MARKETS_FILE (markets.json aus dem Branch data), RAM_MARKETS_FILE (ram-markets.json aus dem Branch data),
// NOTIFIED_FILE (bereits gemeldete Angebote), USAGE_FILE (API-Verbrauch aus dem stündlichen Lauf).

import { readFile, writeFile } from "node:fs/promises";
import { config, getToken, search, getItem, totalPrice, rejectReason, median, searchQuery } from "./lib.mjs";
import { ramConfig, parseRam, marketKey, isServerRam, rejectReason as ramRejectReason } from "./ram-lib.mjs";

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
let ramRoom = 0; // verbleibende RAM-Meldungen in den letzten 24 Stunden
// Gemeldete Angebote: { id: { t, cat } } (ältere Einträge nur mit Zeitstempel)
const notedAt = (v) => (typeof v === "number" ? v : v?.t ?? 0);
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
    if (profit >= required) hits.push({ i, cat: "gpu", label: s.label, total, resale, profit, required, s, m,
      costs: fee + r.shipping + r.packaging, basis: resale === m.soldMedian ? "Verkaufs-Median" : "günstigster Sofortkauf" });
  }
  console.log(`Grafikkarten: ${items.size} Angebote geprüft, ${freshCount} neu, ${hits.length} lohnend.`);
}


// ---- Arbeitsspeicher: eine Suche für DDR4 und DDR5 ----
// Strenger als bei Grafikkarten: kleine Beträge, viele Angebote – sonst kommen zu viele Meldungen.
if (ramMarkets) {
  const rn = ramConfig.notify ?? {}, rr = ramConfig.resale;
  const ramWhere = `priceCurrency:${ramConfig.currency},itemLocationCountry:DE,conditionIds:{${ramConfig.conditionIds}},buyingOptions:{FIXED_PRICE}`;
  const found = await search(token, { q: "(ddr4,ddr5)", category_ids: ramConfig.categoryIds, filter: ramWhere, sort: "newlyListed", limit: "200" });
  const ramHits = [];
  let freshRam = 0;
  for (const i of found) {
    if (i.buyingOptions?.includes("AUCTION") || !fresh(i, rn.maxAgeMinutes ?? 90) || ramRejectReason(i)) continue;
    freshRam++;
    const key = marketKey(parseRam(i.title)), m = ramMarkets[key];
    if (!m || m.offers < (rn.minOffers ?? 5)) continue; // zu wenig Vergleich
    let resale = m.cheapestBin && m.cheapestBin.id !== i.itemId ? m.cheapestBin.price : m.nextBin?.price, basis = "günstigster Sofortkauf";
    // Höchstens der Median echter Auktionsverkäufe
    if (m.soldCount >= (rr.soldCapMin ?? 2) && m.soldMedian && (!resale || m.soldMedian < resale)) [resale, basis] = [m.soldMedian, `Median von ${m.soldCount} Verkäufen`];
    if (!resale) continue;
    const total = totalPrice(i);
    const profit = resale - rr.shipping - rr.packaging - total;
    const required = Math.max(rn.minProfit ?? 25, total * (rn.minProfitPercent ?? 20) / 100);
    if (profit >= required) ramHits.push({ i, cat: "ram", label: key, total, resale, profit, required, basis, m,
      ram: parseRam(i.title), costs: rr.shipping + rr.packaging });
  }
  // Höchstens maxPerDay RAM-Meldungen in 24 Stunden, die besten zuerst
  const sentToday = Object.values(notified).filter((v) => v?.cat === "ram" && !v.skipped && notedAt(v) > now - DAY).length;
  ramRoom = Math.max(0, (rn.maxPerDay ?? 4) - sentToday);
  hits.push(...ramHits);
  console.log(`Arbeitsspeicher: ${found.length} Angebote geprüft, ${freshRam} neu, ${ramHits.length} lohnend, heute ${sentToday} gemeldet, noch ${ramRoom} frei.`);
}

// ---- Vor dem Melden: vollständiges Angebot prüfen ----
// Die Suche liefert nur Titel und Preis. Merkmale und Zustandsbeschreibung verraten oft mehr
// (Server-RAM ohne "ECC" im Titel, falsche Kapazität, "Artefakte" in der Beschreibung).
const DEFECT = /defekt|artefakt|bastler|kein bild|bildfehler|black ?screen|blue ?screen|ersatzteil|reparatur|funktioniert nicht|geht nicht|startet nicht|wasserschaden|memtest[^.]{0,30}(fehler|error)|fehlerhaft/i;
async function verify(hit) {
  const r = await getItem(token, hit.i.itemId).catch(() => null);
  if (!r || r.gone) return "Angebot nicht mehr abrufbar";
  const it = r.item;
  if (it.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus === "OUT_OF_STOCK") return "ausverkauft";
  const desc = `${it.conditionDescription ?? ""} ${it.shortDescription ?? ""}`;
  const defect = desc.match(DEFECT);
  if (defect) return `Beschreibung: „${defect[0]}“`;
  if (hit.cat !== "ram") return null;
  const aspects = Object.fromEntries((it.localizedAspects ?? []).map((a) => [a.name.toLowerCase(), String(a.value ?? "")]));
  if (isServerRam(`${it.title} ${Object.values(aspects).join(" ")}`)) return "Server-RAM laut Merkmalen/Teilenummer";
  const ram = parseRam(it.title ?? "");
  const cap = Number(aspects["gesamtkapazität"]?.match(/\d+/)?.[0]);
  if (cap && cap !== ram.total) return `Gesamtkapazität laut Merkmalen ${cap} GB statt ${ram.total} GB`;
  const form = aspects["formfaktor"] ?? "";
  if (form && /s[o0]-?dimm/i.test(form) !== (ram.form === "sodimm")) return `Formfaktor laut Merkmalen: ${form}`;
  const type = `${aspects["produktart"] ?? ""} ${aspects["speichertyp"] ?? ""}`.toLowerCase();
  if (/ddr[2-5]/.test(type) && !type.includes(ram.ddr)) return `Speichertyp laut Merkmalen: ${type.trim()}`;
  return null;
}

// Zweitprüfung: frische Suche nach vergleichbaren Angeboten (Marktdaten sind bis zu einer Stunde alt und
// können dünn sein). Ausreißer nach unten fallen heraus; gemeldet wird nur, wenn der Gewinn auch gegen den
// günstigsten aktuellen Vergleich und den Verkaufs-Median reicht. Passt die Rechnung, ersetzt sie die alte.
async function liveCheck(hit) {
  const { i, cat, m, total, required, costs } = hit;
  const where = `priceCurrency:EUR,itemLocationCountry:DE,conditionIds:{${config.conditionIds}},buyingOptions:{FIXED_PRICE}`;
  let comps;
  if (cat === "gpu") {
    comps = (await search(token, { q: searchQuery(hit.s), filter: where, sort: "price", limit: "50" })).filter((x) => !rejectReason(x, hit.s));
  } else {
    const r = hit.ram;
    comps = (await search(token, { q: `${r.ddr} ${r.form === "sodimm" ? "sodimm" : "ram"} ${r.total}gb`, category_ids: ramConfig.categoryIds, filter: where, sort: "price", limit: "50" }))
      .filter((x) => !ramRejectReason(x) && marketKey(parseRam(x.title)) === hit.label);
  }
  comps = comps.filter((x) => x.itemId !== i.itemId && x.seller?.username !== i.seller?.username); // eigene weitere Angebote zählen nicht
  const prices = comps.map(totalPrice).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = median(prices);
  const clean = prices.filter((p) => p >= mid * 0.5);
  const minComps = cat === "ram" ? ramConfig.notify?.minOffers ?? 5 : 3;
  if (clean.length < minComps) return { problem: `Zweitprüfung: nur ${clean.length} vergleichbare Angebote` };
  let resale = clean[0], basis = `günstigstes von ${clean.length} aktuellen Vergleichsangeboten`;
  const capMin = (cat === "ram" ? ramConfig.resale.soldCapMin : config.resale.soldCapMin) ?? 2;
  if (m.soldCount >= capMin && m.soldMedian && m.soldMedian < resale) [resale, basis] = [m.soldMedian, `Median von ${m.soldCount} Verkäufen`];
  const profit = resale - costs - total;
  if (profit < required) return { problem: `Zweitprüfung: Wiederverkauf nur ca. ${Math.round(resale)} € (${basis}), Gewinn ${Math.round(profit)} €` };
  return { resale, basis, profit };
}

const euro = (v) => `${Math.round(v)} €`;
for (const hit of hits.sort((a, b) => b.profit - a.profit)) {
  const { i, cat, label, total, required } = hit;
  // Tageslimit erst nach der Prüfung anrechnen; was nicht mehr passt, bleibt unmarkiert
  if (cat === "ram" && ramRoom <= 0) { console.log(`  Tageslimit erreicht, nicht gemeldet: ${label} ${euro(total)} – ${i.title}`); continue; }
  let problem = await verify(hit);
  if (!problem) {
    const live = await liveCheck(hit);
    problem = live.problem;
    if (!problem) Object.assign(hit, { resale: live.resale, basis: live.basis, profit: live.profit });
  }
  if (problem) {
    console.log(`  verworfen nach Prüfung (${problem}): ${label} ${euro(total)} – ${i.title}`);
    notified[i.itemId] = { t: now, cat, skipped: true }; // nicht bei jedem Lauf erneut prüfen
    continue;
  }
  const { resale, profit, basis } = hit;
  const message = `${i.title}\n${euro(total)} inkl. Versand · Wiederverkauf ca. ${euro(resale)} (${basis})`
    + ` · Gewinn ${Math.round(profit / total * 100)} %`
    + `\nVerkäufer: ${i.seller?.feedbackScore ?? "?"} Bewertungen · Angebot geprüft`;
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
        tags: [cat === "ram" ? "floppy_disk" : "moneybag"],
        // RAM mit normaler Priorität, nur besonders gute Treffer laut
        priority: profit >= 2 * required ? (cat === "ram" ? 4 : 5) : (cat === "ram" ? 3 : 4),
      }),
    });
    if (!res.ok) { console.warn(`  ntfy fehlgeschlagen: ${res.status} ${await res.text()}`); continue; }
  }
  notified[i.itemId] = { t: now, cat };
  if (cat === "ram") ramRoom--;
}

// Gemeldete Angebote eine Woche lang merken, damit nichts doppelt kommt.
for (const [id, v] of Object.entries(notified)) if (notedAt(v) < now - 7 * DAY) delete notified[id];
await writeFile(notifiedFile, JSON.stringify(notified));
