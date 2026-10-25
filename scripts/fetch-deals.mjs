// Holt günstige Angebote über die eBay Browse API und schreibt data/deals.json.
// Benötigt EBAY_CLIENT_ID und EBAY_CLIENT_SECRET (Production-Keyset von developer.ebay.com).
// Ohne Keys wird eine leere Datei mit Hinweis geschrieben, damit die Seite trotzdem baut.
//
// Verkaufspreise liefert die öffentliche API nicht. Deshalb führt das Skript eine eigene
// Historie (HISTORY_FILE): Beendete Auktionen werden per getItem nach ihrem Endpreis gefragt,
// verschwundene Sofort-Kaufen-Angebote ebenso geprüft. Daraus entsteht ein geschätzter Verkaufspreis.
// Das zuletzt gesehene Gebot zählt nicht, weil Auktionen in den letzten Minuten stark steigen.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://api.ebay.com";
const config = JSON.parse(await readFile(new URL("../searches.json", import.meta.url), "utf8"));
const outFile = new URL("../data/deals.json", import.meta.url);
const historyFile = process.env.HISTORY_FILE ?? new URL("../data/history.json", import.meta.url);

const HOUR = 3.6e6, DAY = 24 * HOUR;
const SOLD_WINDOW = 30 * DAY;     // Verkäufe der letzten 30 Tage zählen
const MIN_SOLD = 5;               // ab so vielen Verkäufen ersetzt der Verkaufspreis den Angebotspreis
const MIN_ASK = 5;                // weniger Angebote ergeben keinen verlässlichen Angebotspreis
const NEW_CONDITIONS = new Set(["1000", "1500"]); // Neu, Neu: Sonstige
const MAX_CHECKS = 20;            // getItem-Prüfungen verschwundener Sofort-Kaufen-Angebote pro Lauf
const MAX_AUCTION_CHECKS = 60;    // getItem-Abfragen beendeter Auktionen pro Lauf
const now = Date.now();

const statsFile = new URL("../data/stats.json", import.meta.url);

const history = await readFile(historyFile, "utf8").then(JSON.parse).catch(() => ({ listings: {}, sold: [] }));
history.snapshots ??= {}; // Modell -> [[Zeit, Angebots-Median, Anzahl, günstigstes Angebot, 25-%-Quantil], ...]
history.cheapest ??= {};  // Modell -> [{ id, title, url, isNew, price, from, to }, ...]
history.ended ??= [];     // beendete Auktionen: { id, model, title, url, price, bids, at, result }
// Auktionsverkäufe aus der Zeit vor der Liste nachtragen, damit Diagramm und Liste übereinstimmen.
for (const x of history.sold) {
  if (x.kind !== "auction" || history.ended.some((e) => e.id === x.id)) continue;
  const l = history.listings[x.id];
  history.ended.push({
    id: x.id, model: x.model, title: l?.title ?? null, url: `https://www.ebay.de/itm/${String(x.id).split("|")[1] ?? x.id}`,
    price: x.price, bids: l?.bids ?? null, at: x.at, result: "sold",
  });
}
// Version 2: Modell- und Marktplatzprüfung. Ältere Preise und Verkäufe enthielten fremde Modelle
// (z. B. RTX 2080 unter RTX 4080) und UK-Angebote und werden einmalig verworfen.
const HISTORY_VERSION = 2;
if (history.version !== HISTORY_VERSION) {
  history.sold = [];
  history.snapshots = {};
  history.version = HISTORY_VERSION;
}
let checksLeft = MAX_CHECKS, auctionChecksLeft = MAX_AUCTION_CHECKS;
const stats = { auctionFinal: 0, auctionUnsold: 0, auctionUnavailable: 0, vanishedSold: 0 };

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

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "X-EBAY-C-MARKETPLACE-ID": config.marketplace,
  "Accept-Language": "de-DE",
});

