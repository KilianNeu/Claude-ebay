// Alle gesammelten Daten als Tabellen für den Reiter "Tabellen" (data/tables.json).
// Liest die Historie aus dem Branch data (HISTORY_DIR) und die Ausgaben dieses Laufs (data/*.json).
// Zeilen sind Arrays in Spaltenreihenfolge; Link-Spalten enthalten [Text, URL].

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stillMatches } from "./lib.mjs";

const dir = process.env.HISTORY_DIR ?? "data";
const read = (path) => readFile(path, "utf8").then(JSON.parse).catch(() => null);
const now = Date.now();
const itemUrl = (id) => `https://www.ebay.de/itm/${String(id).split("|")[1] ?? id}`;
const time = (v) => (v == null ? null : typeof v === "number" ? v : Date.parse(v) || null);
const RESULT = { sold: "verkauft", nobids: "keine Gebote", reserve: "Mindestpreis nicht erreicht", unknown: "Endpreis unbekannt" };
const yesNo = (v) => (v == null ? null : v ? "ja" : "nein");

// Spalten: [Schlüssel, Überschrift, Typ] – Typen: date, eur, num, pct, text, link
const table = (id, label, columns, rows, note) => ({ id, label, note, columns: columns.map(([k, l, t]) => ({ k, l, t })), rows });
const categories = [];

// ---- Grafikkarten ----
const gpu = await read(join(dir, "history.json"));
if (gpu) {
  const L = gpu.listings ?? {};
  const current = stillMatches;

  categories.push({ id: "gpu", label: "Grafikkarten", tables: [
    table("ended", "Beendete Auktionen", [
      ["at", "Ende", "date"], ["model", "Modell", "text"], ["title", "Angebot", "link"], ["price", "Endpreis inkl. Versand", "eur"],
      ["bids", "Gebote", "num"], ["result", "Ergebnis", "text"], ["first", "Erstes gesehenes Gebot", "eur"], ["created", "Eingestellt", "date"],
    ], (gpu.ended ?? []).filter((x) => current(x.model, x.title ?? L[x.id]?.title, x.price)).map((x) => {
      const l = L[x.id] ?? {};
      return [x.at, x.model, [x.title ?? l.title ?? "ansehen", x.url ?? itemUrl(x.id)], x.price, x.bids ?? null, RESULT[x.result] ?? x.result,
        l.firstPrice ?? null, time(l.created)];
    }), "Endpreise per eBay-Abfrage nach Auktionsende (90 Tage)."),
    table("sold", "Verkäufe", [
      ["at", "Datum", "date"], ["model", "Modell", "text"], ["kind", "Art", "text"], ["price", "Preis inkl. Versand", "eur"], ["title", "Angebot", "link"],
    ], (gpu.sold ?? []).filter((x) => current(x.model, L[x.id]?.title, x.price)).map((x) => [x.at, x.model, x.kind === "auction" ? "Auktion" : "Sofort-Kaufen (vermutlich verkauft)", x.price,
      [L[x.id]?.title ?? "ansehen", itemUrl(x.id)]]), "Auktionen mit Endpreis und verschwundene Sofort-Kaufen-Angebote (90 Tage)."),
    table("listings", "Beobachtete Angebote", [
      ["model", "Modell", "text"], ["title", "Angebot", "link"], ["format", "Format", "text"], ["price", "Letzter Preis", "eur"],
      ["first", "Erster Preis", "eur"], ["drops", "Preissenkungen", "num"], ["bids", "Gebote", "num"], ["created", "Eingestellt", "date"],
      ["firstSeen", "Zuerst gesehen", "date"], ["lastSeen", "Zuletzt gesehen", "date"], ["endsAt", "Ende", "date"], ["status", "Status", "text"],
    ], Object.entries(L).filter(([, l]) => current(l.model, l.title, l.auction ? undefined : l.price)).map(([id, l]) => [l.model, [l.title ?? "ansehen", itemUrl(id)], l.auction ? "Auktion" : "Sofort-Kaufen", l.price ?? null,
      l.firstPrice ?? null, l.drops ?? 0, l.auction ? l.bids ?? null : null, time(l.created), l.firstSeen ?? null, l.lastSeen ?? null, time(l.endsAt),
      l.done ? "beendet" : l.lastSeen > now - 2 * 3.6e6 ? "aktiv" : "nicht mehr gesehen"]),
      "Alle Angebote, die die Filter bestanden haben (bis 14 Tage nach dem letzten Sehen)."),
  ] });
}

