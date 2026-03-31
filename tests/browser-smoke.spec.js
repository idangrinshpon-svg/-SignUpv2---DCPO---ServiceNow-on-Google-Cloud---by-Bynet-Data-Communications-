const { test, expect } = require("@playwright/test");

test("signup page renders expected content", async ({ page }) => {
  await page.goto("/signup");
  await expect(page).toHaveTitle(/Sign Up/);
  await expect(page.getByRole("heading", { name: /Register for/i })).toBeVisible();
  await expect(page.locator(".gcp-logo")).toContainText("Google Cloud Marketplace");
  await expect(page.locator("body")).not.toContainText("ג");
});

test("login page renders expected content", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle(/Sign In/);
  await expect(page.getByRole("heading", { name: /Sign in to your/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in to ServiceNow/i })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("ג");
});

test("login error state is visible", async ({ page }) => {
  await page.goto("/login.html?error=token_expired");
  await expect(page.getByText(/marketplace session expired/i)).toBeVisible();
});

test("signup error state is visible", async ({ page }) => {
  await page.goto("/signup.html?error=token_expired");
  await expect(page.getByText(/marketplace session has expired/i)).toBeVisible();
});

test("footer subpages exist", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: /Privacy Policy/i })).toBeVisible();

  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: /Terms/i })).toBeVisible();

  await page.goto("/contact");
  await expect(page.getByRole("heading", { name: /Contact/i })).toBeVisible();
});

test("guide subpages exist", async ({ page }) => {
  await page.goto("/marketplace");
  await expect(page.getByRole("heading", { name: /Google Cloud Marketplace/i })).toBeVisible();

  await page.goto("/instance-help");
  await expect(page.getByRole("heading", { name: /Find Your ServiceNow Instance/i })).toBeVisible();

  await page.goto("/access-help/?instance=acme&target=https%3A%2F%2Facme.service-now.com%2Flogin.do");
  await expect(page.getByRole("heading", { name: /Complete Access With Your Service Provider/i })).toBeVisible();
  await expect(page.locator("#instance-value")).toContainText("acme.service-now.com");
});
