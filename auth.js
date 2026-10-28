// حسابات المستخدمين بالبريد الإلكتروني: تسجيل، تأكيد برمز، دخول، نسيان كلمة المرور، حذف الحساب.
// بدون أي مكتبة خارجية. التخزين في data/users.json (للإنتاج الكبير انقله إلى قاعدة بيانات).
// إرسال البريد: Resend أو Brevo عبر HTTP. بدون مفتاح يُطبع الرمز في نافذة الخادم (للتجربة).

import "./compat.js";
import crypto from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const DIR = new URL("./data/", import.meta.url);
fs.mkdirSync(DIR, { recursive: true });
const FILE = new URL("users.json", DIR);

// تخزين دائم مجاني: ضع UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN (من upstash.com) فتبقى الحسابات حتى لو أُعيد تشغيل الخادم.
// بدونهما يُستعمل ملف data/users.json (يُمسح على الاستضافة المجانية عند كل نوم).
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""), KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_KV = !!(KV_URL && KV_TOKEN);
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "KV " + r.status);
  return j.result;
}
const saved = new Map(); // email -> آخر JSON محفوظ
let DB = { users: {} };
if (USE_KV) {
  try {
    const a = (await kv(["HGETALL", "dk:users"])) || [];
    for (let i = 0; i + 1 < a.length; i += 2) { DB.users[a[i]] = JSON.parse(a[i + 1]); saved.set(a[i], a[i + 1]); }
    console.log("الحسابات: تخزين دائم (Upstash)، عدد المستخدمين:", Object.keys(DB.users).length);
  } catch (e) { console.error("تعذّر تحميل الحسابات من Upstash:", e.message); }
} else {
  try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
}
async function flushKV() {
  for (const [e, u] of Object.entries(DB.users)) {
    const j = JSON.stringify(u);
    if (saved.get(e) !== j) { await kv(["HSET", "dk:users", e, j]); saved.set(e, j); }
  }
  for (const e of [...saved.keys()]) if (!DB.users[e]) { await kv(["HDEL", "dk:users", e]); saved.delete(e); }
}
let timer = null;
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (USE_KV) return flushKV().catch((e) => console.error("حفظ الحسابات:", e.message));
    const tmp = new URL("users.json.tmp", DIR);
    fs.writeFileSync(tmp, JSON.stringify(DB));
    fs.renameSync(tmp, FILE);
  }, 300);
}

function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = new URL("secret", DIR);
  try { return fs.readFileSync(f, "utf8"); } catch {}
  const s = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = secret();

// ---------- JWT (HS256) ----------
const url64 = (b) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); // base64url متوافق مع Node القديم
const b64 = (x) => url64(Buffer.from(x));
const mac = (d) => url64(crypto.createHmac("sha256", SECRET).update(d).digest());
function signToken(email) {
  const d = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64(JSON.stringify({ sub: email, exp: Date.now() + 30 * 864e5 }));
  return d + "." + mac(d);
}
function verifyToken(t) {
  const p = String(t || "").split(".");
  if (p.length !== 3) return null;
  const a = Buffer.from(mac(p[0] + "." + p[1])), b = Buffer.from(p[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const j = JSON.parse(Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return j.exp > Date.now() ? j : null;
  } catch { return null; }
}

// ---------- كلمات المرور والرموز ----------
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return "scrypt$" + salt.toString("hex") + "$" + (await scrypt(pw, salt, 64)).toString("hex");
}
async function checkPw(pw, stored) {
  const [, salt, h] = String(stored || "").split("$");
  if (!salt || !h) return false;
  const d = await scrypt(pw, Buffer.from(salt, "hex"), 64), e = Buffer.from(h, "hex");
  return d.length === e.length && crypto.timingSafeEqual(d, e);
}
const codeHash = (email, code) => crypto.createHmac("sha256", SECRET).update(email + ":" + code).digest("hex");

// ---------- إرسال البريد ----------
async function sendMail(to, subject, text) {
  const from = process.env.MAIL_FROM;
  try {
    if (process.env.RESEND_API_KEY && from) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!r.ok) console.error("Resend:", r.status, await r.text());
      return;
    }
    if (process.env.BREVO_API_KEY && from) {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ sender: { email: from, name: "جزائري كورة" }, to: [{ email: to }], subject, textContent: text }),
      });
      if (!r.ok) console.error("Brevo:", r.status, await r.text());
      return;
    }
  } catch (e) { console.error("mail:", e.message); return; }
  console.log(`\n[بريد تجريبي — لم يُضبط مزوّد بريد] إلى: ${to}\n${subject}\n${text}\n`);
}

// ---------- المسارات ----------
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const normEmail = (e) => { const x = String(e ?? "").trim().toLowerCase(); return x.length <= 254 && EMAIL.test(x) ? x : ""; };
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const defaults = () => ({ country: 0, city: 0, leagues: [], teams: [] });
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, settings: u.settings });

