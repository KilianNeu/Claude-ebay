// Mini-PCs (NUC, ThinkCentre Tiny, EliteDesk Mini, OptiPlex Micro, Esprimo Mini): eigene Kategorie,
// unabhängig von den Grafikkarten (eigene Konfiguration minipcs.json, eigene Ausgabe data/minipc.json).
//
// Anders als bei Grafikkarten bestimmt nicht das Modell allein den Preis, sondern die Ausstattung.
// Deshalb liest das Skript CPU, RAM und SSD aus dem Titel und schätzt den Marktwert aus Bauteilen:
//   Marktwert = Barebone-Wert der CPU + RAM (GB × €/GB) + SSD (GB × €/GB)
// RAM- und SSD-Preise je GB misst es selbst auf eBay; den Barebone-Wert je CPU leitet es aus allen
// Angeboten mit dieser CPU ab (Preis minus Bauteilwert, davon der Median).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { API, getToken, num, totalPrice, domestic, quantile, median } from "./lib.mjs";

const config = JSON.parse(await readFile(new URL("../minipcs.json", import.meta.url), "utf8"));
const outFile = new URL("../data/minipc.json", import.meta.url);
const now = Date.now();
const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

async function search(token, params) {
  const url = `${API}/buy/browse/v1/item_summary/search?` + new URLSearchParams(params);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": config.marketplace, "Accept-Language": "de-DE" },
  });
  if (!res.ok) throw new Error(`Suche fehlgeschlagen (${params.q}): ${res.status} ${await res.text()}`);
  return (await res.json()).itemSummaries ?? [];
}

const where = `priceCurrency:${config.currency},itemLocationCountry:DE,conditionIds:{${config.conditionIds}}`;

// ---- Titel auswerten ----

// CPU: Intel Core i3–i9 (z. B. i7-1260P, i5 11500T), Core Ultra (Ultra 5 125H), AMD Ryzen (Ryzen 5 PRO 5650GE).
export function parseCpu(title) {
  const t = title.toLowerCase();
  let m = t.match(/(?:core\s*)?ultra\s*([579])\s*-?\s*(\d{3})([a-z]{0,2})\b/);
  if (m) return { id: `ultra ${m[1]} ${m[2]}${m[3]}`, vendor: "intel", tier: `u${m[1]}`, gen: 14 };
  m = t.match(/\bi([3579])\s*-?\s*(\d{4,5})([a-z]{0,2}\d?)\b/);
  if (m) {
    const digits = m[2];
    // 5-stellig (10500T) und 4-stellig mit führender 1 (1135G7, 1260P) → zweistellige Generation; sonst (8500T) einstellig
    const gen = digits.length === 5 || digits[0] === "1" ? Number(digits.slice(0, 2)) : Number(digits[0]);
    return { id: `i${m[1]}-${digits}${m[3]}`, vendor: "intel", tier: `i${m[1]}`, gen };
  }
  m = t.match(/ryzen\s*([3579])\s*(?:pro\s*)?(\d{4})([a-z]{0,2})\b/);
  if (m) return { id: `ryzen ${m[1]} ${m[2]}${m[3]}`, vendor: "amd", tier: `r${m[1]}`, gen: Math.floor(Number(m[2]) / 1000) * 1000 };
  return null;
}