async function search(token, params) {
  if (config.categoryIds) params = { category_ids: config.categoryIds, ...params };
  const url = `${API}/buy/browse/v1/item_summary/search?` + new URLSearchParams(params);
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`Suche fehlgeschlagen (${params.q}): ${res.status} ${await res.text()}`);
  return (await res.json()).itemSummaries ?? [];
}

// { gone: true } = nicht mehr abrufbar, { item } = Angebotsdaten, null = Fehler.
async function getItem(token, itemId) {
  const res = await fetch(`${API}/buy/browse/v1/item/${encodeURIComponent(itemId)}`, { headers: headers(token) });
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (!res.ok) return null;
  return { item: await res.json() };
}

// true = Angebot beendet (verkauft oder zurückgezogen), false = noch aktiv, null = unklar.
async function hasEnded(token, itemId) {
  const r = await getItem(token, itemId);
  if (!r) return null;
  if (r.gone) return true;
  const status = r.item.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus;
  return (r.item.itemEndDate && new Date(r.item.itemEndDate) < now) || status === "OUT_OF_STOCK";
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

// Ausschlusswörter als ganze Wörter prüfen, damit "ti" nicht in "Edition" greift. Wortteile
// (excludeParts) greifen überall, auch in Zusammensetzungen wie "Lüfter+Kühlkörper".
function excluded(title, terms) {
  const t = title.toLowerCase();
  return (config.excludeParts ?? []).some((part) => t.includes(part))
    || terms.some((term) => new RegExp(`(^|[^a-z0-9äöü])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9äöü]|$)`).test(t));
}

function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q, lo = Math.floor(pos);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
}

const median = (values) => quantile(values, 0.5);

// eBays Suche ist unscharf: "rtx 4080" liefert auch "RTX 2080". Deshalb muss die Modellnummer samt
// Zusatz (Ti, Super, XT) im Titel stehen, z. B. "4070 Ti" oder "4070Ti". "rtx"/"rx" und Speichergrößen
// sind optional.
function modelPattern(s) {
  const tokens = s.query.toLowerCase().split(/\s+/).filter((t) => !/^(rtx|rx|gtx|\d+gb)$/.test(t));
  const model = new RegExp(`(^|[^0-9])${tokens.join("[\\s-]*")}([^a-z0-9]|$)`); // "RTX4080" zulassen
  if (!s.memory) return model;
  // Speichervarianten (z. B. 5060 Ti 8 GB / 16 GB): die Größe muss im Titel stehen, die andere nicht.
  const mem = (gb) => new RegExp(`(^|[^0-9])${gb}\\s*g(b)?([^a-z0-9]|$)|o${gb}g([^a-z0-9]|$)`);
  const others = [8, 12, 16].filter((gb) => gb !== s.memory).map(mem);
  return { test: (t) => model.test(t) && mem(s.memory).test(t) && !others.some((o) => o.test(t)) };
}

// Unseriöse Verkäufer ausschließen: neue Konten mit kaum Bewertungen und Verkäufer mit zu
// vielen negativen Bewertungen. Fehlt die Angabe, bleibt das Angebot drin.
function trusted(i) {
  const score = Number(i.seller?.feedbackScore), positive = Number(i.seller?.feedbackPercentage);
  if (Number.isFinite(score) && score < (config.minSellerFeedback ?? 0)) return false;
  if (Number.isFinite(positive) && score > 0 && positive < (config.minSellerPositive ?? 0)) return false;
  return true;
}

