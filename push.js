// أجهزة الهاتف المسجّلة للإشعارات: كل جهاز يرسل رمز FCM والبطولات التي يتابعها.
// عند أي هدف يرسل الخادم إشعارًا للأجهزة المهتمة بتلك البطولة حتى والتطبيق مغلق.
import fs from "node:fs";

const DIR = new URL("./data/", import.meta.url);
fs.mkdirSync(DIR, { recursive: true });
const FILE = new URL("devices.json", DIR);
let D = {};
try { D = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
let timer = null;
function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const tmp = new URL("devices.json.tmp", DIR);
    fs.writeFileSync(tmp, JSON.stringify(D));
    fs.renameSync(tmp, FILE);
  }, 500);
}
// حذف الأجهزة غير النشطة منذ 120 يومًا
for (const [t, d] of Object.entries(D)) if (Date.now() - d.at > 120 * 864e5) delete D[t];

export const deviceCount = () => Object.keys(D).length;

export function setupDevices({ post, del, HttpError }) {
  post(/^\/api\/devices$/, (q, _, { body }) => {
    const t = String(body.token ?? "");
    if (t.length < 20 || t.length > 4096) throw new HttpError(400, "رمز الجهاز غير صالح");
    if (!D[t] && deviceCount() >= 500_000) throw new HttpError(503, "ممتلئ");
    const leagues = Array.isArray(body.leagues)
      ? [...new Set(body.leagues.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40) : [];
    const platform = ["android", "ios", "web"].includes(body.platform) ? body.platform : "android";
    D[t] = { leagues, platform, at: Date.now() };
    persist();
    return { ok: true, leagues: leagues.length };
  });
  del(/^\/api\/devices$/, (q, _, { body }) => {
    delete D[String(body.token ?? "")];
    persist();
    return { ok: true };
  });
}

const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);
// fcm = getMessaging() من firebase-admin
export async function pushGoal(fcm, { leagueId, fixtureId, title, body }) {
  const tokens = Object.keys(D).filter((t) => D[t].leagues.includes(leagueId));
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const r = await fcm.sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      data: { fixtureId: String(fixtureId) },
      android: { priority: "high" },
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
    });
    sent += r.successCount;
    r.responses.forEach((x, k) => { if (!x.success && DEAD.has(x.error?.code)) delete D[chunk[k]]; });
  }
  if (tokens.length) persist();
  return sent;
}
