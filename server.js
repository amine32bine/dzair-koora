// جزائري كورة — Backend (Node.js 18+، بدون أي مكتبة إجبارية)
// التشغيل:  node server.js     (انسخ .env.example إلى .env وضع المفتاح إن أردت المباريات)
//
// بدون مفتاح: تعمل مواقيت الصلاة والدول والمدن (58 ولاية + دول العالم).
// مع API_FOOTBALL_KEY: المباريات المباشرة، الترتيب، الهدافون، المنتخبات، وإشعارات الأهداف.

import "./compat.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupAuth } from "./auth.js";
import { setupDevices, pushGoal, deviceCount } from "./push.js";
import { COUNTRIES } from "./places.js";
import { calc, dayTimes, next, fmt, localDate } from "./prayer.js";

// ---------- .env ----------
try {
  for (const l of fs.readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env) && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = Number(process.env.PORT) || 8080;
const AF = process.env.API_FOOTBALL_KEY || "";
const AF_BASE = process.env.AF_BASE || "https://v3.football.api-sports.io";
const POLL_MS = Number(process.env.POLL_MS) || 60_000;
const ORIGIN = process.env.CORS_ORIGIN || "*";
const TZ = "Africa/Algiers";
const ACCOUNTS_OFF = process.env.ACCOUNTS === "off"; // على الاستضافة المجانية تضيع الملفات عند كل إعادة تشغيل، فنوقف الحسابات
const TRUST_PROXY = process.env.TRUST_PROXY === "1"; // 1 عند العمل خلف Caddy/Nginx

// ---------- البطولات (تحقق من المعرّفات عبر /leagues?search= في API-Football) ----------
const BASE_CLUBS = [
  [39, "الدوري الإنجليزي"], [140, "الدوري الإسباني"], [135, "الدوري الإيطالي"], [78, "الدوري الألماني"],
  [61, "الدوري الفرنسي"], [2, "دوري أبطال أوروبا"], [3, "الدوري الأوروبي"], [848, "دوري المؤتمر الأوروبي"], [12, "دوري أبطال أفريقيا"], [20, "كأس الاتحاد الأفريقي"],
  [186, "الدوري الجزائري"], [307, "الدوري السعودي"], [233, "الدوري المصري"], [200, "الدوري المغربي"],
  [202, "الدوري التونسي"], [305, "دوري نجوم قطر"], [301, "دوري الإمارات"], [542, "الدوري العراقي"],
];
// أضف أي بطولة أخرى من .env:  EXTRA_LEAGUES=ID:الاسم,ID:الاسم   (ابحث عن المعرّف عبر /api/leagues/search?q=jordan)
const EXTRA = (process.env.EXTRA_LEAGUES || "").split(",").map((x) => x.trim()).filter(Boolean)
  .map((x) => { const k = x.indexOf(":"); return [Number(k < 0 ? x : x.slice(0, k)), k < 0 ? x : x.slice(k + 1)]; })
  .filter(([id]) => Number.isInteger(id) && id > 0);
const CLUBS = [...BASE_CLUBS, ...EXTRA];
const NATIONAL = [
  [1, "كأس العالم"], [6, "كأس أمم أفريقيا"], [36, "تصفيات أمم أفريقيا"], [29, "تصفيات المونديال - أفريقيا"],
  [32, "تصفيات المونديال - أوروبا"], [34, "تصفيات المونديال - أمريكا الجنوبية"], [4, "كأس أمم أوروبا"],
  [5, "دوري الأمم الأوروبية"], [9, "كوبا أمريكا"], [7, "كأس آسيا"], [10, "ودّيات المنتخبات"],
];
// مجموعات العرض في التطبيق
const GROUP = { 39: "top5", 140: "top5", 135: "top5", 78: "top5", 61: "top5", 2: "cups", 3: "cups", 848: "cups", 12: "africa", 20: "africa" };
const GROUP_ORDER = { top5: 0, cups: 1, arab: 2, africa: 3, national: 4 };
const NAMES = new Map([...CLUBS, ...NATIONAL]);
const EN = new Map([[39, "Premier League"], [140, "La Liga"], [135, "Serie A"], [78, "Bundesliga"], [61, "Ligue 1"], [2, "Champions League"], [3, "Europa League"], [848, "Conference League"], [12, "CAF Champions League"], [20, "CAF Confederation Cup"], [186, "Algerian Ligue 1"], [307, "Saudi Pro League"], [233, "Egyptian Premier League"], [200, "Moroccan Botola Pro"], [202, "Tunisian Ligue 1"], [305, "Qatar Stars League"], [301, "UAE Pro League"], [542, "Iraqi Premier League"], [1, "World Cup"], [6, "Africa Cup of Nations"], [36, "AFCON Qualifiers"], [29, "World Cup Qualifiers - Africa"], [32, "World Cup Qualifiers - Europe"], [34, "World Cup Qualifiers - South America"], [4, "Euro"], [5, "Nations League"], [9, "Copa América"], [7, "Asian Cup"], [10, "International Friendlies"]]);
for (const [id, n] of NAMES) if (!EN.has(id)) EN.set(id, n);
const METHODS = { mwl: [18, 17, 0, 1], eg: [19.5, 17.5, 0, 1], pk: [18, 18, 0, 2], na: [15, 15, 0, 1], uq: [18.5, 0, 90, 1] };
const KEYS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
const AR = ["الفجر", "الظهر", "العصر", "المغرب", "العشاء"];

class HttpError extends Error {
  constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; }
}

