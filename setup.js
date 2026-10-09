// يعمل مرة واحدة عند أول تشغيل: يسألك عن مفاتيح البيانات ويكتبها في ملف .env
import fs from "node:fs";
import readline from "node:readline";

const envFile = new URL(".env", import.meta.url);
const example = new URL(".env.example", import.meta.url);
let text = fs.readFileSync(fs.existsSync(envFile) ? envFile : example, "utf8");
const set = (k, v) => {
  const re = new RegExp("^" + k + "=.*$", "m");
  text = re.test(text) ? text.replace(re, k + "=" + v) : text + "\n" + k + "=" + v + "\n";
};

const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => { process.stdout.write(q); const r = await lines.next(); return r.done ? "" : r.value.trim(); };

console.log("\n=== Dzair Koora first-time setup ===\n");
console.log("1) football-data.org token  (FREE, current season, Premier League / La Liga / Serie A /");
console.log("   Bundesliga / Ligue 1 / Champions League / World Cup). Register: https://www.football-data.org/client/register");
const fdKey = await ask("FOOTBALL_DATA_KEY (Enter to skip): ");

console.log("\n2) API-Football key (needed for Algerian and Arab leagues, live minute + scorer names). Paid plan for the current season.");
let afKey = await ask("API_FOOTBALL_KEY (Enter to skip): ");
let note = "";
if (afKey) {
  const free = (await ask("Is this the FREE API-Football plan? [Y/n]: ")).toLowerCase() !== "n";
  if (free && fdKey) { afKey = ""; note = "NOTE: the free API-Football plan cannot serve the current season, so it was NOT saved. football-data.org will be used."; }
  else if (free) { set("SEASON", "2024"); set("POLL_MS", "600000"); note = "NOTE: free API-Football only serves seasons 2022-2024, so SEASON=2024 was set (old but real data)."; }
}
rl.close();

if (fdKey) set("FOOTBALL_DATA_KEY", fdKey);
if (afKey) set("API_FOOTBALL_KEY", afKey);
fs.writeFileSync(envFile, text);
if (note) console.log("\n" + note);
console.log(fdKey || afKey ? "\nSaved to .env\n" : "\nSkipped. Prayer times and accounts work; add keys later in the .env file.\n");