// RAM und SSD aus Angaben wie "16GB/512GB", "32 GB DDR5", "1TB NVMe". Kleine Größen (≤ 96 GB) gelten
// als RAM, große (≥ 120 GB oder TB) als SSD – außer der Kontext sagt eindeutig etwas anderes.
const RAM_SIZES = new Set([4, 8, 12, 16, 24, 32, 40, 48, 64, 96]);
export function parseSpecs(title) {
  const t = title.toLowerCase().replace(/,/g, ".");
  let ram = null, ssd = null;
  // Kontext nur bis zur nächsten Zahl, damit "16GB 256GB SSD" die 16 nicht als SSD liest
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(tb|gb|g)\b(?=(.{0,14}))/g)) {
    const size = Number(m[1]) * (m[2] === "tb" ? 1000 : 1), after = m[3].split(/\d/)[0];
    const storage = /ssd|nvme|m\.2|hdd|emmc|festplatte/.test(after);
    const memory = /ram|ddr|arbeitsspeicher|sodimm|so-dimm/.test(after);
    if ((storage || size >= 120) && !memory) ssd = Math.max(ssd ?? 0, size);
    else if (RAM_SIZES.has(size) && !storage) ram = Math.max(ram ?? 0, size);
  }
  const barebone = /barebone|ohne\s+(ram|ssd|festplatte|speicher|arbeitsspeicher)|ohne ram/.test(t);
  if (barebone) { ram = /ohne\s+(ram|arbeitsspeicher|speicher)|barebone/.test(t) ? (ram ?? 0) : ram; ssd = /ohne\s+(ssd|festplatte)|barebone/.test(t) ? (ssd ?? 0) : ssd; }
  // Übliche Herstellergrößen zusammenfassen (500 GB ≈ 512 GB), damit gleiche Konfigurationen vergleichbar sind
  const SSD_STEPS = [[128, 120, 128], [256, 240, 256], [512, 480, 512], [1000, 960, 1024], [2000, 1920, 2048], [4000, 3840, 4096]];
  if (ssd) ssd = SSD_STEPS.find(([, lo, hi]) => ssd >= lo && ssd <= hi)?.[0] ?? ssd;
  const ddr = /ddr5/.test(t) ? "ddr5" : /ddr4/.test(t) ? "ddr4" : null;
  const noPsu = /ohne\s+(netzteil|nt)\b/.test(t);
  return { ram, ssd, barebone, ddr, noPsu };
}

// DDR-Generation, wenn sie nicht im Titel steht: neuere Plattformen nutzen DDR5.
const ddrFor = (cpu, specs) => specs.ddr ?? ((cpu.vendor === "intel" && cpu.gen >= 14) || (cpu.vendor === "amd" && cpu.gen >= 6000) ? "ddr5" : "ddr4");

const tooOld = (cpu) => (cpu.vendor === "intel" ? cpu.gen < config.minIntelGen : cpu.gen < config.minRyzenSeries);

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

function rejectReason(i, family) {
  const title = i.title ?? "";
  if (!new RegExp(family.require, "i").test(title)) return "keine passende Baureihe im Titel";
  if (i.conditionId === "7000") return "Zustand: defekt";
  if (!domestic(i)) return "nicht auf ebay.de in Euro oder Standort nicht Deutschland";
  if (!trusted(i)) return `Verkäufer: ${i.seller?.feedbackScore ?? "?"} Bewertungen`;
  const term = excludedTerm(title);
  if (term) return `Ausschlusswort „${term}“`;
  const cpu = parseCpu(title);
  if (!cpu) return "CPU nicht im Titel";
  if (tooOld(cpu)) return `CPU älter als 6 Jahre (${cpu.id})`;
  if (!i.buyingOptions?.includes("AUCTION") && totalPrice(i) < config.minPrice) return `unter Mindestpreis ${config.minPrice} €`;
  return null;
}

// ---- Bauteilpreise je GB ----

async function componentRates(token) {
  const perGB = { ddr4: [], ddr5: [], ssd: [] };
  for (const c of config.components) {
    const items = await search(token, { q: c.query, filter: `${where},buyingOptions:{FIXED_PRICE}`, limit: "100" });
    for (const i of items) {
      const t = (i.title ?? "").toLowerCase();
      if (!domestic(i) || excludedTerm(t) || /laptop komplett|notebook komplett|defekt/.test(t)) continue;
      let gb = null;
      if (c.kind === "ssd") {
        if (!/nvme|m\.2/.test(t)) continue;
        const m = t.match(/(\d+(?:[.,]\d+)?)\s*(tb|gb)\b/);
        if (m) gb = Number(m[1].replace(",", ".")) * (m[2] === "tb" ? 1000 : 1);
        if (!(gb >= 256 && gb <= 4000)) continue;
      } else {
        if (!t.includes(c.kind) || /desktop|udimm|dimm(?!.*so)/.test(t.replace(/so-?dimm/g, ""))) continue;
        const kit = t.match(/(\d)\s*x\s*(\d+)\s*gb/);
        const single = t.match(/(\d+)\s*gb/);
        gb = kit ? Number(kit[1]) * Number(kit[2]) : single ? Number(single[1]) : null;
        if (!RAM_SIZES.has(gb) || gb < 8) continue;
      }
      perGB[c.kind].push(totalPrice(i) / gb);
    }
  }
  // Unteres Quartil: realistischer Einkaufs-/Verkaufswert, überteuerte Händlerangebote fallen raus.
  const rate = (v) => ({ perGB: round2(quantile(v, 0.25)), samples: v.length });
  return { ddr4: rate(perGB.ddr4), ddr5: rate(perGB.ddr5), ssd: rate(perGB.ssd) };
}