// ---------- مزوّد بيانات كرة القدم ----------
const cache = new Map();
let reqToday = 0, dayKey = "";
async function af(path, ttl = 60_000) {
  if (!AF) throw new HttpError(503, "هذه الميزة (الدوريات العربية والجزائر والمنتخبات) تحتاج مفتاح API-Football المدفوع. الدوريات الخمسة الكبرى ودوري أبطال أوروبا تعمل بمفتاح football-data المجاني.");
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== dayKey) { dayKey = day; reqToday = 0; }
  reqToday++;
  const r = await fetch(AF_BASE + path, { headers: { "x-apisports-key": AF } });
  if (!r.ok) throw new HttpError(502, `خطأ من مزوّد البيانات (${r.status})`);
  const j = await r.json();
  if (j.errors && !Array.isArray(j.errors) && Object.keys(j.errors).length) {
    const m = Object.values(j.errors).join(" ");
    if (/access to this (season|date)|free plans?/i.test(m)) throw new HttpError(402, "خطة API-Football المجانية لا تغطي الموسم الحالي. للتجربة أضف السطر SEASON=2024 في ملف .env وأعد التشغيل (بيانات موسم قديم حقيقية)، وللنتائج الحالية والحية اشترك في خطة Pro.");
    if (/request limit|rate limit/i.test(m)) throw new HttpError(429, "انتهى حد الطلبات اليومي أو في الدقيقة لحساب API-Football. انتظر أو ارفع الخطة.");
    if (/token|key/i.test(m)) throw new HttpError(401, "مفتاح API-Football غير صحيح، راجع ملف .env");
    throw new HttpError(502, m);
  }
  cache.set(path, { t: Date.now(), d: j.response || [] });
  return j.response || [];
}
setInterval(() => { for (const [k, v] of cache) if (Date.now() - v.t > 3600_000) cache.delete(k); }, 600_000).unref();

// SEASON في .env يثبّت الموسم (مثلًا 2024 للخطة المجانية التي تغطي 2022-2024 فقط)
const season = () => Number(process.env.SEASON) || (() => { const d = new Date(); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; })();
const slim = (f) => ({
  id: f.fixture.id,
  kickoff: f.fixture.date,
  status: f.fixture.status.short, // NS, 1H, HT, 2H, ET, P, FT ...
  minute: f.fixture.status.elapsed,
  league: { id: f.league.id, name: NAMES.get(f.league.id) || f.league.name, en: EN.get(f.league.id) || f.league.name, country: f.league.country },
  home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
  away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  goals: { home: f.goals.home, away: f.goals.away },
});
const known = (f) => NAMES.has(f.league.id);
const leagueId = (s) => { const id = Number(s); if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "معرّف البطولة غير صالح"); return id; };

// ---------- مزوّد football-data.org: مجاني للموسم الحالي (12 بطولة أوروبية، نتائج متأخرة قليلًا، 10 طلبات/دقيقة) ----------
const FD = process.env.FOOTBALL_DATA_KEY || "";
const FD_BASE = process.env.FD_BASE || "https://api.football-data.org/v4";
const FDMAP = { 39: "PL", 140: "PD", 135: "SA", 78: "BL1", 61: "FL1", 2: "CL", 1: "WC", 4: "EC" };
const FDREV = Object.fromEntries(Object.entries(FDMAP).map(([k, v]) => [v, Number(k)]));
const FDS = { IN_PLAY: "LIVE", PAUSED: "HT", FINISHED: "FT", AWARDED: "FT", POSTPONED: "PST", CANCELLED: "CANC", SUSPENDED: "SUSP" };
const useFd = (id) => !!(FD && FDMAP[id]);
async function fd(path, ttl = 60_000) {
  const key = "fd" + path, hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const r = await fetch(FD_BASE + path, { headers: { "X-Auth-Token": FD } });
  if (r.status === 429) throw new HttpError(429, "تجاوزت حد football-data.org (10 طلبات في الدقيقة)، انتظر قليلًا.");
  if (r.status === 400 || r.status === 401) throw new HttpError(401, "مفتاح football-data.org غير صحيح، راجع ملف .env");
  if (r.status === 403) throw new HttpError(403, "خطة football-data.org المجانية لا تشمل هذه البطولة.");
  if (!r.ok) throw new HttpError(502, `خطأ من football-data.org (${r.status})`);
  const d = await r.json();
  cache.set(key, { t: Date.now(), d });
  return d;
}
const fdSlim = (m) => {
  const lid = FDREV[m.competition?.code], ft = m.score?.fullTime || {};
  return {
    id: -m.id, kickoff: m.utcDate, status: FDS[m.status] || "NS", minute: m.minute ?? null,
    league: { id: lid, name: NAMES.get(lid) || m.competition?.name, en: EN.get(lid) || m.competition?.name, country: m.area?.name || "" },
    home: { id: m.homeTeam.id, name: m.homeTeam.shortName || m.homeTeam.name, logo: m.homeTeam.crest },
    away: { id: m.awayTeam.id, name: m.awayTeam.shortName || m.awayTeam.name, logo: m.awayTeam.crest },
    goals: { home: ft.home ?? null, away: ft.away ?? null },
  };
};
// دمج المزوّدين: نتائج API-Football أولًا، ثم football-data للبطولات التي لم تغطّها
async function merged(jobs) {
  if (!jobs.length) throw new HttpError(503, probing ? "جارٍ تهيئة المصادر المجانية، أعد المحاولة بعد لحظات" : "لا يوجد مصدر بيانات متاح لهذه البطولة الآن. يمكنك وضع FOOTBALL_DATA_KEY أو API_FOOTBALL_KEY في الإعدادات.");
  const res = await Promise.allSettled(jobs);
  const lists = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!lists.length) throw res[0].reason;
  const out = [], have = new Set();
  for (const l of lists) { const add = l.filter((x) => !have.has(x.league.id)); out.push(...add); for (const x of l) have.add(x.league.id); }
  return out;
}
const avail = (id) => (!AF && !FD && (probing || !ESPN_ON)) || !!(FD && FDMAP[id]) || !!AF || espnOK[id] === true;

