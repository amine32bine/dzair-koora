// ينسخ ../public إلى www ويكتب عنوان الـ API: node sync.js https://api.example.com
// (أو ضعه في متغير API_BASE)
import fs from "node:fs";
const api = (process.argv[2] || process.env.API_BASE || "").replace(/\/+$/, "");
if (!/^https:\/\//.test(api)) {
  console.error("اكتب عنوان خادمك بـ https، مثال:  node sync.js https://api.example.com");
  process.exit(1);
}
fs.rmSync("www", { recursive: true, force: true });
fs.cpSync("../public", "www", { recursive: true });
fs.writeFileSync("www/config.js", `window.APP_CONFIG = { API_BASE: ${JSON.stringify(api)} };\n`);
console.log("تم: www جاهز وعنوان الـ API =", api);
