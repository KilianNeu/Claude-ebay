// Holt günstige Angebote über die eBay Browse API und schreibt data/deals.json.
// Benötigt EBAY_CLIENT_ID und EBAY_CLIENT_SECRET (Production-Keyset von developer.ebay.com).
// Ohne Keys wird eine leere Datei mit Hinweis geschrieben, damit die Seite trotzdem baut.
//
// Verkaufspreise liefert die öffentliche API nicht. Deshalb führt das Skript eine eigene
// Historie (HISTORY_FILE): Beendete Auktionen werden per getItem nach ihrem Endpreis gefragt,
// verschwundene Sofort-Kaufen-Angebote ebenso geprüft. Daraus entsteht ein geschätzter Verkaufspreis.
// Das zuletzt gesehene Gebot zählt nicht, weil Auktionen in den letzten Minuten stark steigen.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  config, getToken, search, getItem, num, totalPrice, excluded, quantile, median,
  modelPattern, trusted, domestic, searchQuery, rejectReason, stillMatches,
} from "./lib.mjs";
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
const HISTORY_VERSION = 3;
if ((history.version ?? 0) < 2) history.sold = [];
// Version 3: Verlauf und Protokoll des günstigsten Sofortkaufs enthielten noch Startgebote von Auktionen
// mit Sofort-Kaufen-Option und Angebote vor der Filterkorrektur; Verkäufe und Auktionen bleiben erhalten.
if ((history.version ?? 0) < 3) { history.snapshots = {}; history.cheapest = {}; }
history.version = HISTORY_VERSION;
// Bei jedem Lauf: Einträge, die nach den heutigen Regeln nicht mehr zum Modell passen, entfernen
// (z. B. Modelleisenbahn "Märklin 4080" als Verkauf der RTX 4080), damit sie den Verkaufs-Median nicht verfälschen.
{
  const titleOf = (id) => history.listings?.[id]?.title;
  const before = (history.sold?.length ?? 0) + (history.ended?.length ?? 0);
  history.sold = (history.sold ?? []).filter((x) => stillMatches(x.model, titleOf(x.id), x.price));
  history.ended = (history.ended ?? []).filter((x) => stillMatches(x.model, x.title ?? titleOf(x.id), x.price));
  for (const [id, l] of Object.entries(history.listings ?? {})) if (!stillMatches(l.model, l.title, l.auction ? undefined : l.price)) delete history.listings[id];
  const removed = before - history.sold.length - history.ended.length;
  if (removed) console.log(`Historie bereinigt: ${removed} Verkäufe/Auktionen passten nicht mehr zu den Filtern.`);
}
let checksLeft = MAX_CHECKS, auctionChecksLeft = MAX_AUCTION_CHECKS, hybridChecksLeft = 30;
const stats = { auctionFinal: 0, auctionUnsold: 0, auctionUnavailable: 0, vanishedSold: 0 };