// Nur Angebote vom deutschen eBay in Euro. UK-Angebote (ebay.co.uk, Preis in £) tragen teils einen
// deutschen Standort und kämen sonst durch; hier fallen sie über Marktplatz und Originalwährung raus.
function domestic(i) {
  const converted = [i.price, i.currentBidPrice].some((p) => p?.convertedFromCurrency && p.convertedFromCurrency !== "EUR");
  const market = i.listingMarketplaceId;
  return !converted && (!market || market === "EBAY_DE")
    && (!i.itemLocation?.country || i.itemLocation.country === "DE");
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
    alsoBuyItNow: auction && (item.buyingOptions?.includes("FIXED_PRICE") ?? false),
    bids: auction ? item.bidCount ?? 0 : null,
    endsAt: item.itemEndDate ?? null,
    total: Math.round(total * 100) / 100,
    shipping: Number.isFinite(num(item.shippingOptions?.[0]?.shippingCost)) ? num(item.shippingOptions[0].shippingCost) : null,
    reference: Number.isFinite(reference) ? Math.round(reference * 100) / 100 : null,
    discount: Number.isFinite(reference) && reference > 0 ? Math.round((1 - total / reference) * 100) : null,
    location: item.itemLocation?.country ?? null,
    seller: item.seller ? { name: item.seller.username, score: item.seller.feedbackScore ?? null, positive: item.seller.feedbackPercentage ?? null } : null,
    search: s.label,
  };
}

function remember(items, s) {
  for (const i of items) {
    const auction = i.buyingOptions?.includes("AUCTION") ?? false;
    const prev = history.listings[i.itemId];
    const price = Math.round(totalPrice(i) * 100) / 100;
    // Preissenkungen bei Sofortkäufen mitzählen (bei Auktionen steigt der Preis durch Gebote).
    const dropped = !auction && prev && !prev.auction && price < prev.price - 0.5;
    history.listings[i.itemId] = {
      model: s.label,
      title: i.title,
      auction,
      price,
      firstPrice: prev?.firstPrice ?? prev?.price ?? price,
      drops: (prev?.drops ?? 0) + (dropped ? 1 : 0),
      lastDrop: dropped ? now : prev?.lastDrop ?? null,
      created: i.itemCreationDate ?? prev?.created ?? null,
      bids: auction ? i.bidCount ?? 0 : null,
      endsAt: i.itemEndDate ?? null,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
    };
  }
}

function recordSale(id, l, kind, price = l.price) {
  history.sold.push({ id, model: l.model, price, at: Math.min(now, l.endsAt ? Date.parse(l.endsAt) : now), kind });
  l.done = true;
}

// Endpreis einer beendeten Auktion abfragen. Nur echte Endpreise zählen als Verkauf.
// Jede beendete Auktion für die Liste in der Preisstatistik festhalten, verkauft oder nicht.
function recordEnded(id, l, result, price, bids, item) {
  history.ended.push({
    id, model: l.model, title: item?.title ?? l.title ?? null,
    url: item?.itemWebUrl ?? `https://www.ebay.de/itm/${String(id).split("|")[1] ?? id}`,
    price, bids, at: l.endsAt ? Date.parse(l.endsAt) : now, result,
  });
}

async function settleAuction(token, id, l) {
  auctionChecksLeft--;
  const r = await getItem(token, id).catch(() => null);
  if (!r) return; // später erneut versuchen
  if (r.gone) {
    stats.auctionUnavailable++;
    l.done = true;
    l.lastBidOnly = true; // Endpreis unbekannt, nur letztes gesehenes Gebot vorhanden
    recordEnded(id, l, "unknown", l.price, l.bids, null);
    return;
  }
  const item = r.item;
  // Sicherheitsnetz für ältere Historieneinträge ohne Modellprüfung
  const search = config.searches.find((x) => x.label === l.model);
  if (item.title && search && (!modelPattern(search).test(item.title.toLowerCase()) || !domestic(item))) {
    l.done = true;
    return;
  }
  const bids = item.bidCount ?? 0;
  const reserveMissed = item.reservePriceMet === false;
  const ship = num(item.shippingOptions?.[0]?.shippingCost);
  const final = num(item.currentBidPrice ?? item.price) + (Number.isFinite(ship) ? ship : 0);
  const price = Number.isFinite(final) ? Math.round(final * 100) / 100 : null;
  if (bids > 0 && !reserveMissed && price != null) {
    recordSale(id, l, "auction", price);
    l.bids = bids;
    stats.auctionFinal++;
    recordEnded(id, l, "sold", price, bids, item);
  } else {
    stats.auctionUnsold++;
    l.done = true;
    recordEnded(id, l, reserveMissed ? "reserve" : "nobids", price, bids, item);
  }
}