// ---- Mini-PCs ----
const mph = await read(join(dir, "minipc-history.json"));
const mp = await read("data/minipc.json");
if (mph || mp) {
  const tables = [];
  if (mp?.offers) tables.push(table("offers", "Ausgewertete Angebote", [
    ["family", "Baureihe", "text"], ["title", "Angebot", "link"], ["cpu", "CPU", "text"], ["cpuSource", "CPU-Herkunft", "text"], ["ram", "RAM (GB)", "num"],
    ["ddr", "DDR", "text"], ["ssd", "SSD (GB)", "num"], ["barebone", "Barebone", "text"], ["format", "Format", "text"], ["price", "Preis inkl. Versand", "eur"],
    ["value", "Geschätzter Wert", "eur"], ["discount", "Unter Wert", "pct"], ["bids", "Gebote", "num"], ["endsAt", "Ende", "date"],
    ["condition", "Zustand", "text"], ["seller", "Verkäufer-Bewertungen", "num"],
  ], mp.offers.map((o) => [o.family, [o.title, o.url], o.cpu, o.cpuSource ?? "Titel/Merkmale", o.ram, o.ddr?.toUpperCase() ?? null, o.ssd, yesNo(o.barebone),
    o.auction ? "Auktion" : "Sofort-Kaufen", o.price, o.value, o.discount, o.bids, time(o.endsAt), o.condition, o.seller]),
    "Aktueller Lauf: alle Mini-PCs, die die Filter bestanden haben."));
  if (mph) tables.push(table("ended", "Beendete Auktionen", [
    ["at", "Ende", "date"], ["family", "Baureihe", "text"], ["title", "Angebot", "link"], ["cpu", "CPU", "text"], ["ram", "RAM (GB)", "num"],
    ["ssd", "SSD (GB)", "num"], ["price", "Endpreis inkl. Versand", "eur"], ["bids", "Gebote", "num"], ["result", "Ergebnis", "text"],
    ["value", "Geschätzter Wert", "eur"], ["ratio", "Endpreis / Schätzung", "pct"],
  ], (mph.ended ?? []).map((x) => [x.at, x.family, [x.title ?? "ansehen", x.url], x.cpu, x.ram, x.ssd, x.price, x.bids, RESULT[x.result] ?? x.result,
    x.value > 0 ? x.value : null, x.value > 0 && x.price != null && x.result === "sold" ? Math.round(x.price / x.value * 100) : null]),
    "Endpreise per eBay-Abfrage nach Auktionsende (30 Tage)."));
  if (mp?.models) tables.push(table("models", "Modellnamen → CPU", [
    ["model", "Modell", "text"], ["gen", "Generation (Tabelle)", "num"], ["cpus", "Beobachtete CPUs", "text"], ["observed", "Angebote mit CPU", "num"],
    ["ddr", "RAM-Typ (Tabelle)", "text"], ["ddrSeen", "Beobachtete RAM-Typen", "text"], ["viaModel", "Über Modell erkannt", "num"], ["tooOld", "Als zu alt aussortiert", "num"],
  ], mp.models.map((x) => [x.model, x.gen, x.cpus.map(([id, n]) => `${id} (${n})`).join(", "), x.observed, x.ddr?.toUpperCase() ?? null,
    (x.ddrSeen ?? []).map(([d, n]) => `${d.toUpperCase()} (${n})`).join(", "), x.viaModel, x.tooOld])));
  if (mp?.cpus) tables.push(table("cpus", "Barebone-Werte je CPU", [
    ["cpu", "CPU", "text"], ["gen", "Generation", "num"], ["base", "Barebone-Wert", "eur"], ["basis", "Grundlage", "text"], ["count", "Angebote in der Berechnung", "num"],
    ["offers", "Sofortkäufe", "num"], ["cheapest", "Günstigster", "eur"],
  ], mp.cpus.map((x) => [x.cpu, x.gen, x.base, x.basis, x.count, x.offers, x.cheapest])));
  categories.push({ id: "minipc", label: "Mini-PCs", tables });
}

