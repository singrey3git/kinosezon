// Сбор постеров и номеров IMDb для страницы «Киносезон».
//
// Запуск:  TMDB_TOKEN=... node tools/fetch-posters.mjs [data] [posters.json] [--all]
//          node tools/fetch-posters.mjs --check      (только посчитать фильмы, без запросов)
//
// 1. Берёт фильмы всех сезонов из папки data/ (файлы сезонов: films и wikiT).
// 2. Через Викиданные находит номер IMDb (P345) и номер TMDB (P4947): по номеру Кинопоиска (P2603)
//    или по статье английской Википедии.
// 3. Через TMDB берёт постер (сначала русский, если его нет — основной).
//    Если номеров нет, ищет фильм в TMDB по названию и году и сверяет режиссёра.
// 4. Пишет posters.json: { generated, source, films: { id: { poster, imdb, tmdb } } }.
//    Уже найденное не перезапрашивает (если не передан --all).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const args = process.argv.slice(2);
const ALL = args.includes("--all"), CHECK = args.includes("--check");
const [DATA = "data", OUT = "posters.json"] = args.filter(a => !a.startsWith("--"));

const UA = "kinosezon-posters/1.1 (GitHub Actions; https://github.com)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- фильмы из файлов сезонов ---------- */
const ctx = vm.createContext({ SEASONS: [] });
for (const f of fs.readdirSync(DATA).filter(f => f.endsWith(".js")).sort())
  vm.runInContext(fs.readFileSync(path.join(DATA, f), "utf8"), ctx, { filename: f });
const FILMS = {}, WIKI_T = {};
for (const s of ctx.SEASONS) { Object.assign(FILMS, s.films || {}); Object.assign(WIKI_T, s.wikiT || {}); }
console.log(`Сезонов: ${ctx.SEASONS.length} (${ctx.SEASONS.map(s => s.id).join(", ")})`);
if (CHECK) { console.log(`Фильмов: ${Object.keys(FILMS).length}, статей Википедии: ${Object.keys(WIKI_T).length}`); process.exit(0); }

const TOKEN = (process.env.TMDB_TOKEN || "").trim();
if (!TOKEN) { console.error("Нет TMDB_TOKEN. Добавь ключ TMDB в секреты репозитория (Settings → Secrets → Actions)."); process.exit(1); }
const ids = Object.keys(FILMS);
const info = id => { const r = FILMS[id]; return { id, ru: r[0], orig: r[1], en: r[2], dir: r[3], kp: /^\d+$/.test(id) ? id : null }; };
console.log(`Фильмов на странице: ${ids.length}`);

let out = { films: {} };
try { out = JSON.parse(fs.readFileSync(OUT, "utf8")); out.films ||= {}; } catch {}
const res = out.films;
const todo = ids.filter(id => ALL || !res[id]?.poster);
console.log(`Нужно найти: ${todo.length}`);