// Beendete Auktionen und verschwundene Sofort-Kaufen-Angebote als Verkauf erfassen.
async function settle(token, s, seenIds) {
  for (const [id, l] of Object.entries(history.listings)) {
    if (l.model !== s.label || l.done || seenIds.has(id)) continue;
    if (l.auction) {
      const end = l.endsAt ? Date.parse(l.endsAt) : NaN;
      // Ein paar Minuten Puffer, bis eBay die Auktion abgeschlossen hat.
      if (end < now - 5 * 60e3 && auctionChecksLeft > 0) await settleAuction(token, id, l);
    } else if (l.lastSeen < now - HOUR / 2 && checksLeft > 0) {
      checksLeft--;
      const ended = await hasEnded(token, id).catch(() => null);
      if (ended === true) { recordSale(id, l, "vanished"); stats.vanishedSold++; }
      else if (ended === false) l.done = true; // nur aus der Trefferliste gerutscht
    }
  }
}

function soldStats(label) {
  const prices = history.sold.filter((x) => x.model === label && x.at > now - SOLD_WINDOW).map((x) => x.price);
  return {
    soldMedian: median(prices), soldCount: prices.length,
    soldMin: quantile(prices, 0), soldP25: quantile(prices, 0.25), soldP75: quantile(prices, 0.75), soldMax: quantile(prices, 1),
    soldAvg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : NaN,
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);

// Nachfrage: Verkäufe der letzten 7 Tage und Anteil verkaufter Auktionen (30 Tage).
// observedDays sagt, wie lange schon beobachtet wird – am Anfang ist die Woche noch unvollständig.
function demand(label) {
  const snaps = history.snapshots[label] ?? [];
  const observedDays = snaps.length ? (now - snaps[0][0]) / DAY : 0;
  const week = history.sold.filter((x) => x.model === label && x.at > now - 7 * DAY).length;
  const ended = history.ended.filter((x) => x.model === label && x.at > now - SOLD_WINDOW && x.result !== "unknown");
  const sold = ended.filter((x) => x.result === "sold").length;
  return { salesWeek: week, auctionsEnded: ended.length, auctionsSold: sold, observedDays: Math.round(observedDays * 10) / 10 };
}

// Trend des günstigsten verfügbaren Sofortkaufs: jetzt gegenüber vor 7 Tagen (bzw. Beobachtungsbeginn).
function trend(label, current) {
  const snaps = (history.snapshots[label] ?? []).filter((x) => x[3] != null);
  if (!snaps.length || !Number.isFinite(current)) return null;
  const target = now - 7 * DAY;
  const past = snaps.reduce((a, b) => Math.abs(b[0] - target) < Math.abs(a[0] - target) ? b : a);
  if (now - past[0] < 6 * HOUR) return null; // zu kurz beobachtet
  return { from: past[3], to: round(current), days: Math.round((now - past[0]) / DAY * 10) / 10 };
}

async function dealsFor(token, s) {
  const terms = [...(config.exclude ?? []), ...(s.exclude ?? [])];
  // Defekte Karten doppelt ausschließen: per Zustandsfilter in der Suche und hier per Zustand 7000
  // ("Als Ersatzteil / defekt") sowie per Ausschlusswörtern im Titel.
  // Nur Artikel, die laut eBay in Deutschland liegen – kein Zoll, keine Einfuhrumsatzsteuer.
  const model = modelPattern(s);
  const keep = (items) => items.filter((i) => i.conditionId !== "7000" && domestic(i) && trusted(i)
    && model.test((i.title ?? "").toLowerCase()) && !excluded(i.title ?? "", terms));
  // Auktionen mit Sofort-Kaufen-Option kommen auch bei buyingOptions:{FIXED_PRICE}, ihr Preis ist aber
  // das Gebot, nicht der Sofort-Kaufen-Preis. Für Angebotspreise daher nur reine Sofortkäufe.
  const binOnly = (items) => items.filter((i) => !i.buyingOptions?.includes("AUCTION"));
  const where = `priceCurrency:${config.currency},itemLocationCountry:DE`
    + (config.conditionIds ? `,conditionIds:{${config.conditionIds}}` : "");

  // Angebotspreis: Median der relevantesten Sofort-Kaufen-Angebote (ohne Zubehör, Defekte usw.).
  // Auktionen ohne Preisgrenze holen, damit auch teuer endende Auktionen in die Historie kommen.
  const [refItems, ending] = await Promise.all([
    search(token, { q: s.query, filter: `${where},buyingOptions:{FIXED_PRICE}`, limit: "200" }).then(keep).then(binOnly),
    search(token, { q: s.query, filter: `${where},buyingOptions:{AUCTION}`, sort: "endingSoonest", limit: "50" }).then(keep),
  ]);
  remember([...refItems, ...ending], s);
  await settle(token, s, new Set([...refItems, ...ending].map((i) => i.itemId)));

  // Neue und gebrauchte Karten getrennt bewerten: Händler-Neuware würde sonst den Preis alter
  // Gebrauchtkarten hochziehen, und neue Generationen gibt es gebraucht noch kaum.
  const isNew = (i) => NEW_CONDITIONS.has(i.conditionId);
  const priceStats = (items) => {
    const m = median(items.map(totalPrice));
    const v = items.map(totalPrice).filter((x) => x >= m * (config.floorRatio ?? 0));
    return { count: items.length, median: m, p25: quantile(v, 0.25), min: quantile(v, 0), max: quantile(v, 1), avg: v.reduce((a, b) => a + b, 0) / v.length };
  };
  const all = priceStats(refItems), used = priceStats(refItems.filter((i) => !isNew(i))), fresh = priceStats(refItems.filter(isNew));
  const askMedian = all.median;
  const sold = soldStats(s.label);
  const { soldMedian, soldCount } = sold;
  const useSold = soldCount >= MIN_SOLD;
  // Referenz je Zustand: Verkaufspreis, sonst Angebotsmedian der eigenen Gruppe, sonst aller Angebote.
  // Angebotsreferenz ist das günstigste Viertel (25-%-Quantil): überteuerte Händlerangebote, die nie
  // verkauft werden, verzerren sonst den Wert. Angebotspreise liegen ohnehin über den Verkaufspreisen.
  const askRef = (group) => group.count >= MIN_ASK ? group.p25 : all.count >= MIN_ASK ? all.p25 : NaN;
  const refFor = (i) => useSold ? soldMedian : askRef(isNew(i) ? fresh : used);
  const market = {
    label: s.label, basis: useSold ? "sold" : "ask",
    askCount: all.count, askMedian: round(all.median), askP25: round(all.p25), askMin: round(all.min), askMax: round(all.max), askAvg: round(all.avg),
    usedCount: used.count, usedMedian: round(used.median), newCount: fresh.count, newMedian: round(fresh.median),
    soldCount, soldMedian: round(soldMedian), soldAvg: round(sold.soldAvg),
    soldMin: round(sold.soldMin), soldP25: round(sold.soldP25), soldP75: round(sold.soldP75), soldMax: round(sold.soldMax),
  };

  let deals = [], cheapest = [];
  const refs = [useSold ? soldMedian : NaN, askRef(used), askRef(fresh)].filter(Number.isFinite);
  // Ohne verlässliche Referenz lässt sich kein Schnäppchen erkennen.
  if (refs.length) {
    // Kandidaten breit holen, bewertet wird jedes Angebot gegen die Referenz seines Zustands.
    const floor = Math.min(...refs) * (config.floorRatio ?? 0);
    const cap = s.maxPrice ?? Math.max(...refs) * config.dealThreshold;
    cheapest = binOnly(keep(await search(token, {
      q: s.query, filter: `price:[${Math.floor(floor)}..${Math.ceil(cap)}],${where},buyingOptions:{FIXED_PRICE}`, sort: "price", limit: "50",
    })));
    remember(cheapest, s);
    const seen = new Set();
    deals = [...cheapest, ...ending]
      .filter((i) => !seen.has(i.itemId) && seen.add(i.itemId))
      .map((i) => ({ i, ref: refFor(i) }))
      .filter(({ ref }) => Number.isFinite(ref))
      .map(({ i, ref }) => {
        const h = history.listings[i.itemId];
        return {
          ...toDeal(i, s, ref), basis: market.basis, isNew: isNew(i),
          // Preissenkungen und Alter des Angebots (aus eigener Beobachtung bzw. eBay-Einstelldatum)
          priceHistory: h && h.drops ? { first: h.firstPrice, drops: h.drops, lastDrop: h.lastDrop } : null,
          listedSince: i.itemCreationDate ?? h?.created ?? null, firstSeen: h?.firstSeen ?? now,
        };
      })
      .filter((d) => Number.isFinite(d.total) && d.total >= d.reference * (config.floorRatio ?? 0)
        && d.total <= (s.maxPrice ?? d.reference * config.dealThreshold))
      .sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0))
      .slice(0, config.maxItemsPerSearch);
  }

  // Günstigster plausibler Sofortkauf (ohne Ausreißer unter der Preisuntergrenze), neu oder gebraucht.
  const bin = [...refItems, ...cheapest]
    .map((i) => ({ id: i.itemId, price: totalPrice(i), url: i.itemAffiliateWebUrl ?? i.itemWebUrl, title: i.title, isNew: isNew(i) }))
    .filter((x) => x.price >= askMedian * (config.floorRatio ?? 0))
    .sort((a, b) => a.price - b.price)[0];
  if (bin) market.cheapestBin = { price: Math.round(bin.price * 100) / 100, url: bin.url, title: bin.title, isNew: bin.isNew };
  Object.assign(market, demand(s.label), { trend: trend(s.label, bin?.price) });

  // Verlauf: Median, Anzahl, günstigstes verfügbares Angebot (aus der preissortierten Suche) und Viertel.
  if (Number.isFinite(askMedian)) {
    (history.snapshots[s.label] ??= []).push([now, round(askMedian), refItems.length, bin ? round(bin.price) : null, round(all.p25)]);
  }
  // Protokoll des günstigsten Angebots: gleiches Angebot verlängert den Zeitraum, ein neues beginnt einen.
  if (bin) {
    const log = (history.cheapest[s.label] ??= []);
    const last = log.at(-1);
    if (last && last.id === bin.id) Object.assign(last, { to: now, price: round(bin.price) });
    else log.push({ id: bin.id, title: bin.title, url: bin.url, isNew: bin.isNew, price: round(bin.price), from: now, to: now });
  }
  console.log(`  ${s.label}: Angebote ${round(askMedian)} € (${refItems.length}), verkauft ${round(soldMedian) ?? "–"} € (${soldCount}), ${deals.length} Treffer`);
  return { deals, market };
}

