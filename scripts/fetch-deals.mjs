// Holt günstige Angebote über die eBay Browse API und schreibt data/deals.json.
// Benötigt EBAY_CLIENT_ID und EBAY_CLIENT_SECRET (Production-Keyset von developer.ebay.com).
// Ohne Keys wird eine leere Datei mit Hinweis geschrieben, damit die Seite trotzdem baut.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://api.ebay.com";
const config = JSON.parse(await readFile(new URL("../searches.json", import.meta.url), "utf8"));
const outFile = new URL("../data/deals.json", import.meta.url);

async function getToken(id, secret) {
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`OAuth fehlgeschlagen: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function search(token, params) {
  if (config.categoryIds) params = { category_ids: config.categoryIds, ...params };
  const url = `${API}/buy/browse/v1/item_summary/search?` + new URLSearchParams(params);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": config.marketplace,
      "Accept-Language": "de-DE",
    },
  });
  if (!res.ok) throw new Error(`Suche fehlgeschlagen (${params.q}): ${res.status} ${await res.text()}`);
  return (await res.json()).itemSummaries ?? [];
}

const num = (p) => (p ? Number(p.value) : NaN);

// Preis inkl. Versand; bei Auktionen das aktuelle Gebot.
function totalPrice(item) {
  const base = item.buyingOptions?.includes("AUCTION") && item.currentBidPrice
    ? num(item.currentBidPrice)
    : num(item.price);
  const ship = num(item.shippingOptions?.[0]?.shippingCost);
  return base + (Number.isFinite(ship) ? ship : 0);
}

// Ausschlusswörter als ganze Wörter prüfen, damit "ti" nicht in "Edition" greift.
function excluded(title, terms) {
  const t = title.toLowerCase();
  return terms.some((term) => new RegExp(`(^|[^a-z0-9äöü])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9äöü]|$)`).test(t));
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function toDeal(item, s, reference) {
  const total = totalPrice(item);
  const auction = item.buyingOptions?.includes("AUCTION") ?? false;
  return {
    id: item.itemId,
    title: item.title,
    url: item.itemAffiliateWebUrl ?? item.itemWebUrl,
    image: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
    condition: item.condition ?? null,
    auction,
    bestOffer: item.buyingOptions?.includes("BEST_OFFER") ?? false,
    bids: auction ? item.bidCount ?? 0 : null,
    endsAt: item.itemEndDate ?? null,
    total: Math.round(total * 100) / 100,
    reference: Number.isFinite(reference) ? Math.round(reference * 100) / 100 : null,
    discount: Number.isFinite(reference) && reference > 0 ? Math.round((1 - total / reference) * 100) : null,
    location: item.itemLocation?.country ?? null,
    seller: item.seller ? { name: item.seller.username, feedback: item.seller.feedbackPercentage } : null,
    search: s.label,
  };
}

async function dealsFor(token, s) {
  const terms = [...(config.exclude ?? []), ...(s.exclude ?? [])];
  const keep = (items) => items.filter((i) => !excluded(i.title ?? "", terms));
  const where = `priceCurrency:${config.currency},itemLocationCountry:DE`
    + (config.condition ? `,conditions:{${config.condition}}` : "");

  // Referenzpreis: Median der relevantesten Sofortkauf-Angebote (ohne Zubehör, Defekte usw.).
  const refItems = keep(await search(token, { q: s.query, filter: `${where},buyingOptions:{FIXED_PRICE}`, limit: "100" }));
  const reference = median(refItems.map(totalPrice));
  // Ohne Referenz lässt sich kein Schnäppchen erkennen.
  if (!Number.isFinite(reference)) return [];
  const floor = reference * (config.floorRatio ?? 0);
  const cap = s.maxPrice ?? reference * config.dealThreshold;
  const filter = `price:[${Math.floor(floor)}..${Math.ceil(cap)}],${where}`;

  const [cheapest, ending] = await Promise.all([
    search(token, { q: s.query, filter: `${filter},buyingOptions:{FIXED_PRICE}`, sort: "price", limit: "30" }),
    search(token, { q: s.query, filter: `${filter},buyingOptions:{AUCTION}`, sort: "endingSoonest", limit: "30" }),
  ]);

  const seen = new Set();
  const deals = keep([...cheapest, ...ending])
    .filter((i) => !seen.has(i.itemId) && seen.add(i.itemId))
    .map((i) => toDeal(i, s, reference))
    .filter((d) => Number.isFinite(d.total) && d.total >= floor && d.total <= reference * config.dealThreshold)
    .sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0))
    .slice(0, config.maxItemsPerSearch);
  console.log(`  ${s.label}: Referenz ${reference.toFixed(0)} € aus ${refItems.length} Angeboten, ${deals.length} Treffer`);
  return deals;
}

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
const result = { updatedAt: new Date().toISOString(), searches: config.searches, deals: [], errors: [] };

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  result.errors.push("Keine eBay-API-Keys hinterlegt (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET).");
} else {
  const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
  for (const s of config.searches) {
    try {
      result.deals.push(...(await dealsFor(token, s)));
    } catch (e) {
      result.errors.push(e.message);
    }
  }
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(outFile, JSON.stringify(result, null, 2));
console.log(`${result.deals.length} Angebote gespeichert, ${result.errors.length} Fehler.`);
for (const e of result.errors) console.warn("  " + e);
