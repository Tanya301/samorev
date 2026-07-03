/**
 * E2E spec: samorev landing page (site/).
 *
 * Playwright serves site/ via a local web server (playwright.config.ts).
 * RED state: site/ does not exist yet — the webServer cannot start and every
 *            test here fails, confirming the test pins the missing behavior.
 * GREEN state: site/ is present with index.html and style.css.
 */

import { test, expect } from "@playwright/test";

test("landing page loads with 200", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});

test('page title includes "samorev"', async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/samorev/i);
});

test("hero heading is present", async ({ page }) => {
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toContainText("Code review that thinks ahead");
});

test("how-it-works section has three steps", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#how-it-works");
  await expect(section).toBeVisible();
  const cards = section.locator(".card");
  await expect(cards).toHaveCount(3);
});

test("CTA button links to email early-access address", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: /get early access/i }).first();
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute("href");
  expect(href).toMatch(/^mailto:/);
});

test('footer contains "built with samo"', async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText(/built with samo/i);
});

test("footer samo link points to samo.team", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  const link = footer.getByRole("link", { name: /samo/i });
  await expect(link).toHaveAttribute("href", "https://samo.team");
});

test("page is responsive — meta viewport is set", async ({ page }) => {
  await page.goto("/");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
});

test("nav has early-access link", async ({ page }) => {
  await page.goto("/");
  const nav = page.locator("nav");
  const link = nav.getByRole("link", { name: /early access/i });
  await expect(link).toBeVisible();
});