// Alte Einträge entfernen, damit die Historie nicht endlos wächst.
function prune() {
  for (const [id, l] of Object.entries(history.listings)) {
    if (l.lastSeen < now - 14 * DAY) delete history.listings[id];
  }
  const ids = new Set();
  history.sold = history.sold.filter((x) => x.at > now - 90 * DAY && !ids.has(x.id) && ids.add(x.id));
  history.ended = history.ended.filter((x) => x.at > now - 90 * DAY);
  for (const label of Object.keys(history.cheapest)) {
    history.cheapest[label] = history.cheapest[label].filter((x) => x.to > now - 90 * DAY);
  }
  for (const label of Object.keys(history.snapshots)) {
    history.snapshots[label] = history.snapshots[label].filter(([t]) => t > now - 90 * DAY);
  }
}

// Statistik je Modell für die Seite: Angebotspreis-Verlauf (ältere Tage zu Tageswerten
// verdichtet), einzelne Verkäufe und Quantile der Verkaufspreise der letzten 30 Tage.
function buildStats() {
  return config.searches.map((s) => {
    const buckets = new Map();
    for (const [t, ask, count, min, p25] of history.snapshots[s.label] ?? []) {
      const key = t < now - 3 * DAY ? Math.floor(t / DAY) * DAY + DAY / 2 : Math.floor(t / HOUR) * HOUR;
      const b = buckets.get(key) ?? { ask: [], count: [], min: [], p25: [] };
      b.ask.push(ask); b.count.push(count);
      if (Number.isFinite(p25)) b.p25.push(p25);
      if (min >= ask * (config.floorRatio ?? 0)) b.min.push(min); // ältere Ausreißer ignorieren
      buckets.set(key, b);
    }
    const series = [...buckets].sort((a, b) => a[0] - b[0])
      .map(([t, b]) => [t, round(median(b.ask)), round(median(b.count)), b.min.length ? Math.min(...b.min) : null, round(median(b.p25))]);
    const sales = history.sold.filter((x) => x.model === s.label)
      .map((x) => ({ t: x.at, price: x.price, kind: x.kind, id: x.id }))
      .sort((a, b) => b.t - a.t);
    const recent = sales.filter((x) => x.t > now - SOLD_WINDOW).map((x) => x.price);
    const q = (p) => round(quantile(recent, p));
    const cheapestLog = (history.cheapest[s.label] ?? []).slice(-20).reverse();
    const ended = history.ended.filter((x) => x.model === s.label).sort((a, b) => b.at - a.at).slice(0, 40);
    const ended30 = history.ended.filter((x) => x.model === s.label && x.at > now - SOLD_WINDOW);
    return {
      label: s.label,
      cheapestLog,
      ended,
      auctions: { ended: ended30.length, sold: ended30.filter((x) => x.result === "sold").length },
      sold: { n: recent.length, min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), max: q(1) },
      series,
      sales,
    };
  });
}

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
const result = {
  updatedAt: new Date().toISOString(), dealThreshold: config.dealThreshold, resale: config.resale, searches: config.searches, markets: [], deals: [], errors: [],
};

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  result.errors.push("Keine eBay-API-Keys hinterlegt (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET).");
} else {
  const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
  for (const s of config.searches) {
    try {
      const { deals, market } = await dealsFor(token, s);
      result.deals.push(...deals);
      result.markets.push(market);
    } catch (e) {
      result.errors.push(e.message);
    }
  }
  prune();
  console.log(`Auktionen: ${stats.auctionFinal} mit Endpreis, ${stats.auctionUnsold} ohne Verkauf, `
    + `${stats.auctionUnavailable} nicht mehr abrufbar. Sofort-Kaufen: ${stats.vanishedSold} vermutlich verkauft.`);
  result.stats = stats;
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
if (EBAY_CLIENT_ID && EBAY_CLIENT_SECRET) await writeFile(historyFile, JSON.stringify(history));
await writeFile(statsFile, JSON.stringify({ updatedAt: result.updatedAt, models: buildStats() }));
await writeFile(outFile, JSON.stringify(result, null, 2));
console.log(`${result.deals.length} Angebote gespeichert, ${result.errors.length} Fehler.`);
for (const e of result.errors) console.warn("  " + e);
