import "dotenv/config";
import { chromium } from "@playwright/test";
import fetch from "node-fetch";

// Fail fast if any secret is missing
const must = (name) => {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`${name} secret is missing/empty`);
  return String(v).trim();
};
const WEB_URL = must("WEBAPP_URL");
const TOKEN   = must("INGEST_TOKEN");
const MEARNS_EMAIL = must("MEARNS_EMAIL");
const MEARNS_PASSWORD = must("MEARNS_PASSWORD");
const FAREND_EMAIL = must("FAREND_EMAIL");
const FAREND_PASSWORD = must("FAREND_PASSWORD");

async function runForFarm({ email, password, farm }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const page = await browser.newPage();

  // 1) Login
  await page.goto("https://danonemilkportal.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  const btn = await page.$('button:has-text("Login"), input[type="submit"][value="Login"]');
  if (btn) await btn.click(); else await page.evaluate(() => document.querySelector("form")?.submit());
  await page.waitForTimeout(2000);

  // 2) Receipts
  await page.goto("https://danonemilkportal.com/#ven-rec", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

  // 3) Download XLSX (click then fallback)
  let buffer = null;
  try {
    const exportSelector = 'a:has-text("Export"), button:has-text("Export")';
    await page.waitForSelector(exportSelector, { timeout: 12000 });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }),
      page.click(exportSelector)
    ]);
    const stream = await download.createReadStream();
    buffer = await new Promise((res, rej) => {
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => res(Buffer.concat(chunks)));
      stream.on("error", rej);
    });
  } catch {
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const exportUrl = "https://danonemilkportal.com/vendors/receipt/export?format=xlsx";
    const resp = await page.request.get(exportUrl, {
      headers: { Cookie: cookieHeader, Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*" }
    });
    if (!resp.ok()) throw new Error(`Export failed ${resp.status()}: ${await resp.text()}`);
    buffer = Buffer.from(await resp.body());
  }

  // 4) Post to Apps Script webhook
  const base64 = buffer.toString("base64");
  const r = await fetch(WEB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, farm, base64 })
  });
  const txt = await r.text();
  console.log(`${farm} ingest -> ${txt}`);

  await browser.close();
}

(async () => {
  await runForFarm({ email: MEARNS_EMAIL, password: MEARNS_PASSWORD, farm: "MEARNS" });
  await runForFarm({ email: FAREND_EMAIL,  password: FAREND_PASSWORD,  farm: "FAR END" });
})().catch(e => { console.error("Run failed:", e); process.exit(1); });
