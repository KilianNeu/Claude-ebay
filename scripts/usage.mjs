// eBay-API-Verbrauch des Tages abfragen (Developer Analytics API) und für die Seite ablegen.
// Zählt alle Läufe zusammen: stündlicher Lauf, Mini-PCs, Arbeitsspeicher und Schnellcheck.

import { writeFile, mkdir } from "node:fs/promises";
import { API, getToken } from "./lib.mjs";

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET fehlen.");
const token = await getToken(EBAY_CLIENT_ID, EBAY_CLIENT_SECRET);
const res = await fetch(`${API}/developer/analytics/v1_beta/rate_limit/?api_context=buy&api_name=browse`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) throw new Error(`Abfrage fehlgeschlagen: ${res.status} ${await res.text()}`);
const rates = [];
for (const api of (await res.json()).rateLimits ?? []) {
  for (const r of api.resources ?? []) {
    for (const rate of r.rates ?? []) rates.push({ resource: r.name, count: rate.count, limit: rate.limit, remaining: rate.remaining, reset: rate.reset, window: rate.timeWindow });
  }
}
for (const r of rates) console.log(`${r.resource}: ${r.count} von ${r.limit} verbraucht, ${r.remaining} übrig, zurückgesetzt ${r.reset} (Fenster ${r.window} s)`);
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
const out = JSON.stringify({ updatedAt: new Date().toISOString(), rates });
await writeFile(new URL("../data/usage.json", import.meta.url), out);
// Zusätzlich in den Branch data (USAGE_FILE), damit der Schnellcheck sein Budget kennt
if (process.env.USAGE_FILE) await writeFile(process.env.USAGE_FILE, out);