// ---------- ESPN: مجاني وبدون مفتاح (مصدر غير رسمي وقد يتغيّر). يُستعمل للبطولات التي لا يغطيها المزوّدان ----------
const ESPN_ON = process.env.ESPN !== "off";
const ESPN_BASE = process.env.ESPN_BASE || "https://site.api.espn.com/apis";
const ESPN_SLUG = { 39: "eng.1", 140: "esp.1", 135: "ita.1", 78: "ger.1", 61: "fra.1", 2: "uefa.champions", 3: "uefa.europa", 848: "uefa.europa.conf", 12: "caf.champions", 20: "caf.confed", 186: "alg.1", 307: "ksa.1", 233: "egy.1", 200: "mar.1", 202: "tun.1", 305: "qat.1", 301: "uae.1", 542: "irq.1", 1: "fifa.world", 6: "caf.nations", 29: "fifa.worldq.caf", 32: "fifa.worldq.uefa", 34: "fifa.worldq.conmebol", 4: "uefa.euro", 5: "uefa.nations", 9: "conmebol.america", 10: "fifa.friendly" };
// ESPN_EXTRA=ID:slug,ID:slug  لإضافة بطولات (الـ ID هو رقم البطولة عندنا، والـ slug اسمها عند ESPN)
for (const x of (process.env.ESPN_EXTRA || "").split(",").map((v) => v.trim()).filter(Boolean)) { const [i, sl] = x.split(":"); if (Number(i) && sl) ESPN_SLUG[Number(i)] = sl; }
const espnOK = {};
let probing = true;
const useEspn = (id) => ESPN_ON && !AF && !useFd(id) && espnOK[id] === true;
const espnIds = () => Object.keys(ESPN_SLUG).map(Number).filter(useEspn);
async function espn(path, ttl = 60_000) {
  const key = "es" + path, hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const r = await fetch(ESPN_BASE + path);
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `ESPN (${r.status})`);
  const d = await r.json();
  cache.set(key, { t: Date.now(), d });
  return d;
}
async function pool(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.allSettled(items.slice(i, i + n).map(fn))));
  return out;
}
// اكتشاف تلقائي لاسم البطولة عند ESPN إن لم يصح التخمين (يقرأ قائمة كل البطولات ويبحث بحسب رمز الدولة)
const ESPN_CORE = process.env.ESPN_CORE_BASE || "https://sports.core.api.espn.com/v2";
const ESPN_PREFIX = { 186: ["alg", "dza"], 307: ["ksa", "sau"], 233: ["egy"], 200: ["mar", "mor"], 202: ["tun"], 305: ["qat"], 301: ["uae", "are"], 542: ["irq"] };
const espnDetail = {};
let espnSlugs = null;
async function discoverSlugs() {
  if (espnSlugs) return espnSlugs;
  const r = await fetch(`${ESPN_CORE}/sports/soccer/leagues?limit=1000`);
  if (!r.ok) throw new Error("core " + r.status);
  const j = await r.json();
  espnSlugs = (j.items || []).map((x) => (String(x.$ref || "").match(/leagues\/([^?/]+)/) || [])[1]).filter(Boolean);
  return espnSlugs;
}
async function probeOne(id) {
  const tried = [];
  let err = "";
  const test = async (slug) => {
    tried.push(slug);
    try { const d = await espn(`/site/v2/sports/soccer/${slug}/scoreboard`, 0); return Array.isArray(d.events) || Array.isArray(d.leagues); }
    catch (e) { err = e.message; return false; }
  };
  espnOK[id] = await test(ESPN_SLUG[id]);
  if (!espnOK[id] && ESPN_PREFIX[id]) {
    try {
      const all = await discoverSlugs(), pre = ESPN_PREFIX[id];
      const cands = [...new Set([...pre.map((p) => p + ".1"), ...all.filter((x) => pre.some((p) => x.startsWith(p + ".")))])].filter((x) => all.includes(x) && !tried.includes(x)).slice(0, 4);
      for (const c of cands) if (await test(c)) { ESPN_SLUG[id] = c; espnOK[id] = true; break; }
    } catch (e) { err = "discover: " + e.message; }
  }
  espnDetail[id] = { slug: ESPN_SLUG[id], ok: espnOK[id], tried, error: espnOK[id] ? "" : err };
  if (process.env.DEBUG && !espnOK[id]) console.error("ESPN probe", id, tried.join(","), err);
}
async function probeEspn(onlyFailed = false) {
  if (!ESPN_ON) { probing = false; return; }
  const ids = Object.keys(ESPN_SLUG).map(Number).filter((id) => !onlyFailed || espnOK[id] !== true);
  await pool(ids, 4, probeOne);
  probing = false;
  console.log("ESPN المتاح:", Object.keys(espnOK).filter((k) => espnOK[k]).join(",") || "لا شيء");
}
probeEspn();
setInterval(() => probeEspn(true), 10 * 60_000).unref(); // إعادة فحص ما فشل (قد يكون انقطاعًا مؤقتًا)
setInterval(() => probeEspn(false), 12 * 3600_000).unref();
const espnScorer = new Map();
function espnSlim(ev, lid) {
  const c = ev.competitions?.[0] || {}, cs = c.competitors || [];
  const h = cs.find((x) => x.homeAway === "home") || cs[0] || {}, a = cs.find((x) => x.homeAway === "away") || cs[1] || {};
  const st = ev.status?.type || {}, state = st.state, nm = st.name || "";
  const status = nm === "STATUS_HALFTIME" ? "HT" : state === "in" ? "LIVE" : state === "post" ? "FT" : /POSTPONED/.test(nm) ? "PST" : /CANCEL/.test(nm) ? "CANC" : "NS";
  const id = -(3e9 + Number(ev.id));
  const team = (x) => ({ id: Number(x.team?.id) || 0, name: x.team?.displayName || x.team?.shortDisplayName || "", logo: x.team?.logo || "" });
  const plays = (c.details || []).filter((d) => d.scoringPlay);
  if (plays.length) {
    const p = plays[plays.length - 1], tm = cs.find((x) => String(x.team?.id) === String(p.team?.id));
    espnScorer.set(id, { player: p.athletesInvolved?.[0]?.displayName || "", minute: parseInt(p.clock?.displayValue) || "", team: tm?.team?.displayName || "", type: p.type?.text || "Goal" });
  }
  const score = (x) => (state === "pre" ? null : Number(x.score));
  return { id, kickoff: ev.date, status, minute: state === "in" ? parseInt(ev.status?.displayClock) || null : null,
    league: { id: lid, name: NAMES.get(lid), en: EN.get(lid) || NAMES.get(lid), country: "" }, home: team(h), away: team(a), goals: { home: score(h), away: score(a) } };
}
const espnPath = (id, date) => `/site/v2/sports/soccer/${ESPN_SLUG[id]}/scoreboard` + (date ? `?dates=${date.replace(/-/g, "")}` : "");
async function espnDay(id, date) { return ((await espn(espnPath(id, date), 5 * 60_000)).events || []).map((e) => espnSlim(e, id)); }
async function espnLive() {
  const res = await pool(espnIds(), 5, async (id) => {
    let evs = (await espn(espnPath(id), 5 * 60_000)).events || [];
    const active = evs.some((e) => { const s = e.status?.type?.state, d = Date.parse(e.date) - Date.now(); return s === "in" || (s === "pre" && d < 15 * 60_000 && d > -4 * 3600_000); });
    if (active) evs = (await espn(espnPath(id), Number(process.env.ESPN_LIVE_TTL ?? 40_000))).events || [];
    return evs.map((e) => espnSlim(e, id)).filter((x) => x.status === "LIVE" || x.status === "HT");
  });
  return res.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
}
async function espnStandings(lid) {
  const d = await espn(`/v2/sports/soccer/${ESPN_SLUG[lid]}/standings`, 10 * 60_000);
  const stat = (e, ...ns) => { for (const n of ns) { const x = (e.stats || []).find((y) => y.name === n || y.abbreviation === n); if (x && x.value != null) return Number(x.value); } return null; };
  const groups = d.children?.length ? d.children : [d];
  const tables = groups.map((g) => (g.standings?.entries || []).map((e, i) => ({
    rank: stat(e, "rank") || i + 1, team: { id: Number(e.team?.id) || 0, name: e.team?.displayName || e.team?.shortDisplayName || "", logo: e.team?.logos?.[0]?.href || "" },
    points: stat(e, "points", "P") ?? 0, played: stat(e, "gamesPlayed", "GP") ?? 0, won: stat(e, "wins", "W") ?? 0, drawn: stat(e, "ties", "D") ?? 0, lost: stat(e, "losses", "L") ?? 0,
    goalsFor: stat(e, "pointsFor", "F"), goalsAgainst: stat(e, "pointsAgainst", "A"), goalDiff: stat(e, "pointDifferential", "GD"), form: "",
  })).sort((x, y) => x.rank - y.rank)).filter((t) => t.length);
  return { league: { id: lid, name: NAMES.get(lid), en: EN.get(lid) || NAMES.get(lid) }, season: d.season?.year ?? null, table: tables[0] || [], tables };
}

