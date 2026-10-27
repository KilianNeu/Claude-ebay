// Arbeitsspeicher (DDR4/DDR5, Laptop-SO-DIMM und Desktop-DIMM) als eigene Kategorie, unabhängig von
// Grafikkarten und Mini-PCs (eigene Konfiguration ram.json, eigene Ausgabe data/ram.json).
//
// Ein Markt ist DDR-Generation × Bauform × Gesamtkapazität, z. B. "DDR4 SO-DIMM 32 GB" (Kits wie 2×16 GB
// zählen als 32 GB). Referenz wie bei den Grafikkarten: Median der beobachteten Auktions-Endpreise
// (ab minSold Verkäufen), sonst das günstigste Viertel der Sofort-Kaufen-Angebote.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { API, getToken, getItem, num, totalPrice, domestic, quantile, median } from "./lib.mjs";

const config = JSON.parse(await readFile(new URL("../ram.json", import.meta.url), "utf8"));
const outFile = new URL("../data/ram.json", import.meta.url);
const statsFile = new URL("../data/ram-stats.json", import.meta.url);
const historyFile = process.env.RAM_HISTORY ?? "data/ram-history.json";
const MAX_SETTLE = 40, WINDOW = 30 * 864e5;
const now = Date.now();
const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
await mkdir(new URL("../data/", import.meta.url), { recursive: true });

// Mit Kategorie "Arbeitsspeicher"; liefert schon die erste Suche damit nichts (falsche Kategorie-ID),
// gilt die Kategorie für den ganzen Lauf als unbrauchbar.
let useCategory = Boolean(config.categoryIds), categoryChecked = false;
async function search(token, params) {
  const run = async (withCategory) => {
    const p = withCategory ? { category_ids: config.categoryIds, ...params } : params;
    const res = await fetch(`${API}/buy/browse/v1/item_summary/search?` + new URLSearchParams(p), {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": config.marketplace, "Accept-Language": "de-DE" },
    });
    if (!res.ok) throw new Error(`Suche fehlgeschlagen (${params.q}): ${res.status} ${await res.text()}`);
    return (await res.json()).itemSummaries ?? [];
  };
  const items = await run(useCategory);
  const first = !categoryChecked;
  categoryChecked = true;
  if (useCategory && first && !items.length) {
    console.warn(`  Kategorie ${config.categoryIds} liefert nichts für "${params.q}" – suche ohne Kategorie.`);
    useCategory = false;
    return run(false);
  }
  return items;
}

const where = `priceCurrency:${config.currency},itemLocationCountry:DE,conditionIds:{${config.conditionIds}}`;

// ---- Titel auswerten ----

const SIZES = new Set([4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]);
export function parseRam(title) {
  const t = title.toLowerCase().replace(/,/g, ".");
  const ddr = /ddr5/.test(t) ? "ddr5" : /ddr4/.test(t) ? "ddr4" : null;
  if (!ddr || /ddr3|ddr2/.test(t)) return null;
  const form = /so-?dimm|sodimm|laptop|notebook|\bsod\b|260-?pin|262-?pin/.test(t) ? "sodimm" : "dimm";
  // Kit: "2x16GB", "2 x 8 GB", "4x32 GB"; sonst Gesamtangabe "32GB" (größte plausible Zahl vor GB)
  let modules = 1, total = null, m;
  if ((m = t.match(/\b([1-8])\s*[x×]\s*(\d{1,3})\s*gb\b/))) [modules, total] = [Number(m[1]), Number(m[1]) * Number(m[2])];
  else if ((m = t.match(/\b(\d{1,3})\s*gb\s*[x×]\s*([1-8])\b/))) [modules, total] = [Number(m[2]), Number(m[1]) * Number(m[2])];
  else {
    const sizes = [...t.matchAll(/\b(\d{1,3})\s*gb\b/g)].map((x) => Number(x[1])).filter((v) => SIZES.has(v));
    if (sizes.length) total = Math.max(...sizes);
  }
  if (!SIZES.has(total)) return null;
  // Takt: "3200MHz", "DDR4-3200", "6000 MT/s", "PC4-2666V", "PC4-25600" (÷ 8) oder eine übliche Taktzahl allein
  const SPEEDS = new Set([2133, 2400, 2666, 2667, 2933, 3000, 3200, 3466, 3600, 4000, 4400, 4800, 5200, 5600, 6000, 6400, 6800, 7200, 8000]);
  let speed = null;
  const pc = t.match(/pc[45]-?(\d{4,5})/);
  if (pc) speed = pc[1].length === 5 ? Math.round(Number(pc[1]) / 8 / 100) * 100 : Number(pc[1]);
  else speed = [...t.matchAll(/(?<![\d.])(\d{4})(?![\d.])/g)].map((x) => Number(x[1])).find((v) => SPEEDS.has(v)) ?? null;
  return { ddr, form, total, modules, speed };
}

export const marketKey = (r) => `${r.ddr.toUpperCase()} ${r.form === "sodimm" ? "SO-DIMM" : "DIMM"} ${r.total} GB`;

