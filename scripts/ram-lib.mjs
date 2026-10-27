// Gemeinsame RAM-Erkennung für den stündlichen Lauf (ram.mjs) und den Schnellcheck (quick-check.mjs).

import { readFile } from "node:fs/promises";
import { totalPrice, domestic } from "./lib.mjs";

export const ramConfig = JSON.parse(await readFile(new URL("../ram.json", import.meta.url), "utf8"));
const config = ramConfig;

// ---- Titel auswerten ----

const SIZES = new Set([4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256]);
export function parseRam(title) {
  const t = title.toLowerCase().replace(/,/g, ".");
  const ddr = /ddr5/.test(t) ? "ddr5" : /ddr4/.test(t) ? "ddr4" : null;
  if (!ddr || /ddr3|ddr2|ddr4\s*\/\s*5|ddr4.*ddr5|ddr5.*ddr4/.test(t)) return null;
  // Variantenangebote ("4GB / 8GB / 16GB"): Preis gilt für die kleinste Variante → nicht vergleichbar
  if (/\b\d{1,3}\s*(?:gb)?\s*\/\s*\d{1,3}\s*gb\b/.test(t)) return null;
  // Bauform aus Text oder Teilenummer (Samsung M471/M425, Micron MTA…HZ, SK hynix …GS6…, Crucial CT…SFS = SO-DIMM)
  const form = /s[o0]-?dimm|s[o0]dimm|laptop|notebook|\bsod\b|260-?pin|262-?pin|\bm4(71|25)|\bmta\w+hz\b|\bhma\w*gs6|\bct\w*sfs/.test(t) ? "sodimm" : "dimm";
  // Kit: "2x16GB", "2 x 8 GB", "4x32 GB"; sonst Gesamtangabe "32GB" (größte plausible Zahl vor GB)
  let modules = 1, total = null, m;
  if ((m = t.match(/\b([1-8])\s*[x×]\s*(\d{1,3})\s*gb\b/))) [modules, total] = [Number(m[1]), Number(m[1]) * Number(m[2])];
  else if ((m = t.match(/\b(\d{1,3})\s*gb\s*[x×]\s*([1-8])\b/))) [modules, total] = [Number(m[2]), Number(m[1]) * Number(m[2])];
  else {
    const sizes = [...t.matchAll(/\b(\d{1,3})\s*gb\b/g)].map((x) => Number(x[1])).filter((v) => SIZES.has(v));
    if (sizes.length) total = sizes[0]; // erste Angabe; später folgen oft Vergleiche ("ähnlich wie 64GB")
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

export function excludedTerm(title) {
  const t = title.toLowerCase();
  return config.exclude.find((term) => new RegExp(`(^|[^a-z0-9äöü])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9äöü]|$)`).test(t));
}

export function trusted(i) {
  const score = Number(i.seller?.feedbackScore), positive = Number(i.seller?.feedbackPercentage);
  if (Number.isFinite(score) && score < config.minSellerFeedback) return false;
  if (Number.isFinite(positive) && positive > 0 && positive < config.minSellerPositive) return false; // 0.0 = unbekannt
  return true;
}

export function rejectReason(i) {
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