// ---- Arbeitsspeicher ----
const rh = await read(join(dir, "ram-history.json"));
const ram = await read("data/ram.json");
if (rh || ram) {
  const tables = [];
  if (ram?.offers) tables.push(table("offers", "Ausgewertete Angebote", [
    ["market", "Markt", "text"], ["title", "Angebot", "link"], ["modules", "Module", "num"], ["speed", "Takt (MHz)", "num"], ["format", "Format", "text"],
    ["price", "Preis inkl. Versand", "eur"], ["perGB", "Preis je GB", "eur"], ["reference", "Referenz", "eur"], ["discount", "Unter Referenz", "pct"],
    ["bids", "Gebote", "num"], ["endsAt", "Ende", "date"], ["condition", "Zustand", "text"], ["seller", "Verkäufer-Bewertungen", "num"],
  ], ram.offers.map((o) => [o.market, [o.title, o.url], o.modules, o.speed, o.auction ? "Auktion" : "Sofort-Kaufen", o.price, o.perGB, o.reference,
    o.discount, o.bids, time(o.endsAt), o.condition, o.seller]), "Aktueller Lauf: alle RAM-Angebote, die die Filter bestanden haben."));
  if (rh) tables.push(table("ended", "Beendete Auktionen", [
    ["at", "Ende", "date"], ["market", "Markt", "text"], ["title", "Angebot", "link"], ["speed", "Takt (MHz)", "num"], ["price", "Endpreis inkl. Versand", "eur"],
    ["perGB", "Endpreis je GB", "eur"], ["bids", "Gebote", "num"], ["result", "Ergebnis", "text"],
  ], (rh.ended ?? []).map((x) => {
    const gb = Number(x.key?.match(/(\d+) GB/)?.[1]);
    return [x.at, x.key, [x.title ?? "ansehen", x.url], x.speed, x.price, x.price != null && gb ? Math.round(x.price / gb * 100) / 100 : null, x.bids,
      RESULT[x.result] ?? x.result];
  }), "Endpreise per eBay-Abfrage nach Auktionsende (30 Tage)."));
  if (ram?.markets) tables.push(table("markets", "Märkte", [
    ["key", "Markt", "text"], ["offers", "Sofortkäufe", "num"], ["auctions", "Auktionen", "num"], ["referenceUsed", "Referenz gebraucht", "eur"],
    ["referenceNew", "Referenz neu", "eur"], ["perGB", "Referenz je GB", "eur"], ["cheapest", "Günstigster Sofortkauf", "eur"],
    ["soldMedian", "Verkauft (Median)", "eur"], ["soldCount", "Verkäufe", "num"],
  ], ram.markets.map((m) => [m.key, m.offers, m.auctions, m.referenceUsed, m.referenceNew, m.perGB, m.cheapestBin?.price ?? null, m.soldMedian, m.soldCount])));
  categories.push({ id: "ram", label: "Arbeitsspeicher", tables });
}

await mkdir("data", { recursive: true });
await writeFile("data/tables.json", JSON.stringify({ updatedAt: new Date(now).toISOString(), categories }));
for (const c of categories) console.log(`${c.label}: ${c.tables.map((t) => `${t.label} ${t.rows.length}`).join(", ")}`);
