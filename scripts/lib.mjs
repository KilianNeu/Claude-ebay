// Gemeinsame Bausteine für den stündlichen Lauf (fetch-deals.mjs) und den Schnellcheck (quick-check.mjs):
// eBay-Zugriff, Preisberechnung und die Filter, damit beide dieselben Angebote gelten lassen.

import { readFile } from "node:fs/promises";

export const API = "https://api.ebay.com";
export const config = JSON.parse(await readFile(new URL("../searches.json", import.meta.url), "utf8"));

export async function getToken(id, secret) {
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

export const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "X-EBAY-C-MARKETPLACE-ID": config.marketplace,
  "Accept-Language": "de-DE",
});

export async function search(token, params) {
  if (config.categoryIds) params = { category_ids: config.categoryIds, ...params };
  const url = `${API}/buy/browse/v1/item_summary/search?` + new URLSearchParams(params);
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`Suche fehlgeschlagen (${params.q}): ${res.status} ${await res.text()}`);
  return (await res.json()).itemSummaries ?? [];
}

// { gone: true } = nicht mehr abrufbar, { item } = Angebotsdaten, null = Fehler.
export async function getItem(token, itemId) {
  const res = await fetch(`${API}/buy/browse/v1/item/${encodeURIComponent(itemId)}`, { headers: headers(token) });
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (!res.ok) return null;
  return { item: await res.json() };
}

export const num = (p) => (p ? Number(p.value) : NaN);

// Preis inkl. Versand; bei Auktionen das aktuelle Gebot.
export function totalPrice(item) {
  const base = item.buyingOptions?.includes("AUCTION") && item.currentBidPrice
    ? num(item.currentBidPrice)
    : num(item.price);
  const ship = num(item.shippingOptions?.[0]?.shippingCost);
  return base + (Number.isFinite(ship) ? ship : 0);
}

// Ausschlusswörter als ganze Wörter prüfen, damit "ti" nicht in "Edition" greift. Wortteile
// (excludeParts) greifen überall, auch in Zusammensetzungen wie "Lüfter+Kühlkörper".
// Liefert das gefundene Ausschlusswort (für die Begründung) oder undefined.
export function excluded(title, terms) {
  const t = title.toLowerCase();
  return (config.excludeParts ?? []).find((part) => t.includes(part))
    ?? terms.find((term) => new RegExp(`(^|[^a-z0-9äöü])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9äöü]|$)`).test(t));
}

export function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q, lo = Math.floor(pos);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
}

export const median = (values) => quantile(values, 0.5);

// eBays Suche ist unscharf: "rtx 4080" liefert auch "RTX 2080". Deshalb muss die Modellnummer samt
// Zusatz (Ti, Super, XT) im Titel stehen, z. B. "4070 Ti" oder "4070Ti". "rtx"/"rx" und Speichergrößen
// sind optional.
export function modelPattern(s) {
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
// Passt ein gespeicherter Eintrag (Titel, Preis) nach den heutigen Regeln noch zum Modell? Ältere Einträge
// stammen teils aus der Zeit vor strengeren Filtern (Modelleisenbahnen "4080", Komplett-PCs …).
// Ohne Titel lässt sich nichts prüfen – dann bleibt der Eintrag.
// Den Mindestpreis nur bei Endpreisen bzw. Sofortkäufen prüfen (price weglassen bei laufenden Auktionen).
export function stillMatches(label, title, price) {
  const s = config.searches.find((x) => x.label === label);
  if (!s) return false;
  if (!title) return true;
  const t = title.toLowerCase();
  return modelPattern(s).test(t) && !excluded(t, [...(config.exclude ?? []), ...(s.exclude ?? [])]) && !(price < (s.minPrice ?? 0));
}

export function trusted(i) {
  const score = Number(i.seller?.feedbackScore), positive = Number(i.seller?.feedbackPercentage);
  if (Number.isFinite(score) && score < (config.minSellerFeedback ?? 0)) return false;
  // eBay liefert bei manchen Verkäufern 0.0 % trotz vieler Bewertungen; das gilt als unbekannt.
  if (Number.isFinite(positive) && positive > 0 && positive < (config.minSellerPositive ?? 0)) return false;
  return true;
}

// Nur Angebote vom deutschen eBay in Euro. UK-Angebote (ebay.co.uk, Preis in £) tragen teils einen
// deutschen Standort und kämen sonst durch; hier fallen sie über Marktplatz und Originalwährung raus.
export function domestic(i) {
  const converted = [i.price, i.currentBidPrice].some((p) => p?.convertedFromCurrency && p.convertedFromCurrency !== "EUR");
  const market = i.listingMarketplaceId;
  return !converted && (!market || market === "EBAY_DE")
    && (!i.itemLocation?.country || i.itemLocation.country === "DE");
}

// Suchwörter ohne "rtx"/"rx"/"gtx": eBay verlangt jedes Suchwort im Titel, und Titel wie
// "4070 ti Gigabyte Aero" fehlen sonst. Die Kategorie Grafikkarten hält fremde Artikel mit derselben
// Nummer (Lego 5090, Aufkleber 5080 …) fern; ob es wirklich das Modell ist, prüft modelPattern.
export const searchQuery = (s) => s.query.replace(/^(rtx|rx|gtx)\s+/i, "");

// Grund, warum ein Angebot für ein Modell nicht zählt (oder null): Defekt, Zubehör unter dem
// Mindestpreis, Ausland/Fremdwährung, unseriöser Verkäufer, falsches Modell oder Ausschlusswort.
export function rejectReason(i, s, model = modelPattern(s), terms = [...(config.exclude ?? []), ...(s.exclude ?? [])]) {
  if (i.conditionId === "7000") return "Zustand: als Ersatzteil / defekt";
  if (s.minPrice && totalPrice(i) < s.minPrice && !i.buyingOptions?.includes("AUCTION")) return `unter Mindestpreis ${s.minPrice} € (Zubehör?)`;
  if (!domestic(i)) return "nicht auf ebay.de in Euro oder Standort nicht Deutschland";
  if (!trusted(i)) return `Verkäufer: ${i.seller?.feedbackScore ?? "?"} Bewertungen, ${i.seller?.feedbackPercentage ?? "?"} % positiv`;
  if (!model.test((i.title ?? "").toLowerCase())) return s.memory ? "Modell bzw. Speichergröße nicht eindeutig im Titel" : "Modellnummer nicht im Titel";
  const term = excluded(i.title ?? "", terms);
  return term ? `Ausschlusswort „${term}“` : null;
}