// ---------- مواقيت الصلاة ----------
const ymd = (tz, ms = Date.now()) => { const d = localDate(tz, ms); return `${d[0]}-${String(d[1] + 1).padStart(2, "0")}-${String(d[2]).padStart(2, "0")}`; };
function placeFrom(q) {
  if (q.has("lat") && q.has("lng")) {
    const lat = Number(q.get("lat")), lng = Number(q.get("lng")), tz = q.get("tz") || "UTC";
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 66 || Math.abs(lng) > 180) throw new HttpError(400, "إحداثيات غير صالحة");
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { throw new HttpError(400, "منطقة زمنية غير صالحة (مثال: Africa/Algiers)"); }
    const mt = METHODS[q.get("method") || "mwl"];
    if (!mt) throw new HttpError(400, "طريقة غير معروفة: " + Object.keys(METHODS).join(", "));
    return { n: "", country: "", lat, lng, tz, mt };
  }
  const K = COUNTRIES[Number(q.get("country") ?? 0)];
  const c = K?.c[Number(q.get("city") ?? 0)];
  if (!c) throw new HttpError(404, "دولة أو مدينة غير موجودة. راجع /api/countries");
  return { ...c, mt: K.m, country: K.n };
}
const dayObj = (p, t) => Object.fromEntries(KEYS.map((k, i) => [k, { name: AR[i], time: fmt(p.tz, t[i]), iso: new Date(t[i]).toISOString() }]));

