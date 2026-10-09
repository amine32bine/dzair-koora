// توافق مع Node القديم (14.18 فما فوق): يوفّر fetch إن لم يكن موجودًا (fetch مدمج من Node 18).
import http from "node:http";
import https from "node:https";

if (typeof globalThis.fetch !== "function") {
  globalThis.fetch = (url, opt = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url), lib = u.protocol === "https:" ? https : http;
      const body = opt.body == null ? null : Buffer.from(opt.body);
      const headers = { ...(opt.headers || {}) };
      if (body) headers["Content-Length"] = body.length;
      const req = lib.request(u, { method: opt.method || "GET", headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
            text: async () => buf.toString("utf8"),
            json: async () => JSON.parse(buf.toString("utf8")),
          });
        });
      });
      req.on("error", reject);
      req.setTimeout(20000, () => req.destroy(new Error("timeout")));
      if (body) req.write(body);
      req.end();
    });
}