// true = Angebot beendet (verkauft oder zurückgezogen), false = noch aktiv, null = unklar.
async function hasEnded(token, itemId) {
  const r = await getItem(token, itemId);
  if (!r) return null;
  if (r.gone) return true;
  const status = r.item.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus;
  return (r.item.itemEndDate && new Date(r.item.itemEndDate) < now) || status === "OUT_OF_STOCK";
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
// Als Vergleichswert dient der Median der Messungen in einem 6-Stunden-Fenster, damit ein einzelner
// Ausreißer den Trend nicht bestimmt.
function trend(label, current) {
  const snaps = (history.snapshots[label] ?? []).filter((x) => x[3] != null);
  if (!snaps.length || !Number.isFinite(current)) return null;
  const start = Math.max(now - 7 * DAY, snaps[0][0]);
  const window = snaps.filter((x) => x[0] >= start && x[0] < start + 6 * HOUR);
  if (now - start < 12 * HOUR || window.length < 3) return null; // zu kurz beobachtet
  return { from: round(median(window.map((x) => x[3]))), to: round(current), days: Math.round((now - start) / DAY * 10) / 10 };
}

// Sofort-Kaufen-Preis von Auktionen mit Sofort-Kaufen-Option: Die Suche liefert nur das Gebot, daher
// einzeln abfragen (zwischengespeichert für 6 Stunden). Liefert den Gesamtpreis inkl. Versand oder null.
async function hybridBinPrice(token, i) {
  const h = history.listings[i.itemId];
  if (h?.binCheckedAt > now - 6 * HOUR) return h.binTotal ?? null;
  if (hybridChecksLeft <= 0) return null;
  hybridChecksLeft--;
  const r = await getItem(token, i.itemId).catch(() => null);
  if (!r?.item) return null;
  const it = r.item, ship = num(it.shippingOptions?.[0]?.shippingCost);
  const bid = num(it.currentBidPrice), price = num(it.price);
  // Nur wenn sich der Preis vom Gebot unterscheidet, ist er der Sofort-Kaufen-Preis.
  const total = Number.isFinite(price) && (!Number.isFinite(bid) || price > bid) ? price + (Number.isFinite(ship) ? ship : 0) : null;
  console.log(`    Auktion mit Sofort-Kaufen: Gebot ${bid}, price ${price}, Versand ${ship} → ${total ?? "kein Sofort-Kaufen-Preis"} – ${i.title}`);
  if (h) Object.assign(h, { binCheckedAt: now, binTotal: total });
  return total;
}


async function dealsFor(token, s) {
  const terms = [...(config.exclude ?? []), ...(s.exclude ?? [])];
  // Defekte Karten doppelt ausschließen: per Zustandsfilter in der Suche und hier per Zustand 7000
  // ("Als Ersatzteil / defekt") sowie per Ausschlusswörtern im Titel.
  // Nur Artikel, die laut eBay in Deutschland liegen – kein Zoll, keine Einfuhrumsatzsteuer.
  const model = modelPattern(s);
  // Grund, warum ein Angebot verworfen wird (oder null). Verworfene Sofortkäufe werden gesammelt,
  // damit auf der Seite nachvollziehbar ist, warum ein günstiges Angebot fehlt.
  const reason = (i) => rejectReason(i, s, model, terms);
  const rejected = new Map();
  const keep = (items) => items.filter((i) => {
    const r = reason(i);
    // Nur echte Karten auflisten: Zubehör unter dem Mindestpreis ist uninteressant.
    if (r && !i.buyingOptions?.includes("AUCTION") && totalPrice(i) >= (s.minPrice ?? 0)) {
      rejected.set(i.itemId, { price: Math.round(totalPrice(i) * 100) / 100, title: i.title, url: i.itemWebUrl, reason: r });
    }
    return !r;
  });
  // Auktionen mit Sofort-Kaufen-Option kommen auch bei buyingOptions:{FIXED_PRICE}, ihr Preis ist aber
  // das Gebot, nicht der Sofort-Kaufen-Preis. Für Angebotspreise daher nur reine Sofortkäufe.
  const binOnly = (items) => items.filter((i) => !i.buyingOptions?.includes("AUCTION"));
  const where = `priceCurrency:${config.currency},itemLocationCountry:DE`
    + (config.conditionIds ? `,conditionIds:{${config.conditionIds}}` : "");

  // Angebotspreis: Median der relevantesten Sofort-Kaufen-Angebote (ohne Zubehör, Defekte usw.).
  // Auktionen ohne Preisgrenze holen, damit auch teuer endende Auktionen in die Historie kommen.
  const [fixed, ending] = await Promise.all([
    search(token, { q: searchQuery(s), filter: `${where},buyingOptions:{FIXED_PRICE}`, limit: "200" }).then(keep),
    search(token, { q: searchQuery(s), filter: `${where},buyingOptions:{AUCTION}`, sort: "endingSoonest", limit: "50" }).then(keep),
  ]);
  const refItems = binOnly(fixed);
  // Auktionen mit Sofort-Kaufen-Option aus beiden Suchen (ihr Sofort-Kaufen-Preis wird einzeln abgefragt)
  const hybridItems = [...new Map([...fixed, ...ending]
    .filter((i) => i.buyingOptions?.includes("AUCTION") && i.buyingOptions?.includes("FIXED_PRICE"))
    .map((i) => [i.itemId, i])).values()];
  remember([...refItems, ...ending, ...hybridItems], s);
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
      q: searchQuery(s), filter: `price:[${Math.floor(floor)}..${Math.ceil(cap)}],${where},buyingOptions:{FIXED_PRICE}`, sort: "price", limit: "50",
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
  // Auktionen mit Sofort-Kaufen-Option zählen mit ihrem echten Sofort-Kaufen-Preis.
  const hybrids = [];
  for (const i of hybridItems) {
    const total = await hybridBinPrice(token, i);
    if (total != null && total >= (s.minPrice ?? 0)) hybrids.push({ id: i.itemId, price: total, url: i.itemAffiliateWebUrl ?? i.itemWebUrl, title: i.title, isNew: isNew(i) });
  }
  const bins = [...refItems, ...cheapest]
    .map((i) => ({ id: i.itemId, price: totalPrice(i), url: i.itemAffiliateWebUrl ?? i.itemWebUrl, title: i.title, isNew: isNew(i) }))
    .concat(hybrids)
    .filter((x) => x.price >= askMedian * (config.floorRatio ?? 0))
    .sort((a, b) => a.price - b.price)
    .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i);
  const bin = bins[0];
  // Zweitgünstigster Sofortkauf: Verkaufspreis für die Gewinnrechnung, wenn das Angebot selbst das günstigste ist.
  if (bins[1]) market.nextBin = { price: Math.round(bins[1].price * 100) / 100, url: bins[1].url };
  if (bin) market.cheapestBin = { id: bin.id, price: Math.round(bin.price * 100) / 100, url: bin.url, title: bin.title, isNew: bin.isNew };
  Object.assign(market, demand(s.label), { trend: trend(s.label, bin?.price) });
  // Die günstigsten verworfenen Sofortkäufe, soweit günstiger als der günstigste angezeigte.
  market.rejected = [...rejected.values()].filter((x) => !bin || x.price < bin.price)
    .sort((a, b) => a.price - b.price).slice(0, 8);
  for (const x of market.rejected.slice(0, 3)) console.log(`    verworfen: ${x.price} € – ${x.reason} – ${x.title}`);

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
if (EBAY_CLIENT_ID && EBAY_CLIENT_SECRET) {
  await writeFile(historyFile, JSON.stringify(history));
  // Marktwerte für den Schnellcheck: günstigster und zweitgünstigster Sofortkauf je Modell.
  const markets = Object.fromEntries(result.markets.map((m) => [m.label, {
    cheapestBin: m.cheapestBin ? { id: m.cheapestBin.id, price: m.cheapestBin.price } : null,
    nextBin: m.nextBin ? { price: m.nextBin.price } : null,
  }]));
  await writeFile(new URL("markets.json", historyFile instanceof URL ? historyFile : pathToFileURL(resolve(historyFile))), JSON.stringify({ updatedAt: result.updatedAt, markets }));
}
await writeFile(statsFile, JSON.stringify({ updatedAt: result.updatedAt, models: buildStats() }));
await writeFile(outFile, JSON.stringify(result, null, 2));
console.log(`${result.deals.length} Angebote gespeichert, ${result.errors.length} Fehler.`);
for (const e of result.errors) console.warn("  " + e);
