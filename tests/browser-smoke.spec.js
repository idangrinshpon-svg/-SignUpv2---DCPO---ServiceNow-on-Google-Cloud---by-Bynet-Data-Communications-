const { test, expect } = require("@playwright/test");

const sampleEntitlement = {
  eventId: "evt-demo-1",
  eventType: "ENTITLEMENT_OFFER_ACCEPTED",
  status: "scheduled",
  approvalStatus: "pending",
  receivedAt: "2026-04-03T00:00:00.000Z",
  isAutomaticApproval: true,
  entitlement: {
    id: "demo-entitlement-support",
    updateTime: "2026-04-03T00:00:00.000Z",
    newPendingOfferDuration: "P30D",
    newOfferStartTime: "2026-04-10T00:00:00.000Z",
    newOfferEndTime: "2026-05-10T00:00:00.000Z",
  },
};

test("signup page renders expected content", async ({ page }) => {
  await page.goto("/signup");
  await expect(page).toHaveTitle(/Sign Up/);
  await expect(page.getByRole("heading", { name: /Register for/i })).toBeVisible();
  await expect(page.locator(".gcp-logo")).toContainText("Google Cloud Marketplace");
  await expect(page.locator("body")).not.toContainText("ג");
});

test("signup verified metadata is visible", async ({ page }) => {
  await page.route(/.*\/\.netlify\/functions\/marketplace-entitlements.*/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(sampleEntitlement) });
  });
  await page.goto("/signup?verified=1&gcp_account_id=demo-account&gcp_user_identity=demo-uid&offer_state=accepted&approval_mode=automatic");
  await expect(page.locator("#tok-ok")).toBeVisible();
  await expect(page.locator("#gcp-meta")).toBeVisible();
  await expect(page.locator("#gcp-account-view")).toContainText("demo-account");
  await expect(page.locator("#gcp-identity-view")).toContainText("demo-uid");
  await expect(page.locator("#gcp-offer-view")).toContainText("scheduled");
  await expect(page.locator("#gcp-approval-view")).toContainText("automatic");
  await expect(page.locator("#gcp-approval-state-view")).toContainText("pending");
  await expect(page.locator("#gcp-start-view")).toContainText("2026-04-10");
  await expect(page.locator("#gcp-note")).toContainText(/scheduled/i);
  await expect(page.locator("#gcp-actions")).toBeVisible();
  await expect(page.locator("#gcp-status-link")).toHaveAttribute("href", /entitlement-status/);
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

test("entitlement status page renders scheduled offers", async ({ page }) => {
  await page.route(/.*\/\.netlify\/functions\/marketplace-entitlements.*/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(sampleEntitlement) });
  });

  await page.goto("/entitlement-status/?entitlement_id=demo-entitlement-support&account_id=demo-account");
  await expect(page.getByRole("heading", { name: /Track When a Private Offer Becomes Active/i })).toBeVisible();
  await expect(page.locator("#status-badge")).toContainText("scheduled");
  await expect(page.locator("#entitlement-id")).toContainText("demo-entitlement-support");
  await expect(page.locator("#account-id")).toContainText("demo-account");
  await expect(page.locator("#start-time")).toContainText("2026-04-10");
  await expect(page.getByRole("button", { name: /Approve Customer Account/i })).toBeVisible();
  await expect(page.locator("#approval-status")).toContainText("pending");
});

test("entitlement status page renders rejected offers", async ({ page }) => {
  await page.route(/.*\/\.netlify\/functions\/marketplace-entitlements.*/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...sampleEntitlement,
        status: "rejected",
        approvalStatus: "rejected",
        approvalRejectedAt: "2026-04-03T00:00:00.000Z",
      }),
    });
  });

  await page.goto("/entitlement-status/?entitlement_id=demo-entitlement-rejected&account_id=demo-account");
  await expect(page.locator("#status-badge")).toContainText("rejected");
  await expect(page.locator("#note")).toContainText(/automatically rejected/i);
  await expect(page.getByRole("button", { name: /Approve Customer Account/i })).toHaveCount(0);
});