function prayerToday(q) {
  const p = placeFrom(q), now = Date.now();
  let ms = now, date = null;
  if (q.get("date")) {
    const m = q.get("date").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new HttpError(400, "التاريخ بصيغة YYYY-MM-DD");
    ms = Date.UTC(+m[1], +m[2] - 1, +m[3], 12); date = q.get("date");
  }
  const t = dayTimes(p, 0, ms);
  const out = { place: { city: p.n, country: p.country, lat: p.lat, lng: p.lng, tz: p.tz }, date: date || ymd(p.tz, now), times: dayObj(p, t) };
  if (!date) {
    const n = next(p, now);
    out.next = { key: KEYS[n.i], name: AR[n.i], time: fmt(p.tz, n.at), iso: new Date(n.at).toISOString(), secondsLeft: Math.max(0, Math.round((n.at - now) / 1000)) };
  }
  return out;
}
function prayerMonth(q) {
  const p = placeFrom(q), cur = localDate(p.tz);
  let y = cur[0], m = cur[1];
  if (q.get("month")) {
    const x = q.get("month").match(/^(\d{4})-(\d{2})$/);
    if (!x || +x[2] < 1 || +x[2] > 12) throw new HttpError(400, "الشهر بصيغة YYYY-MM");
    y = +x[1]; m = +x[2] - 1;
  }
  const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), days = [];
  for (let d = 1; d <= n; d++) {
    const t = calc(y, m, d, p.lat, p.lng, p.mt);
    days.push({ date: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`, ...Object.fromEntries(KEYS.map((k, i) => [k, fmt(p.tz, t[i])])) });
  }
  return { place: { city: p.n, country: p.country, tz: p.tz }, days };
}

// ---------- بث النتائج المباشرة وإشعارات الأهداف: SSE + Firebase (اختياري) ----------
const clients = new Set();
const seen = new Map();
let liveSnap = [];
let fcm = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const { initializeApp, applicationDefault } = await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");
    initializeApp({ credential: applicationDefault() });
    fcm = getMessaging();
    console.log("إشعارات Firebase مفعّلة");
  } catch (e) { console.error("Firebase معطّل (نفّذ npm install):", e.message); }
}

const wants = (c, fx) =>
  (!c.leagues || c.leagues.has(fx.league.id)) && (!c.teams || c.teams.has(fx.home.id) || c.teams.has(fx.away.id));
function send(event, data, fixtures) {
  for (const c of clients) {
    const list = fixtures ? fixtures.filter((fx) => wants(c, fx)) : null;
    if (list && !list.length) continue;
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(list ? { ...data, fixtures: list } : data)}\n\n`);
  }
}
async function liveFixtures(ttl = 20_000) {
  const jobs = [];
  if (AF) jobs.push(af("/fixtures?live=all", ttl).then((r) => r.filter(known).map(slim)));
  if (espnIds().length) jobs.push(espnLive());
  if (FD) jobs.push(fd("/matches?status=LIVE", Math.max(ttl, Number(process.env.FD_MIN_TTL ?? 30_000))).then((d) => (d.matches || []).map(fdSlim).filter((x) => x.league.id)));
  return merged(jobs);
}
async function scorerOf(fx) {
  if (espnScorer.has(fx.id)) return espnScorer.get(fx.id);
  if (fx.id > 0 && AF) {
    try {
      const ev = await af(`/fixtures/events?fixture=${fx.id}&type=Goal`, 0);
      const g = ev.filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty").pop();
      if (g) return { player: g.player?.name || "", minute: g.time.elapsed, team: g.team?.name || "", type: g.detail };
    } catch {}
  }
  return { player: "", minute: fx.minute || "", team: "", type: "Goal" };
}
async function emitGoal(fx) {
  const scorer = await scorerOf(fx);
  send("goal", { type: "goal", at: new Date().toISOString(), fixture: fx, scorer }, [fx]);
  if (fcm) {
    const body = `${fx.home.name} ${fx.goals.home ?? 0} - ${fx.goals.away ?? 0} ${fx.away.name}` + (scorer.player ? `\n${scorer.player} ${scorer.minute}'` : "");
    pushGoal(fcm, { leagueId: fx.league.id, fixtureId: fx.id, title: "⚽ هدف!", body }).catch((e) => console.error("fcm:", e.message));
  }
  console.log("هدف:", fx.home.name, fx.goals.home, "-", fx.goals.away, fx.away.name);
}
async function pollGoals() {
  if ((!AF && !FD && !(ESPN_ON && espnIds().length)) || (!clients.size && !(fcm && deviceCount()))) { seen.clear(); liveSnap = []; return; }
  try {
    const res = await liveFixtures(0);
    liveSnap = res;
    const changed = [];
    for (const fx of res) {
      const cur = { h: fx.goals.home ?? 0, a: fx.goals.away ?? 0, s: fx.status, m: fx.minute };
      const prev = seen.get(fx.id);
      if (prev && (cur.h > prev.h || cur.a > prev.a)) await emitGoal(fx);
      if (!prev || prev.s !== cur.s || prev.m !== cur.m || prev.h !== cur.h || prev.a !== cur.a) changed.push(fx);
      seen.set(fx.id, cur);
    }
    if (changed.length) send("live", { type: "live" }, changed); // تحديث الدقيقة والنتيجة
    const ids = new Set(res.map((x) => x.id)), done = [];
    for (const k of seen.keys()) if (!ids.has(k)) { seen.delete(k); done.push(k); }
    if (done.length) send("finished", { type: "finished", ids: done });
  } catch (e) { console.error("poll:", e.message); }
}
setInterval(pollGoals, POLL_MS);
setInterval(() => { for (const c of clients) c.res.write(": ping\n\n"); }, 25_000).unref();

// ---------- المسارات ----------
const routes = [];
const add = (m) => (re, h) => routes.push([m, re, h]);
const get = add("GET"), post = add("POST"), put = add("PUT"), del = add("DELETE");