export function setupAuth({ post, get, put, del, HttpError, COUNTRIES }) {
  async function issueCode(u, purpose) {
    if (u.code && Date.now() - u.code.at < 60_000) throw new HttpError(429, "انتظر دقيقة قبل طلب رمز جديد");
    const code = String(crypto.randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, "0");
    u.code = { h: codeHash(u.email, code), exp: Date.now() + 15 * 60_000, tries: 0, purpose, at: Date.now() };
    persist();
    const v = purpose === "verify";
    await sendMail(u.email,
      v ? "رمز تأكيد حسابك · Verification code · Code de vérification" : "رمز إعادة تعيين كلمة المرور · Password reset code · Code de réinitialisation",
      `رمزك: ${code}\nصالح لمدة 15 دقيقة. إذا لم تطلبه فتجاهل هذه الرسالة.\n\n` +
      `Your code: ${code}\nValid for 15 minutes. If you did not request it, ignore this message.\n\n` +
      `Votre code : ${code}\nValable 15 minutes. Si vous ne l'avez pas demandé, ignorez ce message.\n\n— جزائري كورة`);
  }
  function checkCode(u, purpose, code) {
    const c = u.code;
    if (!c || c.purpose !== purpose || c.exp < Date.now()) throw new HttpError(400, "الرمز منتهي أو غير صالح، اطلب رمزًا جديدًا");
    if (++c.tries > 5) { u.code = null; persist(); throw new HttpError(429, "محاولات كثيرة، اطلب رمزًا جديدًا"); }
    const a = Buffer.from(codeHash(u.email, String(code ?? "").trim())), b = Buffer.from(c.h);
    persist();
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(400, "الرمز غير صحيح");
    u.code = null;
  }
  const authed = (ctx) => {
    const h = ctx.req.headers.authorization || "";
    const p = verifyToken(h.startsWith("Bearer ") ? h.slice(7) : "");
    const u = p && DB.users[p.sub];
    if (!u || !u.verified) throw new HttpError(401, "سجّل الدخول أولًا");
    return u;
  };

  post(/^\/api\/auth\/register$/, async (q, _, { body }) => {
    const email = normEmail(body.email), pw = String(body.password ?? ""), name = str(body.name, 50);
    if (!email) throw new HttpError(400, "بريد إلكتروني غير صالح");
    if (pw.length < 8 || pw.length > 128) throw new HttpError(400, "كلمة المرور 8 أحرف على الأقل");
    if (!name) throw new HttpError(400, "الاسم مطلوب");
    const old = DB.users[email];
    if (old?.verified) throw new HttpError(409, "هذا البريد مسجّل مسبقًا، سجّل الدخول");
    const u = old || (DB.users[email] = { id: crypto.randomBytes(16).toString("hex"), email, created: Date.now(), settings: defaults() });
    u.name = name; u.hash = await hashPw(pw); u.verified = false;
    await issueCode(u, "verify");
    return { ok: true, verify: true };
  });
  post(/^\/api\/auth\/verify$/, async (q, _, { body }) => {
    const u = DB.users[normEmail(body.email)];
    if (!u) throw new HttpError(400, "الرمز غير صحيح");
    checkCode(u, "verify", body.code);
    u.verified = true; persist();
    return { token: signToken(u.email), user: pub(u) };
  });
  post(/^\/api\/auth\/resend$/, async (q, _, { body }) => {
    const u = DB.users[normEmail(body.email)];
    if (u && !u.verified) await issueCode(u, "verify");
    return { ok: true };
  });
  post(/^\/api\/auth\/login$/, async (q, _, { body }) => {
    const u = DB.users[normEmail(body.email)];
    if (!u || !(await checkPw(String(body.password ?? ""), u.hash))) throw new HttpError(401, "البريد أو كلمة المرور غير صحيحة");
    if (!u.verified) throw new HttpError(403, "أكّد بريدك الإلكتروني أولًا", { needsVerify: true });
    return { token: signToken(u.email), user: pub(u) };
  });
  post(/^\/api\/auth\/forgot$/, async (q, _, { body }) => {
    const u = DB.users[normEmail(body.email)];
    if (u) { try { await issueCode(u, "reset"); } catch {} }
    return { ok: true }; // نفس الرد دائمًا حتى لا نكشف وجود البريد
  });
  post(/^\/api\/auth\/reset$/, async (q, _, { body }) => {
    const u = DB.users[normEmail(body.email)], pw = String(body.password ?? "");
    if (!u) throw new HttpError(400, "الرمز غير صحيح");
    if (pw.length < 8 || pw.length > 128) throw new HttpError(400, "كلمة المرور 8 أحرف على الأقل");
    checkCode(u, "reset", body.code);
    u.hash = await hashPw(pw); u.verified = true; persist();
    return { ok: true };
  });

  get(/^\/api\/me$/, (q, _, ctx) => pub(authed(ctx)));
  put(/^\/api\/me$/, (q, _, ctx) => {
    const u = authed(ctx), name = str(ctx.body.name, 50);
    if (!name) throw new HttpError(400, "الاسم مطلوب");
    u.name = name; persist();
    return pub(u);
  });
  put(/^\/api\/me\/settings$/, (q, _, ctx) => {
    const u = authed(ctx), b = ctx.body;
    const country = Number(b.country), city = Number(b.city);
    if (!Number.isInteger(country) || !COUNTRIES[country] || !Number.isInteger(city) || !COUNTRIES[country].c[city]) throw new HttpError(400, "دولة أو مدينة غير صالحة");
    const ids = (a) => (Array.isArray(a) ? [...new Set(a.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 30) : []);
    u.settings = { country, city, leagues: ids(b.leagues), teams: ids(b.teams) };
    persist();
    return pub(u);
  });
  del(/^\/api\/me$/, async (q, _, ctx) => {
    const u = authed(ctx);
    if (!(await checkPw(String(ctx.body.password ?? ""), u.hash))) throw new HttpError(401, "كلمة المرور غير صحيحة");
    delete DB.users[u.email]; persist();
    return { ok: true };
  });
}
