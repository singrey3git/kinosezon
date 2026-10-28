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
// год сезона, в котором фильм впервые встречается (фестивали этого года)
const FY = {}; for (const s of ctx.SEASONS) for (const id of Object.keys(s.films || {})) FY[id] ??= s.y0;
const yearOf = d => +(String(d || "").slice(0, 4)) || 0;
const recent = (d, f) => { const y = yearOf(d), y0 = FY[f.id] || 2025; return !y || (y >= y0 - 1 && y <= y0 + 1); };
const dirs = f => String(f.dir || "").split(/,| и | & | and /).map(norm).filter(Boolean);
// имена режиссёров: «Hong Sangsoo» = «Hong Sang-soo», «Yeo Siew Hua» = «Siew Hua Yeo», совпадение фамилии
function sameName(a, b) {
  if (!a || !b) return false;
  const A = a.split(" "), B = b.split(" ");
  if (A.join("") === B.join("")) return true;
  if ([...A].sort().join("") === [...B].sort().join("")) return true;
  const la = A[A.length - 1], lb = B[B.length - 1];
  return la.length > 2 && (la === lb || A.includes(lb) && B.includes(la));
}
const titles = f => {
  const wt = WIKI_T[f.id] && WIKI_T[f.id].replace(/\s*\([^)]*\)\s*$/, "");
  return [...new Set([f.en, wt, f.orig, f.ru].filter(Boolean))];
};
async function details(tmdbId) {
  const m = await tmdb(`/movie/${tmdbId}`, { language: "ru-RU" });
  if (!m) return null;
  let poster = m.poster_path;
  if (!poster) { const en = await tmdb(`/movie/${tmdbId}`, { language: "en-US" }); poster = en?.poster_path; }
  return { tmdb: m.id, imdb: m.imdb_id || null, poster: poster ? "https://image.tmdb.org/t/p/w500" + poster : null };
}
async function directorMatches(tmdbId, f, strict = false) {
  const want = dirs(f).filter(d => !/[а-я]/.test(d));
  if (!want.length) return !strict && !dirs(f).length;
  const c = await tmdb(`/movie/${tmdbId}/credits`);
  return (c?.crew || []).some(p => p.job === "Director" && want.some(d => sameName(norm(p.name), d)));
}
// 1) поиск по названиям на английском и русском; точное название + режиссёр — в любом году (реставрации классики),
// 2) свежий фильм того же режиссёра среди первых результатов — названия часто записаны иначе (транслит, иероглифы),
// 3) фильмография режиссёра: фильм с тем же названием или единственный фильм режиссёра в годы сезона
async function searchTMDB(f) {
  const names = titles(f), ok = new Set(names.map(norm)), tried = new Set();
  for (const q of names) for (const language of ["en-US", "ru-RU"]) {
    const j = await tmdb("/search/movie", { query: q, include_adult: "false", language });
    const list = j?.results || [];
    for (const m of list.filter(m => ok.has(norm(m.title)) || ok.has(norm(m.original_title))).slice(0, 4)) {
      if (tried.has(m.id)) continue; tried.add(m.id);
      if (await directorMatches(m.id, f)) return m.id;
    }
    for (const m of list.filter(m => recent(m.release_date, f)).slice(0, 3)) {
      if (tried.has("d" + m.id)) continue; tried.add("d" + m.id);
      if (await directorMatches(m.id, f, true)) return m.id;
    }
  }
  return byDirector(f, ok);
}
async function byDirector(f, ok) {
  for (const d of dirs(f).filter(d => !/[а-я]/.test(d)).slice(0, 2)) {
    const p = await tmdb("/search/person", { query: d });
    for (const person of (p?.results || []).filter(x => sameName(norm(x.name), d)).slice(0, 2)) {
      const c = await tmdb(`/person/${person.id}/movie_credits`);
      const films = [...new Map((c?.crew || []).filter(m => m.job === "Director").map(m => [m.id, m])).values()];
      const named = films.find(m => ok.has(norm(m.title)) || ok.has(norm(m.original_title)));
      if (named) return named.id;
      const near = films.filter(m => yearOf(m.release_date) && recent(m.release_date, f));
      const undated = films.filter(m => !yearOf(m.release_date));
      if (near.length === 1 && !undated.length) return near[0].id;
      if (!near.length && undated.length === 1) return undated[0].id;
    }
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