get(/^\/api\/health$/, () => ({ ok: true, football: !!(AF || FD || espnIds().length), accounts: !ACCOUNTS_OFF, espn: ESPN_ON, providers: { apiFootball: !!AF, footballData: !!FD }, season: season(), push: !!fcm, sseClients: clients.size, requestsToday: reqToday }));
get(/^\/api\/espn\/check$/, () => ({ enabled: ESPN_ON, probing, detail: espnDetail, available: Object.keys(espnOK).filter((k) => espnOK[k]).map(Number), unavailable: Object.keys(espnOK).filter((k) => !espnOK[k]).map(Number) }));
get(/^\/api\/countries$/, () => COUNTRIES.map((c, i) => ({ id: i, name: c.n, iso: c.iso, cities: c.c.length })));
get(/^\/api\/countries\/(\d+)\/cities$/, (q, [k]) => {
  const K = COUNTRIES[+k];
  if (!K) throw new HttpError(404, "دولة غير موجودة");
  return K.c.map((c, i) => ({ id: i, name: c.n, en: c.en, lat: c.lat, lng: c.lng, tz: c.tz }));
});
get(/^\/api\/prayer$/, (q) => prayerToday(q));
get(/^\/api\/prayer\/month$/, (q) => prayerMonth(q));
get(/^\/api\/leagues$/, (q) => [
  ...CLUBS.map(([id, name]) => ({ id, name, en: EN.get(id) || name, type: "club", group: GROUP[id] || "arab" })),
  ...NATIONAL.map(([id, name]) => ({ id, name, en: EN.get(id) || name, type: "national", group: "national" })),
].filter((l) => q.get("all") || avail(l.id)).sort((x, y) => GROUP_ORDER[x.group] - GROUP_ORDER[y.group]));
get(/^\/api\/leagues\/search$/, async (q) => {
  const t = (q.get("q") || "").trim();
  if (t.length < 3) throw new HttpError(400, "اكتب 3 أحرف على الأقل (بالإنجليزية، مثل: jordan)");
  const r = await af(`/leagues?search=${encodeURIComponent(t)}`, 24 * 3600_000);
  return r.slice(0, 30).map((x) => ({ id: x.league.id, name: x.league.name, type: x.league.type, country: x.country?.name, logo: x.league.logo }));
});
get(/^\/api\/live$/, async (q) => {
  if (q.get("all") && AF && !FD) return (await af("/fixtures?live=all", 20_000)).map(slim);
  return liveFixtures(20_000);
});
get(/^\/api\/matches$/, async (q) => {
  const date = q.get("date") || ymd(TZ);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "التاريخ بصيغة YYYY-MM-DD");
  const lg = q.get("league") ? leagueId(q.get("league")) : null;
  const jobs = [];
  if (lg ? useEspn(lg) : espnIds().length) jobs.push(pool(lg ? [lg] : espnIds(), 5, (id) => espnDay(id, date)).then((r) => r.filter((x) => x.status === "fulfilled").flatMap((x) => x.value)));
  if (AF && !(lg && useFd(lg))) {
    const path = `/fixtures?date=${date}&timezone=${TZ}` + (lg ? `&league=${lg}&season=${season()}` : "");
    jobs.push(af(path, 5 * 60_000).then((r) => (lg ? r : r.filter(known)).map(slim)));
  }
  if (FD && (!lg || useFd(lg))) {
    const p = lg ? `/competitions/${FDMAP[lg]}/matches` : "/matches";
    jobs.push(fd(`${p}?dateFrom=${date}&dateTo=${date}`, 2 * 60_000).then((d) => (d.matches || []).map(fdSlim).filter((x) => x.league.id)));
  }
  return (await merged(jobs)).sort((x, y) => String(x.kickoff).localeCompare(String(y.kickoff)));
});
get(/^\/api\/standings\/(\d+)$/, async (q, [id]) => {
  const lid = leagueId(id);
  if (useEspn(lid)) return espnStandings(lid);
  if (useFd(lid)) {
    const d = await fd(`/competitions/${FDMAP[lid]}/standings`, 10 * 60_000);
    const row = (x) => ({ rank: x.position, team: { id: x.team.id, name: x.team.shortName || x.team.name, logo: x.team.crest }, points: x.points, played: x.playedGames, won: x.won, drawn: x.draw, lost: x.lost, goalsFor: x.goalsFor, goalsAgainst: x.goalsAgainst, goalDiff: x.goalDifference, form: x.form });
    const tables = (d.standings || []).filter((t) => t.type === "TOTAL").map((t) => t.table.map(row));
    return { league: { id: lid, name: NAMES.get(lid) || d.competition?.name }, season: Number(String(d.season?.startDate || "").slice(0, 4)) || null, table: tables[0] || [], tables };
  }
  const r = await af(`/standings?league=${lid}&season=${season()}`, 10 * 60_000);
  const row = (x) => ({ rank: x.rank, team: { id: x.team.id, name: x.team.name, logo: x.team.logo }, points: x.points, played: x.all.played, won: x.all.win, drawn: x.all.draw, lost: x.all.lose, goalsFor: x.all.goals.for, goalsAgainst: x.all.goals.against, goalDiff: x.goalsDiff, form: x.form });
  const tables = (r[0]?.league?.standings || []).map((t) => t.map(row));
  return { league: { id: lid, name: NAMES.get(lid) || r[0]?.league?.name }, season: season(), table: tables[0] || [], tables };
});
const players = (kind) => async (q, [id]) => {
  const lid = leagueId(id);
  if (useEspn(lid)) return []; // قوائم الهدافين غير متاحة مجانًا من هذا المصدر
  if (useFd(lid)) {
    const d = await fd(`/competitions/${FDMAP[lid]}/scorers?limit=50`, 10 * 60_000);
    let l = (d.scorers || []).map((x) => ({ player: { id: x.player.id, name: x.player.name, photo: "" }, team: { id: x.team.id, name: x.team.shortName || x.team.name, logo: x.team.crest }, goals: x.goals ?? 0, assists: x.assists ?? 0, played: x.playedMatches ?? 0 }));
    if (kind === "assists") l = l.filter((x) => x.assists > 0).sort((x, y) => y.assists - x.assists);
    return l.slice(0, 20).map((x, i) => ({ rank: i + 1, ...x }));
  }
  const r = await af(`/players/top${kind}?league=${lid}&season=${season()}`, 10 * 60_000);
  return r.map((x, i) => { const st = x.statistics[0]; return { rank: i + 1, player: { id: x.player.id, name: x.player.name, photo: x.player.photo }, team: { id: st.team.id, name: st.team.name, logo: st.team.logo }, goals: st.goals.total ?? 0, assists: st.goals.assists ?? 0, played: st.games.appearences ?? 0 }; });
};
get(/^\/api\/scorers\/(\d+)$/, players("scorers"));
get(/^\/api\/assists\/(\d+)$/, players("assists"));
async function nationalAF(n) {
  const t = (await af(`/teams?search=${encodeURIComponent(n)}`, 24 * 3600_000)).find((x) => x.team.national);
  if (!t) throw new HttpError(404, "لم يُعثر على منتخب بهذا الاسم (استعمل الاسم الإنجليزي مثل Algeria)");
  const [last, nxt] = await Promise.all([af(`/fixtures?team=${t.team.id}&last=10&timezone=${TZ}`, 10 * 60_000), af(`/fixtures?team=${t.team.id}&next=10&timezone=${TZ}`, 10 * 60_000)]);
  return { team: { id: t.team.id, name: t.team.name, logo: t.team.logo }, last: last.map(slim), next: nxt.map(slim) };
}
// بديل مجاني: مباريات المنتخب في كأس العالم فقط (football-data.org)
async function nationalFD(n) {
  const d = await fd("/competitions/WC/matches", 10 * 60_000);
  const me = (t) => t && [t.name, t.shortName, t.tla].some((x) => x && String(x).toLowerCase() === n.toLowerCase());
  const ms = (d.matches || []).filter((m) => me(m.homeTeam) || me(m.awayTeam));
  if (!ms.length) throw new HttpError(404, "لا مباريات لهذا المنتخب في كأس العالم (الأسماء بالإنجليزية، مثل Algeria). نتائج الودّيات والتصفيات تحتاج API_FOOTBALL_KEY المدفوع.");
  const t = me(ms[0].homeTeam) ? ms[0].homeTeam : ms[0].awayTeam;
  const sl = ms.map(fdSlim), byT = (a, b) => String(a.kickoff).localeCompare(String(b.kickoff));
  return {
    team: { id: t.id, name: t.name, logo: t.crest },
    last: sl.filter((x) => x.status === "FT").sort((a, b) => byT(b, a)).slice(0, 10),
    next: sl.filter((x) => x.status !== "FT").sort(byT).slice(0, 10),
    note: "نتائج كأس العالم فقط. الودّيات والتصفيات تحتاج مفتاح API-Football المدفوع.",
  };
}
// مباريات المنتخب من ESPN (مجاني): الودّيات والتصفيات وأمم أفريقيا وكأس العالم... خلال 90 يومًا ماضية و120 قادمة
async function nationalESPN(n) {
  const ids = NATIONAL.map(([id]) => id).filter((id) => espnOK[id] === true && ESPN_SLUG[id]);
  if (!ids.length) throw new HttpError(404, "مصدر ESPN غير متاح لبطولات المنتخبات الآن");
  const f = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
  const range = `${f(Date.now() - 90 * 864e5)}-${f(Date.now() + 120 * 864e5)}`;
  const same = (x) => String(x || "").toLowerCase() === n.toLowerCase();
  const res = await pool(ids, 5, async (id) => ((await espn(`/site/v2/sports/soccer/${ESPN_SLUG[id]}/scoreboard?dates=${range}&limit=400`, 10 * 60_000)).events || []).map((e) => espnSlim(e, id)));
  const all = res.filter((r) => r.status === "fulfilled").flatMap((r) => r.value).filter((x) => same(x.home.name) || same(x.away.name));
  if (!all.length) throw new HttpError(404, "لا مباريات لهذا المنتخب في الفترة القريبة (الأسماء بالإنجليزية، مثل Algeria)");
  const side = same(all[0].home.name) ? all[0].home : all[0].away, byT = (a, b) => String(a.kickoff).localeCompare(String(b.kickoff));
  return {
    team: { id: side.id, name: n, logo: side.logo },
    last: all.filter((x) => x.status === "FT").sort((a, b) => byT(b, a)).slice(0, 10),
    next: all.filter((x) => x.status !== "FT").sort(byT).slice(0, 10),
    note: "المصدر: ESPN (مجاني)، وقد لا يشمل كل المباريات.",
  };
}
get(/^\/api\/national\/([^/]+)$/, async (q, [name]) => {
  const n = decodeURIComponent(name);
  if (AF) { try { return await nationalAF(n); } catch (e) { if (!FD && !ESPN_ON) throw e; } }
  if (ESPN_ON && NATIONAL.some(([id]) => espnOK[id])) { try { return await nationalESPN(n); } catch (e) { if (!FD) throw e; } }
  if (FD) return nationalFD(n);
  throw new HttpError(503, "ضع FOOTBALL_DATA_KEY (مجاني) أو API_FOOTBALL_KEY في ملف .env");
});
setupAuth({ get, post, put, del, HttpError, COUNTRIES });
setupDevices({ post, del, HttpError });
const INDEX = ["GET /api/health", "GET /api/countries", "GET /api/countries/:id/cities",
  "GET /api/prayer?country=0&city=10  أو  ?lat=36.75&lng=3.06&tz=Africa/Algiers&method=mwl  [&date=YYYY-MM-DD]",
  "GET /api/prayer/month?country=0&city=10[&month=YYYY-MM]", "GET /api/leagues", "GET /api/leagues/search?q=jordan",
  "GET /api/live", "GET /api/matches[?date=YYYY-MM-DD&league=ID]", "GET /api/standings/:leagueId",
  "GET /api/scorers/:leagueId", "GET /api/assists/:leagueId", "GET /api/national/:name  (مثال: Algeria)",
  "GET /api/stream[?leagues=39,186&teams=1532]  (SSE: أحداث live وgoal وfinished)",
  "POST /api/auth/register|verify|resend|login|forgot|reset", "POST|DELETE /api/devices  (تسجيل جهاز للإشعارات)", "GET|PUT|DELETE /api/me   PUT /api/me/settings"];
