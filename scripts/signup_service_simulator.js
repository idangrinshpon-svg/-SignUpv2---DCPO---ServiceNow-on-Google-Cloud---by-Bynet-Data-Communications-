#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://dcpo-servicenow-gcp-bynet.netlify.app";

function parseArgs(argv) {
  const result = { baseUrl: DEFAULT_BASE_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url" && argv[i + 1]) {
      result.baseUrl = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeJwt(payload, header = { alg: "none", typ: "JWT" }) {
  return [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
    "sig",
  ].join(".");
}

function futureIso(daysOffset) {
  const date = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const message = String(error?.cause?.message || error?.message || "");
    if (
      message.includes("unable to verify the first certificate") ||
      message.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") ||
      message.includes("self-signed certificate")
    ) {
      if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED || process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        console.warn("TLS certificate verification failed locally; retrying with NODE_TLS_REJECT_UNAUTHORIZED=0.");
        return fetch(url, options);
      }
    }
    throw error;
  }
}

function makeDemoPayload(overrides = {}) {
  return {
    aud: overrides.aud || "dcpo-servicenow-gcp-bynet.netlify.app",
    exp: overrides.exp || Math.floor(Date.now() / 1000) + 3600,
    google: overrides.google || {
      user_identity: "demo-user-identity",
      roles: ["roles/partner.viewer"],
      orders: ["orders/demo-001"],
    },
    iss:
      overrides.iss ||
      "https://www.googleapis.com/robot/v1/metadata/x509/cloud-commerce-partner@system.gserviceaccount.com",
    sub: overrides.sub || "demo-account",
  };
}

async function postForm(baseUrl, path, form, headers = {}) {
  const body = new URLSearchParams(form);
  const response = await safeFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    redirect: "manual",
    body,
  });

  return {
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

async function getPage(baseUrl, path) {
  const response = await safeFetch(`${baseUrl}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

function printResult(label, request, response) {
  console.log(`\n=== ${label} ===`);
  console.log(`Request: ${request}`);
  console.log(`Response: ${response.status}${response.location ? ` -> ${response.location}` : ""}`);
  if (response.contentType) {
    console.log(`Content-Type: ${response.contentType}`);
  }
  if (response.body) {
    const excerpt = response.body.length > 700 ? `${response.body.slice(0, 700)}...` : response.body;
    console.log("Body:");
    console.log(excerpt);
  }
}

async function main() {
  const { baseUrl } = parseArgs(process.argv.slice(2));
  const normalizedBase = baseUrl.replace(/\/+$/, "");

  console.log("Google Marketplace signup service simulator");
  console.log(`Base URL: ${normalizedBase}`);

  const signedDemoJwt = makeJwt(makeDemoPayload());
  const expiredDemoJwt = makeJwt(
    makeDemoPayload({
      exp: 1,
    }),
  );
  const missingIdentityJwt = makeJwt(
    makeDemoPayload({
      google: {},
    }),
  );
  const invalidAudienceJwt = makeJwt(
    makeDemoPayload({
      aud: "wrong.example.com",
    }),
  );

  const results = [];

  results.push([
    "GET /signup",
    "GET /signup",
    await getPage(normalizedBase, "/signup"),
  ]);

  results.push([
    "POST /signup without token",
    "demo=1",
    await postForm(normalizedBase, "/signup", { demo: "1" }),
  ]);

  results.push([
    "POST /signup with demo token",
    `demo=1&x-gcp-marketplace-token=${encodeURIComponent(signedDemoJwt)}`,
    await postForm(normalizedBase, "/signup", {
      demo: "1",
      "x-gcp-marketplace-token": signedDemoJwt,
    }),
  ]);

  results.push([
    "POST /signup via x-marketplace-demo header",
    "x-marketplace-demo:true + token",
    await postForm(
      normalizedBase,
      "/signup",
      { "x-gcp-marketplace-token": signedDemoJwt },
      { "x-marketplace-demo": "true" },
    ),
  ]);

  results.push([
    "POST /signup with malformed token",
    'x-gcp-marketplace-token=not-a-jwt',
    await postForm(normalizedBase, "/signup", {
      "x-gcp-marketplace-token": "not-a-jwt",
    }),
  ]);

  results.push([
    "POST /signup with expired token",
    `x-gcp-marketplace-token=${encodeURIComponent(expiredDemoJwt)}&demo=1`,
    await postForm(normalizedBase, "/signup", {
      demo: "1",
      "x-gcp-marketplace-token": expiredDemoJwt,
    }),
  ]);

  results.push([
    "POST /signup missing Google identity",
    `x-gcp-marketplace-token=${encodeURIComponent(missingIdentityJwt)}&demo=1`,
    await postForm(normalizedBase, "/signup", {
      demo: "1",
      "x-gcp-marketplace-token": missingIdentityJwt,
    }),
  ]);

  results.push([
    "POST /signup invalid audience",
    `x-gcp-marketplace-token=${encodeURIComponent(invalidAudienceJwt)}&demo=1`,
    await postForm(normalizedBase, "/signup", {
      demo: "1",
      "x-gcp-marketplace-token": invalidAudienceJwt,
    }),
  ]);

  for (const [label, request, response] of results) {
    printResult(label, request, response);
  }

  console.log("\nSimulator complete.");
}

main().catch((error) => {
  console.error("Simulator failed:", error);
  process.exit(1);
});
