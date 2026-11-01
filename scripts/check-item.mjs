// Einzelnes Angebot prüfen: eBay-Link (auch Kurzlink ebay.io/…) auflösen, Artikel abrufen und mit
// vergleichbaren Angeboten sowie den gesammelten Verkaufsdaten vergleichen.
// Start über den Workflow "Angebot prüfen" (workflow_dispatch mit dem Link); Ergebnis im Log und in der
// Zusammenfassung des Laufs.
//
// Umgebung: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, ITEM_URL, HISTORY_DIR (Branch data), GITHUB_STEP_SUMMARY.

import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { API, config, getToken, headers, search, num, totalPrice, quantile, median, rejectReason, domestic, trusted, searchQuery, modelPattern, excluded } from "./lib.mjs";
import { ramConfig, parseRam, marketKey } from "./ram-lib.mjs";

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, ITEM_URL, HISTORY_DIR = "history", GITHUB_STEP_SUMMARY } = process.env;
if (!ITEM_URL) throw new Error("ITEM_URL fehlt.");
const now = Date.now();
const eur = (v) => (Number.isFinite(v) ? `${v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : "–");
const lines = [];
const out = (s = "") => { console.log(s); lines.push(s); };

// 1. Link auflösen: Weiterleitungen folgen, Artikelnummer aus der Ziel-URL oder notfalls aus dem HTML lesen
async function resolveItemId(url) {
  const direct = url.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/) ?? url.match(/[?&]item=(\d{9,})/);
  if (direct) return direct[1];
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "de-DE" } });
  const target = res.url;
  console.log(`Link führt zu: ${target}`);
  const m = target.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/) ?? target.match(/[?&](?:item|itemId|iid)=(\d{9,})/);
  if (m) return m[1];
  const html = await res.text();
  const h = html.match(/ebay\.[a-z.]+\/itm\/(?:[^/"?#]+\/)?(\d{9,})/) ?? html.match(/"itemId"\s*:\s*"?(\d{9,})/);
  if (h) return h[1];
  throw new Error(`Keine Artikelnummer gefunden (Ziel: ${target}).`);
}

const legacyId = await resolveItemId(ITEM_URL);
const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
const res = await fetch(`${API}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${legacyId}`, { headers: headers(token) });
if (!res.ok) throw new Error(`Artikel ${legacyId} nicht abrufbar: ${res.status} ${await res.text()}`);
const item = await res.json();
const auction = item.buyingOptions?.includes("AUCTION");
const total = totalPrice(item);
const ship = num(item.shippingOptions?.[0]?.shippingCost);
const aspects = Object.fromEntries((item.localizedAspects ?? []).map((a) => [a.name, a.value]));

out(`## ${item.title}`);
out(`https://www.ebay.de/itm/${legacyId}`);
out();
out(`- **Format:** ${auction ? `Auktion, aktuelles Gebot ${eur(num(item.currentBidPrice ?? item.price))}, ${item.bidCount ?? 0} Gebote, Ende ${item.itemEndDate}` : "Sofort-Kaufen"}`
  + (item.buyingOptions?.includes("BEST_OFFER") ? " · Preisvorschlag möglich" : ""));
out(`- **Preis inkl. Versand:** ${eur(total)} (Versand ${Number.isFinite(ship) ? eur(ship) : "unbekannt"})`);
out(`- **Zustand:** ${item.condition ?? "–"}${item.conditionDescription ? ` – ${item.conditionDescription}` : ""}`);
out(`- **Verkäufer:** ${item.seller?.username ?? "–"}, ${item.seller?.feedbackScore ?? "?"} Bewertungen, ${item.seller?.feedbackPercentage ?? "?"} % positiv`
  + `${item.seller?.sellerAccountType ? ` (${item.seller.sellerAccountType === "BUSINESS" ? "gewerblich" : "privat"})` : ""}`);
out(`- **Standort:** ${[item.itemLocation?.city, item.itemLocation?.country].filter(Boolean).join(", ") || "–"} · Kategorie: ${item.categoryPath ?? item.categoryId}`);
if (item.returnTerms) out(`- **Rücknahme:** ${item.returnTerms.returnsAccepted ? `ja, ${item.returnTerms.returnPeriod?.value ?? "?"} Tage` : "nein"}`);
if (Object.keys(aspects).length) out(`- **Merkmale:** ${Object.entries(aspects).slice(0, 14).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
out();

// 2. Kategorie erkennen und Vergleich suchen
const where = `priceCurrency:EUR,itemLocationCountry:DE,conditionIds:{${config.conditionIds}}`;
// Modell nur über Namen und modellspezifische Ausschlüsse (z. B. 4070 ohne "Ti"), nicht über Verkäufer- oder Preisfilter
const titleLc = (item.title ?? "").toLowerCase();
const gpu = config.searches.find((s) => modelPattern(s).test(titleLc) && !excluded(titleLc, s.exclude ?? []));
const ram = !gpu && parseRam(item.title ?? "");
let comps = [], soldPrices = [], label;

const read = (f) => readFile(join(HISTORY_DIR, f), "utf8").then(JSON.parse).catch(() => null);
if (gpu) {
  label = gpu.label;
  comps = await search(token, { q: searchQuery(gpu), filter: `${where},buyingOptions:{FIXED_PRICE}`, sort: "price", limit: "100" });
  comps = comps.filter((i) => !rejectReason(i, gpu));
  const h = await read("history.json");
  soldPrices = (h?.sold ?? []).filter((x) => x.model === gpu.label && x.at > now - 30 * 864e5);
} else if (ram) {
  label = marketKey(ram);
  const q = `${ram.ddr} ${ram.form === "sodimm" ? "sodimm" : "ram"} ${ram.total}gb`;
  comps = await search(token, { q, category_ids: ramConfig.categoryIds, filter: `${where},buyingOptions:{FIXED_PRICE}`, sort: "price", limit: "100" });
  comps = comps.filter((i) => { const r = parseRam(i.title ?? ""); return r && marketKey(r) === label && domestic(i) && trusted(i); });
  const h = await read("ram-history.json");
  soldPrices = (h?.ended ?? []).filter((x) => x.key === label && x.result === "sold").map((x) => ({ price: x.price, kind: "auction", at: x.at }));
} else {
  // Sonstiges (z. B. Mini-PC): Titel ohne Füllwörter als Suche in derselben Kategorie
  const words = (item.title ?? "").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter((w) => w.length > 1 && !/^(neu|new|top|ovp|gebraucht|zustand|wie|mit|und|für|inkl|versand|rechnung|garantie)$/i.test(w)).slice(0, 6);
  label = words.join(" ");
  comps = await search(token, { q: label, category_ids: item.categoryId, filter: `${where},buyingOptions:{FIXED_PRICE}`, sort: "price", limit: "50" });
  comps = comps.filter((i) => domestic(i) && trusted(i));
}
comps = comps.filter((i) => i.legacyItemId !== legacyId && !i.itemId?.includes(`|${legacyId}|`));
const prices = comps.map(totalPrice).filter(Number.isFinite).sort((a, b) => a - b);

out(`### Vergleich: ${label} (${comps.length} Sofortkauf-Angebote aus Deutschland)`);
if (prices.length) {
  out(`- Günstigster: **${eur(prices[0])}** · günstigstes Viertel bis ${eur(quantile(prices, 0.25))} · Median ${eur(median(prices))}`);
  const rank = prices.filter((p) => p < total).length;
  out(`- Dieses Angebot: ${eur(total)} – ${rank === 0 ? "**günstiger als alle Vergleichsangebote**" : `${rank} Vergleichsangebote sind günstiger`}`);
}
if (soldPrices.length) {
  const a = soldPrices.filter((x) => x.kind === "auction").map((x) => x.price), b = soldPrices.filter((x) => x.kind !== "auction").map((x) => x.price);
  out(`- Verkäufe (30 Tage, eigene Beobachtung): ${a.length ? `${a.length} Auktionen, Median **${eur(median(a))}**` : "keine Auktionen"}`
    + `${b.length ? ` · ${b.length} Sofortkäufe verschwunden, Median ${eur(median(b))}` : ""}`);
}
// Wiederverkauf wie auf der Seite: günstigster anderer Sofortkauf, höchstens der Verkaufs-Median
const allSold = soldPrices.map((x) => x.price);
let resale = prices[0];
if (allSold.length >= 2 && median(allSold) < resale) resale = median(allSold);
const costs = (gpu ? config.resale.shipping + config.resale.packaging : ram ? ramConfig.resale.shipping + ramConfig.resale.packaging : 10);
if (Number.isFinite(resale)) {
  const profit = resale - costs - total;
  const maxBuy = resale - costs - Math.max(15, resale * 0.1);
  out(`- Wiederverkauf ca. ${eur(resale)} → **Gewinn ${profit >= 0 ? "+" : ""}${eur(profit)}** (${Math.round(profit / total * 100)} %) nach ${eur(costs)} Versand/Verpackung`);
  out(`- Lohnender Höchstpreis inkl. Versand: **${eur(maxBuy)}**`);
}
out();
out("| Preis inkl. Versand | Zustand | Verkäufer | Angebot |");
out("|---:|---|---|---|");
for (const i of comps.sort((a, b) => totalPrice(a) - totalPrice(b)).slice(0, 12)) {
  out(`| ${eur(totalPrice(i))} | ${i.condition ?? "–"} | ${i.seller?.feedbackScore ?? "?"} Bew. | [${(i.title ?? "").replace(/\|/g, "/").slice(0, 80)}](${i.itemWebUrl}) |`);
}
if (GITHUB_STEP_SUMMARY) await appendFile(GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