function excludedTerm(title) {
  const t = title.toLowerCase();
  return config.exclude.find((term) => new RegExp(`(^|[^a-z0-9äöü])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9äöü]|$)`).test(t));
}

function trusted(i) {
  const score = Number(i.seller?.feedbackScore), positive = Number(i.seller?.feedbackPercentage);
  if (Number.isFinite(score) && score < config.minSellerFeedback) return false;
  if (Number.isFinite(positive) && positive > 0 && positive < config.minSellerPositive) return false; // 0.0 = unbekannt
  return true;
}

function rejectReason(i) {
  if (i.conditionId === "7000") return "Zustand: defekt";
  if (!domestic(i)) return "nicht auf ebay.de in Euro oder Standort nicht Deutschland";
  if (!trusted(i)) return `Verkäufer: ${i.seller?.feedbackScore ?? "?"} Bewertungen`;
  const term = excludedTerm(i.title ?? "");
  if (term) return `Ausschlusswort „${term}“`;
  const r = parseRam(i.title ?? "");
  if (!r) return "DDR-Generation oder Größe nicht im Titel";
  if (r.total < config.minCapacity) return `kleiner als ${config.minCapacity} GB`;
  return null;
}

// ---- Hauptlauf ----

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
const result = { updatedAt: new Date(now).toISOString(), resale: config.resale, dealThreshold: config.dealThreshold, markets: [], deals: [], rejected: [], errors: [] };

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  result.errors.push("Keine eBay-API-Keys hinterlegt.");
} else {
  const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
  const hist = await readFile(historyFile, "utf8").then(JSON.parse).catch(() => ({}));
  hist.auctions ??= {}; hist.ended ??= []; hist.snapshots ??= {};

  const offers = new Map();
  const reasons = {};
  const rejected = [];
  for (const s of config.searches) {
    try {
      const [fixed, auctions] = await Promise.all([
        search(token, { q: s.query, filter: `${where},buyingOptions:{FIXED_PRICE}`, limit: "200" }),
        search(token, { q: s.query, filter: `${where},buyingOptions:{AUCTION}`, sort: "endingSoonest", limit: "100" }),
      ]);
      for (const i of [...fixed, ...auctions]) {
        if (offers.has(i.itemId)) continue;
        const reason = rejectReason(i);
        if (reason) {
          const kind = reason.replace(/„.*“|: [\d?]+ Bewertungen/g, "").trim();
          reasons[kind] = (reasons[kind] ?? 0) + 1;
          if (!/Größe|kleiner/.test(reason) && !i.buyingOptions?.includes("AUCTION")) {
            rejected.push({ price: round2(totalPrice(i)), title: i.title, url: i.itemWebUrl, reason });
          }
          continue;
        }
        const r = parseRam(i.title);
        // Hybridauktionen (Auktion mit Sofort-Kaufen) zählen als Auktion
        offers.set(i.itemId, { item: i, ram: r, key: marketKey(r), total: totalPrice(i), auction: i.buyingOptions?.includes("AUCTION") ?? false,
          isNew: ["1000", "1500"].includes(i.conditionId) });
      }
    } catch (e) {
      result.errors.push(e.message);
    }
  }
  console.log(`${offers.size} RAM-Angebote ausgewertet – verworfen: ` + Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));

  // ---- Beendete Auktionen: echter Endpreis per getItem ----
  for (const o of offers.values()) {
    if (!o.auction) continue;
    const i = o.item;
    hist.auctions[i.itemId] = { title: i.title, url: i.itemWebUrl, key: o.key, speed: o.ram.speed, endsAt: i.itemEndDate ?? null, bid: round2(o.total), bids: i.bidCount ?? 0 };
  }
  let settled = 0, sold = 0;
  for (const [id, a] of Object.entries(hist.auctions)) {
    const end = a.endsAt ? Date.parse(a.endsAt) : NaN;
    if (offers.has(id) || !(end < now - 5 * 60e3)) continue;
    if (settled >= MAX_SETTLE) break;
    settled++;
    const r = await getItem(token, id).catch(() => null);
    if (!r) continue; // später erneut versuchen
    let price = a.bid, bids = a.bids, res = "unknown";
    if (!r.gone) {
      const it = r.item, ship = num(it.shippingOptions?.[0]?.shippingCost);
      bids = it.bidCount ?? 0;
      price = round2(num(it.currentBidPrice ?? it.price) + (Number.isFinite(ship) ? ship : 0));
      res = it.reservePriceMet === false ? "reserve" : bids > 0 ? "sold" : "nobids";
    }
    if (res === "sold") sold++;
    hist.ended.unshift({ at: end, id, title: a.title, url: a.url, key: a.key, speed: a.speed, price, bids, result: res });
    delete hist.auctions[id];
  }
  for (const [id, a] of Object.entries(hist.auctions)) if (!a.endsAt || Date.parse(a.endsAt) < now - 7 * 864e5) delete hist.auctions[id];
  hist.ended = hist.ended.filter((x) => x.at > now - WINDOW);

  // ---- Märkte: Referenzpreis, günstigster Sofortkauf, Verkäufe ----
  const byKey = new Map();
  for (const o of offers.values()) { const l = byKey.get(o.key) ?? []; l.push(o); byKey.set(o.key, l); }
  const markets = new Map();
  for (const [key, list] of byKey) {
    const bins = list.filter((o) => !o.auction).sort((a, c) => a.total - c.total);
    const soldPrices = hist.ended.filter((x) => x.key === key && x.result === "sold").map((x) => x.price);
    const p25 = quantile(bins.map((o) => o.total), 0.25);
    const soldMedian = soldPrices.length ? median(soldPrices) : NaN;
    const reference = soldPrices.length >= config.minSold ? soldMedian : p25;
    const [r0] = list;
    const m = {
      key, ddr: r0.ram.ddr, form: r0.ram.form, total: r0.ram.total, offers: bins.length, auctions: list.length - bins.length,
      reference: round(reference), basis: soldPrices.length >= config.minSold ? "sold" : "offers", p25: round(p25),
      soldMedian: round(soldMedian), soldCount: soldPrices.length,
      perGB: round2(reference / r0.ram.total),
      cheapestBin: bins[0] ? { id: bins[0].item.itemId, price: round2(bins[0].total), url: bins[0].item.itemWebUrl, title: bins[0].item.title } : null,
      nextBin: bins[1] ? { price: round2(bins[1].total), url: bins[1].item.itemWebUrl } : null,
    };
    markets.set(key, m);
    (hist.snapshots[key] ??= []).push([now, m.cheapestBin?.price ?? null, m.p25, bins.length]);
  }
  for (const key of Object.keys(hist.snapshots)) {
    hist.snapshots[key] = hist.snapshots[key].filter((x) => x[0] > now - WINDOW);
    if (!hist.snapshots[key].length) delete hist.snapshots[key];
  }

  // ---- Schnäppchen ----
  const r = config.resale;
  for (const o of offers.values()) {
    const m = markets.get(o.key);
    if (!m?.reference || m.offers < 3) continue; // zu wenig Vergleich
    if (!(o.total <= m.reference * config.dealThreshold && o.total >= m.reference * config.floorRatio)) continue;
    const i = o.item;
    // Weiterverkauf zum günstigsten anderen Sofortkauf
    const resale = m.cheapestBin && m.cheapestBin.id !== i.itemId ? m.cheapestBin : m.nextBin;
    result.deals.push({
      id: i.itemId, title: i.title, url: i.itemWebUrl, image: i.image?.imageUrl ?? i.thumbnailImages?.[0]?.imageUrl ?? null,
      market: o.key, ddr: o.ram.ddr, form: o.ram.form, total: o.ram.total, modules: o.ram.modules, speed: o.ram.speed,
      condition: i.condition ?? null, isNew: o.isNew, auction: o.auction, bids: o.auction ? i.bidCount ?? 0 : null, endsAt: i.itemEndDate ?? null,
      bestOffer: i.buyingOptions?.includes("BEST_OFFER") ?? false,
      seller: i.seller ? { score: i.seller.feedbackScore ?? null, positive: i.seller.feedbackPercentage ?? null } : null,
      price: round2(o.total), shipping: round2(num(i.shippingOptions?.[0]?.shippingCost)), perGB: round2(o.total / o.ram.total), reference: m.reference, basis: m.basis,
      discount: Math.round((1 - o.total / m.reference) * 100),
      resale: resale ? { price: resale.price, url: resale.url } : null,
      profit: resale ? round(resale.price - r.shipping - r.packaging - o.total) : null,
    });
  }
  result.deals.sort((a, c) => (c.profit ?? -1e9) - (a.profit ?? -1e9));
  const order = (m) => `${m.ddr}${m.form === "sodimm" ? 0 : 1}${String(m.total).padStart(4, "0")}`;
  result.markets = [...markets.values()].sort((a, c) => order(a).localeCompare(order(c)));
  result.rejected = rejected.sort((a, c) => a.price - c.price).slice(0, 15);
  result.offerCount = offers.size;

  await writeFile(historyFile, JSON.stringify(hist));
  await writeFile(statsFile, JSON.stringify({ updatedAt: result.updatedAt, ended: hist.ended, series: hist.snapshots }));
  console.log(`Statistik: ${Object.keys(hist.auctions).length} Auktionen beobachtet, ${settled} beendet geprüft (${sold} verkauft), ${hist.ended.length} beendete in 30 Tagen.`);
  console.log(`${result.markets.length} Märkte, ${result.deals.length} Schnäppchen.`);
  for (const m of result.markets) console.log(`  ${m.key}: ${m.offers} Sofortkäufe, ${m.auctions} Auktionen, Referenz ${m.reference ?? "–"} € (${m.basis}), günstigster ${m.cheapestBin?.price ?? "–"} €`);
}

await writeFile(outFile, JSON.stringify(result, null, 2));
for (const e of result.errors) console.warn("  " + e);
