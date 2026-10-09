// حساب أوقات الصلاة فلكيًا (بدون إنترنت)
const R = Math.PI / 180, sn = (x) => Math.sin(x * R), cs = (x) => Math.cos(x * R);

export function calc(y, m, d, lat, lng, mt) {
  const dd = (Date.UTC(y, m, d, 12) - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * dd) % 360, q = (280.459 + 0.98564736 * dd) % 360;
  const L = (q + 1.915 * sn(g) + 0.02 * sn(2 * g)) % 360, e = 23.439 - 3.6e-7 * dd;
  const ra = (Math.atan2(cs(e) * sn(L), cs(L)) / R / 15 + 24) % 24;
  const D = Math.asin(sn(e) * sn(L)) / R;
  let eq = q / 15 - ra;
  if (eq > 12) eq -= 24;
  if (eq < -12) eq += 24;
  const noon = 12 - lng / 15 - eq;
  const clamp = (c) => Math.max(-1, Math.min(1, c));
  const ha = (a) => Math.acos(clamp((-sn(a) - sn(lat) * sn(D)) / (cs(lat) * cs(D)))) / R / 15;
  const alt = Math.atan(1 / (mt[3] + Math.tan(Math.abs(lat - D) * R))) / R;
  const asr = Math.acos(clamp((sn(alt) - sn(lat) * sn(D)) / (cs(lat) * cs(D)))) / R / 15;
  const b = Date.UTC(y, m, d), maghrib = noon + ha(0.833);
  const isha = mt[2] ? maghrib + mt[2] / 60 : noon + ha(mt[1]);
  return [noon - ha(mt[0]), noon, noon + asr, maghrib, isha].map((h) => Math.round((b + h * 36e5) / 6e4) * 6e4);
}

const dfm = {}, tfm = {};
export function localDate(tz, ms = Date.now()) {
  const f = dfm[tz] || (dfm[tz] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  const p = f.format(ms).split("-");
  return [+p[0], +p[1] - 1, +p[2]];
}
export function fmt(tz, ms) {
  const f = tfm[tz] || (tfm[tz] = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }));
  return f.format(ms);
}
// place = { lat, lng, tz, mt }
export function dayTimes(p, off = 0, now = Date.now()) {
  const t = localDate(p.tz, now);
  return calc(t[0], t[1], t[2] + off, p.lat, p.lng, p.mt);
}
export function next(p, now = Date.now()) {
  const t = dayTimes(p, 0, now);
  for (let i = 0; i < 5; i++) if (t[i] > now) return { i, at: t[i], today: true };
  return { i: 0, at: dayTimes(p, 1, now)[0], today: false };
}
