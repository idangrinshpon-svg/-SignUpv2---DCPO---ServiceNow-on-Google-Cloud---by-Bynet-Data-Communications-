// @ts-check
const { defineConfig } = require("@playwright/test");

const baseURL = process.env.BASE_URL || "https://dcpo-servicenow-gcp-bynet.netlify.app";

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL,
    trace: "on-first-retry"
  }
});