// ---- Hauptlauf ----

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
const result = { updatedAt: new Date(now).toISOString(), resale: config.resale, families: config.families.map((f) => f.label), components: null, cpus: [], deals: [], groups: [], rejected: [], errors: [] };

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  result.errors.push("Keine eBay-API-Keys hinterlegt.");
} else {
  const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
  const rates = await componentRates(token);
  result.components = rates;
  console.log(`Bauteile: DDR4 ${rates.ddr4.perGB} €/GB (${rates.ddr4.samples}), DDR5 ${rates.ddr5.perGB} €/GB (${rates.ddr5.samples}), SSD ${rates.ssd.perGB} €/GB (${rates.ssd.samples})`);

  // Angebote aller Baureihen sammeln und auswerten
  const offers = [];
  const rejected = new Map();
  for (const f of config.families) {
    try {
      const [fixed, auctions] = await Promise.all([
        search(token, { q: f.query, filter: `${where},buyingOptions:{FIXED_PRICE}`, limit: "200" }),
        search(token, { q: f.query, filter: `${where},buyingOptions:{AUCTION}`, sort: "endingSoonest", limit: "50" }),
      ]);
      let kept = 0;
      const reasons = {};
      for (const i of [...fixed, ...auctions]) {
        if (offers.some((o) => o.item.itemId === i.itemId)) continue;
        const reason = rejectReason(i, f);
        if (reason) {
          const kind = reason.replace(/ \(.*\)$|„.*“|\d+/g, "").trim();
          reasons[kind] = (reasons[kind] ?? 0) + 1;
          if (!/Baureihe|CPU nicht|Mindestpreis/.test(reason) && !i.buyingOptions?.includes("AUCTION")) {
            rejected.set(i.itemId, { price: round2(totalPrice(i)), title: i.title, url: i.itemWebUrl, reason, family: f.label });
          }
          continue;
        }
        const cpu = parseCpu(i.title);
        const specs = parseSpecs(i.title);
        offers.push({ item: i, family: f.label, cpu, specs, ddr: ddrFor(cpu, specs), total: totalPrice(i), auction: i.buyingOptions?.includes("AUCTION") ?? false });
        kept++;
      }
      console.log(`  ${f.label}: ${fixed.length + auctions.length} gefunden, ${kept} ausgewertet – verworfen: `
        + Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "));
    } catch (e) {
      result.errors.push(e.message);
    }
  }

  // Bauteilwert eines Angebots (RAM/SSD unbekannt = 0, dann zählt es zum Barebone-Anteil)
  const partsValue = (o) => (o.specs.ram ?? 0) * (rates[o.ddr].perGB ?? 0) + (o.specs.ssd ?? 0) * (rates.ssd.perGB ?? 0);

  // Barebone-Wert je CPU: Median von (Preis − Bauteilwert) über Sofortkäufe mit bekannter Ausstattung;
  // bei zu wenigen Angeboten über die CPU-Klasse (z. B. alle i7 der 12. Generation).
  const complete = offers.filter((o) => !o.auction && o.specs.ram != null && o.specs.ssd != null);
  const residuals = (key) => complete.filter((o) => key(o)).map((o) => o.total - partsValue(o));
  const baseCache = new Map();
  const baseFor = (cpu) => {
    if (baseCache.has(cpu.id)) return baseCache.get(cpu.id);
    let r = residuals((o) => o.cpu.id === cpu.id), basis = cpu.id;
    if (r.length < config.minCpuSamples) { r = residuals((o) => o.cpu.tier === cpu.tier && o.cpu.gen === cpu.gen); basis = `${cpu.tier} Gen ${cpu.gen}`; }
    const v = r.length >= config.minCpuSamples ? { base: median(r), count: r.length, basis } : null;
    baseCache.set(cpu.id, v);
    return v;
  };

  // Gleiche Konfiguration (CPU + RAM + SSD): günstigster Sofortkauf als Vergleich und Verkaufspreis
  const groupKey = (o) => `${o.cpu.id}|${o.specs.ram ?? "?"}|${o.specs.ssd ?? "?"}`;
  const groups = new Map();
  for (const o of offers.filter((x) => !x.auction)) {
    const g = groups.get(groupKey(o)) ?? [];
    g.push(o);
    groups.set(groupKey(o), g);
  }

  const r = config.resale;
  for (const o of offers) {
    const b = baseFor(o.cpu);
    if (!b || o.specs.ram == null || o.specs.ssd == null) continue;
    const parts = partsValue(o);
    const value = b.base + parts;
    if (!(o.total <= value * config.dealThreshold && o.total >= value * config.floorRatio)) continue;
    const same = (groups.get(groupKey(o)) ?? []).filter((x) => x.item.itemId !== o.item.itemId).sort((a, c) => a.total - c.total)[0];
    const i = o.item;
    result.deals.push({
      id: i.itemId, title: i.title, url: i.itemWebUrl, image: i.image?.imageUrl ?? i.thumbnailImages?.[0]?.imageUrl ?? null,
      family: o.family, cpu: o.cpu.id, ram: o.specs.ram, ssd: o.specs.ssd, ddr: o.ddr, barebone: o.specs.barebone, noPsu: o.specs.noPsu,
      condition: i.condition ?? null, auction: o.auction, bids: o.auction ? i.bidCount ?? 0 : null, endsAt: i.itemEndDate ?? null,
      bestOffer: i.buyingOptions?.includes("BEST_OFFER") ?? false,
      seller: i.seller ? { score: i.seller.feedbackScore ?? null, positive: i.seller.feedbackPercentage ?? null } : null,
      total: round2(o.total), shipping: round2(num(i.shippingOptions?.[0]?.shippingCost)),
      value: round(value), base: round(b.base), baseBasis: b.basis, baseCount: b.count,
      ramValue: round((o.specs.ram ?? 0) * (rates[o.ddr].perGB ?? 0)), ssdValue: round((o.specs.ssd ?? 0) * (rates.ssd.perGB ?? 0)),
      discount: Math.round((1 - o.total / value) * 100),
      profit: round(value - r.shipping - r.packaging - o.total),
      sameConfig: same ? { price: round2(same.total), url: same.item.itemWebUrl } : null,
    });
  }
  result.deals.sort((a, c) => c.profit - a.profit);

  // Übersicht je CPU (Barebone-Werte) und häufige Konfigurationen
  for (const id of [...new Set(offers.map((o) => o.cpu.id))]) {
    const cpu = offers.find((o) => o.cpu.id === id).cpu;
    const b = baseFor(cpu);
    const own = offers.filter((o) => o.cpu.id === id && !o.auction);
    result.cpus.push({ cpu: id, gen: cpu.gen, vendor: cpu.vendor, offers: own.length, base: b ? round(b.base) : null, basis: b?.basis ?? null, count: b?.count ?? 0,
      cheapest: own.length ? round2(Math.min(...own.map((o) => o.total))) : null });
  }
  result.cpus.sort((a, c) => (c.offers - a.offers) || a.cpu.localeCompare(c.cpu));
  result.groups = [...groups.entries()].filter(([, g]) => g.length >= 2).map(([key, g]) => {
    const [cpu, ram, ssd] = key.split("|");
    const sorted = g.sort((a, c) => a.total - c.total);
    return { cpu, ram, ssd, count: g.length, cheapest: round2(sorted[0].total), cheapestUrl: sorted[0].item.itemWebUrl, median: round(median(g.map((o) => o.total))) };
  }).sort((a, c) => c.count - a.count).slice(0, 40);
  result.rejected = [...rejected.values()].sort((a, c) => a.price - c.price).slice(0, 15);
  result.offerCount = offers.length;
  console.log(`${offers.length} Mini-PCs ausgewertet, ${result.deals.length} Schnäppchen, ${result.cpus.length} CPUs.`);
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(outFile, JSON.stringify(result, null, 2));
for (const e of result.errors) console.warn("  " + e);
