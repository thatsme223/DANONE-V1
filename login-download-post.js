import "dotenv/config";
import { chromium } from "@playwright/test";
import fetch from "node-fetch";

async function runForFarm({ email, password, farm, webUrl, token }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const page = await browser.newPage();

  await page.goto("https://danonemilkportal.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  const btn = await page.$('button:has-text("Login"), input[type="submit"][value="Login"]');
  if (btn) await btn.click(); else await page.evaluate(() => document.querySelector("form")?.submit());
  await page.waitForTimeout(2000);

  await page.goto("https://danonemilkportal.com/#ven-rec", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

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

  const base64 = buffer.toString("base64");
  const r = await fetch(webUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, farm, base64 })
  });
  console.log(farm, "ingest ->", await r.text());

  await browser.close();
}

(async () => {
  const webUrl = process.env.WEBAPP_URL;
  const token = process.env.INGEST_TOKEN;

  await runForFarm({
    email: process.env.MEARNS_EMAIL,
    password: process.env.MEARNS_PASSWORD,
    farm: "MEARNS",
    webUrl,
    token
  });

  await runForFarm({
    email: process.env.FAREND_EMAIL,
    password: process.env.FAREND_PASSWORD,
    farm: "FAR END",
    webUrl,
    token
  });
})().catch(e => {
  console.error("Run failed:", e);
  process.exit(1);
});