/* ---------- запросы ---------- */
async function getJSON(url, headers = {}, tries = 5) {
  for (let k = 0; k < tries; k++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * (k + 1) * (Number(r.headers.get("retry-after")) || 1)); continue; }
    throw new Error(`${r.status} ${url.slice(0, 120)}`);
  }
  throw new Error(`Не удалось: ${url.slice(0, 120)}`);
}
const bearer = TOKEN.length > 40;
function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  if (!bearer) u.searchParams.set("api_key", TOKEN);
  return getJSON(u.toString(), bearer ? { Authorization: `Bearer ${TOKEN}` } : {});
}
const sparql = q => getJSON("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { Accept: "application/sparql-results+json" });

/* ---------- 1. Викиданные: IMDb и TMDB по Кинопоиску и Википедии ---------- */
const wd = {}; // id → { imdb, tmdb }
const put = (id, b) => { const x = (wd[id] ||= {}); if (b.imdb && !x.imdb) x.imdb = b.imdb.value; if (b.tmdb && !x.tmdb) x.tmdb = b.tmdb.value; };
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
try {
  const kps = todo.filter(id => info(id).kp);
  for (const part of chunk(kps, 150)) {
    const j = await sparql(`SELECT ?kp ?imdb ?tmdb WHERE { VALUES ?kp { ${part.map(k => `"${k}"`).join(" ")} } ?item wdt:P2603 ?kp .
      OPTIONAL { ?item wdt:P345 ?imdb } OPTIONAL { ?item wdt:P4947 ?tmdb } }`);
    j?.results.bindings.forEach(b => put(b.kp.value, b));
    await sleep(300);
  }
  const byTitle = {}; todo.forEach(id => { if (WIKI_T[id]) byTitle[WIKI_T[id]] = id; });
  for (const part of chunk(Object.keys(byTitle), 100)) {
    const j = await sparql(`SELECT ?name ?imdb ?tmdb WHERE { VALUES ?name { ${part.map(t => JSON.stringify(t) + "@en").join(" ")} }
      ?a schema:name ?name ; schema:isPartOf <https://en.wikipedia.org/> ; schema:about ?item .
      OPTIONAL { ?item wdt:P345 ?imdb } OPTIONAL { ?item wdt:P4947 ?tmdb } }`);
    j?.results.bindings.forEach(b => put(byTitle[b.name.value], b));
    await sleep(300);
  }
  console.log(`Викиданные: номер IMDb у ${Object.values(wd).filter(x => x.imdb).length}, номер TMDB у ${Object.values(wd).filter(x => x.tmdb).length}`);
} catch (e) { console.warn("Викиданные недоступны:", e.message); }

/* ---------- 2. TMDB ---------- */
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ё/g, "е").replace(/[^a-z0-9а-я]+/g, " ").trim();
const surname = s => norm(String(s || "").split(/,| и | & /)[0]).split(" ").pop();
async function details(tmdbId) {
  const m = await tmdb(`/movie/${tmdbId}`, { language: "ru-RU" });
  if (!m) return null;
  let poster = m.poster_path;
  if (!poster) { const en = await tmdb(`/movie/${tmdbId}`, { language: "en-US" }); poster = en?.poster_path; }
  return { tmdb: m.id, imdb: m.imdb_id || null, poster: poster ? "https://image.tmdb.org/t/p/w500" + poster : null };
}
async function directorMatches(tmdbId, f) {
  const want = surname(f.dir); if (!want) return true;
  const c = await tmdb(`/movie/${tmdbId}/credits`);
  return (c?.crew || []).some(p => p.job === "Director" && norm(p.name).split(" ").pop() === want);
}
async function searchTMDB(f) {
  const names = [...new Set([f.en, f.orig, f.ru].filter(Boolean))];
  const ok = new Set(names.map(norm));
  for (const q of names) {
    const j = await tmdb("/search/movie", { query: q, include_adult: "false", language: "ru-RU" });
    const cand = (j?.results || []).filter(m => {
      const y = +(m.release_date || "0").slice(0, 4);
      return (!y || (y >= 2022 && y <= 2027)) && (ok.has(norm(m.title)) || ok.has(norm(m.original_title)));
    }).slice(0, 4);
    for (const m of cand) if (await directorMatches(m.id, f)) return m.id;
  }
  return null;
}
async function one(id) {
  const f = info(id), w = wd[id] || {};
  let d = null;
  if (w.tmdb) d = await details(w.tmdb);
  if (!d && w.imdb) {
    const j = await tmdb(`/find/${w.imdb}`, { external_source: "imdb_id" });
    const m = j?.movie_results?.[0]; if (m) d = await details(m.id);
  }
  if (!d) { const t = await searchTMDB(f); if (t) d = await details(t); }
  const prev = res[id] || {};
  res[id] = { poster: d?.poster || prev.poster || null, imdb: d?.imdb || w.imdb || prev.imdb || null, tmdb: d?.tmdb || prev.tmdb || null };
}
const queue = [...todo]; let done = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const id = queue.shift();
    try { await one(id); } catch (e) { console.warn(`  ${id}: ${e.message}`); }
    if (++done % 50 === 0) console.log(`  обработано ${done} из ${todo.length}`);
  }
}));

/* ---------- 3. Запись ---------- */
for (const id of Object.keys(res)) if (!FILMS[id]) delete res[id];
out.generated = new Date().toISOString();
out.source = "TMDB (постеры), Викиданные (номера IMDb)";
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
const miss = ids.filter(id => !res[id]?.poster);
console.log(`\nГотово: постеры у ${ids.length - miss.length} из ${ids.length}, номер IMDb у ${ids.filter(id => res[id]?.imdb).length}.`);
if (miss.length) console.log("Без постера:\n" + miss.map(id => `  ${id}  ${FILMS[id][0]} (${FILMS[id][1]})`).join("\n"));
