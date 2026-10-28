// Текстовый блок «Все победители по сезонам» для поисковиков и читателей.
// Собирается из data/*.js и вставляется в index.html между <!--seo:start--> и <!--seo:end-->.
//
// Запуск после правки данных:  node tools/build-seo.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ctx = vm.createContext({ SEASONS: [] });
for (const f of fs.readdirSync(path.join(ROOT, "data")).filter(f => f.endsWith(".js")).sort())
  vm.runInContext(fs.readFileSync(path.join(ROOT, "data", f), "utf8"), ctx, { filename: f });

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const day = iso => { const [y, m, d] = iso.split("-").map(Number); return { y, m, d, t: `${d} ${MON[m - 1]}` }; };
function span(m) {
  if (!m?.start) return "";
  const a = day(m.start), b = day(m.end || m.start);
  if (m.start === (m.end || m.start)) return `${a.t} ${a.y}`;
  return a.m === b.m ? `${a.d}–${b.d} ${MON[b.m - 1]} ${b.y}` : `${a.t} — ${b.t} ${b.y}`;
}

function filmHTML(films, fid, who) {
  const r = films[fid]; if (!r) return "";
  const [ru, orig, en, dir] = r;
  const alt = [...new Set([orig, en].filter(t => t && t !== ru))].join(" / ");
  const by = who ? ` — ${esc(who)}` : dir ? `, реж. ${esc(dir)}` : "";
  return `<span class="lnk" data-open="${esc(fid)}" tabindex="0">«${esc(ru)}»</span>${alt ? ` (${esc(alt)})` : ""}${by}`;
}

function seasonHTML(s) {
  const fy = s.y0, ay = s.y0 + 1;
  let h = `<h3>Сезон ${esc(s.title)}: фестивали ${fy} года и премии ${ay} года</h3>`;
  for (const e of s.events) {
    const m = s.meta[e.id] || {};
    h += `<div class="ev"><h4>${esc(e.full)}${span(m) ? ` <small>${esc(span(m))}</small>` : ""}</h4>`;
    const li = [];
    if (e.kind === "fest") {
      if (e.top) li.push(`<b>${esc(e.top[0])}</b>: ${filmHTML(s.films, e.top[2])}`);
      for (const a of e.jury || []) li.push(`<b>${esc(a[0])}</b>: ${filmHTML(s.films, a[2], a[3])}`);
      for (const [gname, list] of e.progs || []) {
        const w = list[0]; if (w) li.push(`<b>${esc(gname)} — ${esc(w[0])}</b>: ${filmHTML(s.films, w[2], w[3])}`);
      }
    } else if (e.upcoming || !(e.cats || []).length) {
      li.push(`Церемония — ${esc(span(m))}${e.noms ? `, номинанты будут объявлены ${esc(e.noms)}` : ""}.`);
    } else {
      for (const [cat, list] of e.cats) {
        const wins = list.filter(x => x[2]);
        if (wins.length) li.push(`<b>${esc(cat)}</b>: ${wins.map(w => filmHTML(s.films, w[0], w[1])).join("; ")}`);
      }
    }
    h += `<ul>${li.map(x => `<li>${x}</li>`).join("")}</ul></div>`;
  }
  return h;
}

const seasons = [...ctx.SEASONS].sort((a, b) => b.y0 - a.y0);
const yMin = Math.min(...seasons.map(s => s.y0)), yMax = Math.max(...seasons.map(s => s.y0)) + 1;
const block = `<!--seo:start-->
  <section class="seo-all" id="winners" aria-labelledby="winners-h">
    <details>
      <summary><h2 id="winners-h">Все победители по сезонам</h2><span>Сандэнс, Берлинале, Канны, Венеция, Торонто, Critics’ Choice, «Золотой глобус», BAFTA, Actor Awards и «Оскар» · ${yMin}–${yMax}</span></summary>
      <div class="seo-body">${seasons.map(s => `<section>${seasonHTML(s)}</section>`).join("\n")}</div>
    </details>
  </section>
  <!--seo:end-->`;

const file = path.join(ROOT, "index.html");
let html = fs.readFileSync(file, "utf8");
const re = /<!--seo:start-->[\s\S]*?<!--seo:end-->/;
if (!re.test(html)) throw new Error("В index.html нет меток <!--seo:start--> и <!--seo:end-->");
html = html.replace(re, block);
fs.writeFileSync(file, html);
console.log(`Блок победителей обновлён: сезонов ${seasons.length}, ${block.length} символов`);