get(/^\/api$/, () => ({ name: "Dzair Koora API", developer: "عبد القادر أمين — الجزائر", endpoints: INDEX }));

// ---------- الخادم ----------
const PUB = path.resolve(fileURLToPath(new URL("./public/", import.meta.url)));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === "/") p = "/index.html";
  if (p === "/privacy") p = "/privacy.html";
  const f = path.resolve(PUB, "." + p);
  if (f !== PUB && !f.startsWith(PUB + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.statusCode = 404; res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.end("غير موجود"); }
    res.setHeader("Content-Type", MIME[path.extname(f)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on("data", (d) => { n += d.length; if (n > 20_000) { no(new HttpError(413, "الطلب كبير")); req.destroy(); return; } c.push(d); });
    req.on("end", () => {
      if (!c.length) return ok({});
      try { const j = JSON.parse(Buffer.concat(c).toString()); ok(j && typeof j === "object" ? j : {}); }
      catch { no(new HttpError(400, "JSON غير صالح")); }
    });
    req.on("error", no);
  });
}

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const csv = (x) => (x ? new Set(x.split(",").map(Number).filter(Number.isFinite)) : null);
const tooMany = (res) => { res.statusCode = 429; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end('{"error":"طلبات كثيرة، حاول بعد دقيقة"}'); };

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  const u = new URL(req.url, "http://x"), q = u.searchParams, ip = (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
  const bump = (k) => { const n = (hits.get(k) || 0) + 1; hits.set(k, n); return n; };
  if (bump(ip) > 300 || (u.pathname.startsWith("/api/auth/") && bump(ip + "|auth") > 20)) return tooMany(res);

  if (req.method === "GET" && u.pathname === "/api/stream") {
    if (!AF && !FD && !ESPN_ON) { res.statusCode = 503; res.setHeader("Content-Type", "application/json; charset=utf-8"); return res.end('{"error":"ضع FOOTBALL_DATA_KEY أو API_FOOTBALL_KEY في .env"}'); }
    if (clients.size >= 3000) { res.statusCode = 503; res.setHeader("Content-Type", "application/json; charset=utf-8"); return res.end('{"error":"الخادم مشغول"}'); }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const c = { res, leagues: csv(q.get("leagues")), teams: csv(q.get("teams")) };
    clients.add(c);
    res.write("event: ready\ndata: {}\n\n");
    const first = liveSnap.filter((fx) => wants(c, fx));
    if (first.length) res.write(`event: live\ndata: ${JSON.stringify({ type: "live", snapshot: true, fixtures: first })}\n\n`);
    if (clients.size === 1) pollGoals();
    return req.on("close", () => clients.delete(c));
  }
  if (!u.pathname.startsWith("/api")) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; return res.end(); }
    return serveStatic(req, res, u.pathname);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    if (ACCOUNTS_OFF && (u.pathname.startsWith("/api/auth/") || u.pathname.startsWith("/api/me") || u.pathname.startsWith("/api/devices"))) throw new HttpError(503, "الحسابات متوقفة مؤقتًا في هذه النسخة التجريبية");
    const body = req.method === "GET" ? {} : await readBody(req);
    for (const [m, re, h] of routes) {
      if (m !== req.method) continue;
      const mt = u.pathname.match(re);
      if (mt) return res.end(JSON.stringify(await h(q, mt.slice(1), { req, body })));
    }
    throw new HttpError(404, "مسار غير موجود. راجع /api");
  } catch (e) {
    res.statusCode = e.status || 500;
    if (!e.status) console.error(e);
    res.end(JSON.stringify(e.status ? { error: e.message, ...e.extra } : { error: "خطأ داخلي" }));
  }
}).listen(PORT, () => {
  console.log(`\nجزائري كورة يعمل — افتح http://localhost:${PORT}  (التطبيق)  و http://localhost:${PORT}/api  (الـ API)`);
  console.log(`المباريات: ${AF || FD ? `مفعّلة (${[FD && "football-data", AF && "API-Football"].filter(Boolean).join(" + ")})` : "معطّلة (ضع FOOTBALL_DATA_KEY أو API_FOOTBALL_KEY في .env)"} | البريد: ${process.env.RESEND_API_KEY || process.env.BREVO_API_KEY ? "مفعّل" : "تجريبي (الرموز تُطبع هنا)"}\n`);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
