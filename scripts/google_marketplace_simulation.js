#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const {
  approveEntitlementRecord,
  computeLifecycle,
  createEntitlementRecord,
  summarizeEntitlementState,
} = require('../netlify/functions/_shared/entitlement-lifecycle');
const {
  buildVerifiedParams,
  extractRequestParams,
  isDemoRequest,
  parseJwt,
  verifyMarketplaceToken,
} = require('../netlify/functions/_shared/marketplace');
const {
  decodePubSubEnvelope,
  verifyPubSubPushAuth,
} = require('../netlify/functions/_shared/pubsub');
const {
  approveMarketplaceAccount,
  approveMarketplaceEntitlement,
  approveMarketplacePlanChange,
  getAccessToken,
  rejectMarketplaceEntitlement,
} = require('../netlify/functions/_shared/google-marketplace-api');

const GOOGLE_MARKETPLACE_ISSUER = 'https://www.googleapis.com/robot/v1/metadata/x509/cloud-commerce-partner@system.gserviceaccount.com';
const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_COMMERCE_API_BASE = 'https://cloudcommerceprocurement.googleapis.com/v1';
const ROOT = path.resolve(__dirname, '..');
const SHARED_MARKETPLACE_KEYS = makeRsaKeyMaterial('marketplace');
const SHARED_PUBSUB_KEYS = makeRsaKeyMaterial('pubsub');

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function expect(condition, label, detail, failures) {
  if (condition) {
    console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
    return true;
  }

  console.log(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
  failures.push(`${label}${detail ? `: ${detail}` : ''}`);
  return false;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlEncodeObject(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function parseJsonBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

function parseRedirectParams(location) {
  const url = new URL(location, 'https://example.invalid');
  return Object.fromEntries(url.searchParams.entries());
}

function makeFutureIso(daysOffset) {
  const date = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function makeRsaKeyMaterial(label) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return {
    kid: `${label}-kid`,
    privateKey,
    publicKey,
  };
}

function signJwt({ kid, privateKey, header, payload }) {
  const encodedHeader = base64UrlEncodeObject({
    alg: 'RS256',
    typ: 'JWT',
    kid,
    ...header,
  });
  const encodedPayload = base64UrlEncodeObject(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function unsignedJwt({ kid, header, payload }) {
  const encodedHeader = base64UrlEncodeObject({
    alg: 'none',
    typ: 'JWT',
    kid,
    ...header,
  });
  const encodedPayload = base64UrlEncodeObject(payload);
  return `${encodedHeader}.${encodedPayload}.sig`;
}

function makeMarketplacePayload(overrides = {}) {
  return {
    aud: overrides.aud || 'dcpo-servicenow-gcp-bynet.netlify.app',
    exp: overrides.exp || Math.floor(Date.now() / 1000) + 3600,
    google: {
      user_identity: overrides.user_identity || 'demo-user-identity',
      roles: overrides.roles || ['roles/partner.viewer'],
      orders: overrides.orders || ['orders/demo-001'],
    },
    iss: overrides.iss || GOOGLE_MARKETPLACE_ISSUER,
    sub: overrides.sub || 'demo-account',
  };
}

function makePubSubPayload(overrides = {}) {
  return {
    aud: overrides.aud || 'https://dcpo-servicenow-gcp-bynet.netlify.app/.netlify/functions/marketplace-pubsub',
    email: overrides.email || 'pubsub-push@example.com',
    email_verified: overrides.email_verified !== undefined ? overrides.email_verified : true,
    exp: overrides.exp || Math.floor(Date.now() / 1000) + 3600,
    iss: overrides.iss || 'https://accounts.google.com',
    sub: overrides.sub || 'service-account-subject',
  };
}

function makeAcceptedEvent(overrides = {}) {
  const start = overrides.start || makeFutureIso(7);
  const end = overrides.end || makeFutureIso(37);
  return {
    eventId: overrides.eventId || 'evt-sim-1',
    eventType: overrides.eventType || 'ENTITLEMENT_OFFER_ACCEPTED',
    entitlement: {
      id: overrides.entitlementId || 'sim-entitlement-001',
      updateTime: overrides.updateTime || makeFutureIso(0),
      newPendingOfferDuration: overrides.newPendingOfferDuration || 'P30D',
      newOfferStartTime: start,
      newOfferEndTime: end,
    },
  };
}

function makeCreationEvent(overrides = {}) {
  return {
    eventId: overrides.eventId || 'evt-sim-create-1',
    eventType: 'ENTITLEMENT_CREATION_REQUESTED',
    entitlement: {
      id: overrides.entitlementId || 'sim-entitlement-create',
      updateTime: overrides.updateTime || makeFutureIso(0),
      newPendingOfferDuration: overrides.newPendingOfferDuration || 'P1Y6M',
      newOfferEndTime: overrides.end || makeFutureIso(548),
      plan: overrides.plan || 'standard',
    },
  };
}

function makePlanChangeEvent(overrides = {}) {
  return {
    eventId: overrides.eventId || 'evt-sim-plan-change-1',
    eventType: 'ENTITLEMENT_PLAN_CHANGE_REQUESTED',
    entitlement: {
      id: overrides.entitlementId || 'sim-entitlement-plan-change',
      updateTime: overrides.updateTime || makeFutureIso(0),
      newPendingOfferDuration: overrides.newPendingOfferDuration || 'P2Y',
      newPendingPlan: overrides.newPendingPlan || 'ultimate',
      newPendingOffer: overrides.newPendingOffer || 'OFFER2',
      plan: overrides.plan || 'pro',
    },
  };
}

function makePlanChangedEvent(overrides = {}) {
  return {
    eventId: overrides.eventId || 'evt-sim-plan-changed-1',
    eventType: 'ENTITLEMENT_PLAN_CHANGED',
    entitlement: {
      id: overrides.entitlementId || 'sim-entitlement-plan-change',
      updateTime: overrides.updateTime || makeFutureIso(0),
      newPendingOfferDuration: overrides.newPendingOfferDuration || 'P2Y',
      newPendingPlan: overrides.newPendingPlan || 'ultimate',
      newPendingOffer: overrides.newPendingOffer || 'OFFER2',
      plan: overrides.plan || 'ultimate',
    },
  };
}

function makeOfferEndedEvent(overrides = {}) {
  return {
    eventId: overrides.eventId || 'evt-sim-ended-1',
    eventType: 'ENTITLEMENT_OFFER_ENDED',
    entitlement: {
      id: overrides.entitlementId || 'sim-entitlement-ended',
      updateTime: overrides.updateTime || makeFutureIso(0),
      newPendingOfferDuration: overrides.newPendingOfferDuration || 'P30D',
      newOfferEndTime: overrides.end || makeFutureIso(-1),
    },
  };
}

function makePubSubEnvelope(payload) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      messageId: 'demo-message-1',
      publishTime: makeFutureIso(0),
    },
    subscription: 'projects/demo/subscriptions/marketplace-entitlements',
  };
}

function extractLinks(html) {
  const hrefs = [];
  const regex = /href="([^"]+)"/g;
  let match;
  while ((match = regex.exec(html))) {
    hrefs.push(match[1]);
  }
  return hrefs;
}

function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function createResponse({ status = 200, body = '', json = null, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async json() {
      if (json != null) return deepClone(json);
      if (typeof body === 'string' && body) return JSON.parse(body);
      return null;
    },
    async text() {
      if (typeof body === 'string') return body;
      if (json != null) return JSON.stringify(json);
      return '';
    },
  };
}

function withFetchStub(routes, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    for (const route of routes) {
      const matcher = route.match;
      const matched =
        typeof matcher === 'string'
          ? target === matcher
          : matcher instanceof RegExp
            ? matcher.test(target)
            : matcher(target, options);
      if (matched) {
        return route.handle(target, options);
      }
    }
    throw new Error(`Unexpected fetch call: ${target}`);
  };

  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      global.fetch = originalFetch;
    });
}

function installBlobMock() {
  const originalLoad = Module._load;
  const stores = new Map();

  function getStore(name) {
    if (!stores.has(name)) {
      stores.set(name, new Map());
    }

    const map = stores.get(name);
    return {
      async get(key) {
        return map.has(key) ? deepClone(map.get(key)) : null;
      },
      async setJSON(key, value) {
        map.set(key, deepClone(value));
      },
      async *list({ prefix = '' } = {}) {
        const blobs = [...map.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key }));
        yield { blobs };
      },
    };
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@netlify/blobs') {
      return {
        connectLambda() {},
        getStore,
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return {
    restore() {
      Module._load = originalLoad;
    },
    dump(storeName) {
      const map = stores.get(storeName);
      return map ? deepClone(Object.fromEntries(map.entries())) : {};
    },
    getStore,
  };
}

function invoke(handler, event) {
  return handler.handler ? handler.handler(event) : handler(event);
}

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function checkStaticPage(filePath, expectations, label, failures) {
  const html = fs.readFileSync(filePath, 'utf8');
  const missing = expectations.filter((entry) => !html.includes(entry));
  expect(
    missing.length === 0,
    label,
    missing.length ? `missing tokens: ${missing.join(', ')}` : 'all tokens present',
    failures,
  );
}

function checkLinks(html, expected, label, failures) {
  const links = extractLinks(html);
  const missing = expected.filter((entry) => !links.includes(entry));
  expect(
    missing.length === 0,
    label,
    missing.length ? `missing links: ${missing.join(', ')}` : `links: ${links.join(', ')}`,
    failures,
  );
}

async function tokenMatrixSuite(failures) {
  console.log('\n=== Google Marketplace token matrix ===');
  const host = 'dcpo-servicenow-gcp-bynet.netlify.app';
  const certs = { [SHARED_MARKETPLACE_KEYS.kid]: SHARED_MARKETPLACE_KEYS.publicKey };
  const baseEvent = { headers: { host } };

  await withFetchStub([
    {
      match: GOOGLE_MARKETPLACE_ISSUER,
      handle: async () => createResponse({ json: certs }),
    },
  ], async () => {
    const validPayload = makeMarketplacePayload({ aud: host });
    const validToken = signJwt({
      kid: SHARED_MARKETPLACE_KEYS.kid,
      privateKey: SHARED_MARKETPLACE_KEYS.privateKey,
      payload: validPayload,
    });

    const parsed = parseJwt(validToken);
    expect(!!parsed && parsed.payload.sub === 'demo-account', 'parseJwt decodes Marketplace token', parsed ? 'payload decoded' : 'parse failed', failures);

    const extracted = extractRequestParams({
      body: `demo=1&x-gcp-marketplace-token=${encodeURIComponent(validToken)}`,
      headers: {},
      queryStringParameters: {},
    });
    expect(extracted.demo === true && extracted.token === validToken, 'extractRequestParams sees demo body flag', `demo=${extracted.demo}, token present=${!!extracted.token}`, failures);
    expect(isDemoRequest({ queryStringParameters: { demo: 'true' } }) === true, 'isDemoRequest accepts query-string demo flag', 'expected true', failures);

    const verified = await verifyMarketplaceToken(baseEvent, validToken);
    expect(verified.ok, 'verifyMarketplaceToken accepts signed Marketplace JWT', verified.ok ? 'ok' : verified.error, failures);

    const wrongAudience = await verifyMarketplaceToken(baseEvent, signJwt({
      kid: SHARED_MARKETPLACE_KEYS.kid,
      privateKey: SHARED_MARKETPLACE_KEYS.privateKey,
      payload: makeMarketplacePayload({ aud: 'wrong.example.com' }),
    }));
    expect(wrongAudience.ok === false && wrongAudience.error === 'invalid_audience', 'verifyMarketplaceToken rejects invalid audience', wrongAudience.error, failures);

    const wrongIssuer = await verifyMarketplaceToken(baseEvent, signJwt({
      kid: SHARED_MARKETPLACE_KEYS.kid,
      privateKey: SHARED_MARKETPLACE_KEYS.privateKey,
      payload: makeMarketplacePayload({ iss: 'https://example.com' }),
    }));
    expect(wrongIssuer.ok === false && wrongIssuer.error === 'invalid_issuer', 'verifyMarketplaceToken rejects invalid issuer', wrongIssuer.error, failures);

    const missingIdentity = await verifyMarketplaceToken(baseEvent, signJwt({
      kid: SHARED_MARKETPLACE_KEYS.kid,
      privateKey: SHARED_MARKETPLACE_KEYS.privateKey,
      payload: {
        ...makeMarketplacePayload({ aud: host }),
        google: {},
      },
    }));
    expect(missingIdentity.ok === false && missingIdentity.error === 'missing_user_identity', 'verifyMarketplaceToken rejects missing user identity', missingIdentity.error, failures);

    const expired = await verifyMarketplaceToken(baseEvent, signJwt({
      kid: SHARED_MARKETPLACE_KEYS.kid,
      privateKey: SHARED_MARKETPLACE_KEYS.privateKey,
      payload: makeMarketplacePayload({ aud: host, exp: 1 }),
    }));
    expect(expired.ok === false && expired.error === 'token_expired', 'verifyMarketplaceToken rejects expired token', expired.error, failures);

    const invalidSig = await verifyMarketplaceToken(baseEvent, `${validToken.split('.')[0]}.${validToken.split('.')[1]}.invalid`);
    expect(invalidSig.ok === false && invalidSig.error === 'invalid_signature', 'verifyMarketplaceToken rejects invalid signature', invalidSig.error, failures);

    const demoToken = unsignedJwt({
      kid: 'demo-kid',
      payload: makeMarketplacePayload({ aud: host, user_identity: 'demo-identity' }),
    });
    const demoVerified = await verifyMarketplaceToken(baseEvent, demoToken, { demo: true });
    expect(demoVerified.ok, 'verifyMarketplaceToken allows demo tokens without signature', demoVerified.ok ? 'ok' : demoVerified.error, failures);
  });
}

async function loginSignupSuite(failures) {
  console.log('\n=== Login and signup flows ===');
  const host = 'dcpo-servicenow-gcp-bynet.netlify.app';
  const certs = { [SHARED_MARKETPLACE_KEYS.kid]: SHARED_MARKETPLACE_KEYS.publicKey };
  const validPayload = makeMarketplacePayload({ aud: host });
  const validToken = signJwt({
    kid: SHARED_MARKETPLACE_KEYS.kid,
    privateKey: SHARED_MARKETPLACE_KEYS.privateKey,
    payload: validPayload,
  });
  const demoToken = unsignedJwt({
    kid: 'demo-kid',
    payload: makeMarketplacePayload({ aud: host, user_identity: 'demo-identity' }),
  });

  await withFetchStub([
    {
      match: GOOGLE_MARKETPLACE_ISSUER,
      handle: async () => createResponse({ json: certs }),
    },
  ], async () => {
    const missingSignup = await invoke(require('../netlify/functions/gcp-signup'), {
      httpMethod: 'POST',
      headers: { host },
      body: '',
      queryStringParameters: {},
    });
    expect(
      missingSignup.statusCode === 303 && missingSignup.headers.Location === '/signup.html?error=missing_token',
      'signup rejects missing token',
      `status=${missingSignup.statusCode}, location=${missingSignup.headers.Location}`,
      failures,
    );

    const missingLogin = await invoke(require('../netlify/functions/gcp-login'), {
      httpMethod: 'POST',
      headers: { host },
      body: '',
      queryStringParameters: {},
    });
    expect(
      missingLogin.statusCode === 303 && missingLogin.headers.Location === '/login.html?error=missing_token',
      'login rejects missing token',
      `status=${missingLogin.statusCode}, location=${missingLogin.headers.Location}`,
      failures,
    );

    const signupDemo = await invoke(require('../netlify/functions/gcp-signup'), {
      httpMethod: 'POST',
      headers: { host },
      body: `demo=1&x-gcp-marketplace-token=${encodeURIComponent(demoToken)}`,
      queryStringParameters: {},
    });
    const signupDemoParams = parseRedirectParams(signupDemo.headers.Location);
    expect(signupDemo.statusCode === 303 && signupDemo.headers.Location.startsWith('/signup.html?'), 'signup demo flow redirects to signup.html', signupDemo.headers.Location, failures);
    expect(
      signupDemoParams.verified === '1' &&
        signupDemoParams.approval_mode === 'automatic' &&
        signupDemoParams.approval_status === 'pending' &&
        signupDemoParams.offer_state === 'accepted' &&
        signupDemoParams.source === 'demo',
      'signup demo flow preserves Marketplace metadata',
      JSON.stringify(signupDemoParams),
      failures,
    );

    const signupSigned = await invoke(require('../netlify/functions/gcp-signup'), {
      httpMethod: 'POST',
      headers: { host },
      body: `x-gcp-marketplace-token=${encodeURIComponent(validToken)}`,
      queryStringParameters: {},
    });
    const signupSignedParams = parseRedirectParams(signupSigned.headers.Location);
    expect(
      signupSigned.statusCode === 303 &&
        signupSignedParams.verified === '1' &&
        signupSignedParams.gcp_account_id === 'demo-account' &&
        signupSignedParams.gcp_user_identity === 'demo-user-identity' &&
        signupSignedParams.gcp_roles === 'roles/partner.viewer' &&
        signupSignedParams.gcp_orders === 'orders/demo-001' &&
        signupSignedParams.source === 'gcp',
      'signup signed flow returns verified Marketplace metadata',
      JSON.stringify(signupSignedParams),
      failures,
    );

    const loginSigned = await invoke(require('../netlify/functions/gcp-login'), {
      httpMethod: 'POST',
      headers: { host },
      body: `x-gcp-marketplace-token=${encodeURIComponent(validToken)}`,
      queryStringParameters: {},
    });
    const loginSignedParams = parseRedirectParams(loginSigned.headers.Location);
    expect(
      loginSigned.statusCode === 303 &&
        loginSignedParams.verified === '1' &&
        loginSignedParams.gcp_account_id === 'demo-account' &&
        loginSignedParams.gcp_user_identity === 'demo-user-identity' &&
        loginSignedParams.gcp_roles === 'roles/partner.viewer' &&
        loginSignedParams.source === 'gcp',
      'login signed flow returns verified Marketplace metadata',
      JSON.stringify(loginSignedParams),
      failures,
    );

    const invalidSignup = await invoke(require('../netlify/functions/gcp-signup'), {
      httpMethod: 'POST',
      headers: { host },
      body: `x-gcp-marketplace-token=${encodeURIComponent('not-a-jwt')}`,
      queryStringParameters: {},
    });
    expect(
      invalidSignup.statusCode === 303 && invalidSignup.headers.Location === '/signup.html?error=invalid_token',
      'signup rejects malformed token',
      `status=${invalidSignup.statusCode}, location=${invalidSignup.headers.Location}`,
      failures,
    );

    const invalidLogin = await invoke(require('../netlify/functions/gcp-login'), {
      httpMethod: 'POST',
      headers: { host },
      body: `x-gcp-marketplace-token=${encodeURIComponent('not-a-jwt')}`,
      queryStringParameters: {},
    });
    expect(
      invalidLogin.statusCode === 303 && invalidLogin.headers.Location === '/login.html?error=invalid_token',
      'login rejects malformed token',
      `status=${invalidLogin.statusCode}, location=${invalidLogin.headers.Location}`,
      failures,
    );

    const demoViaHeader = extractRequestParams({
      httpMethod: 'POST',
      headers: { 'x-marketplace-demo': 'true' },
      body: `x-gcp-marketplace-token=${encodeURIComponent(demoToken)}`,
    });
    expect(demoViaHeader.demo === true, 'extractRequestParams accepts x-marketplace-demo header', 'expected demo=true', failures);
  });
}

async function pubsubAndLifecycleSuite(failures) {
  console.log('\n=== Pub/Sub and entitlement lifecycle ===');
  const blobRuntime = installBlobMock();
  const pubsubHandler = freshRequire('../netlify/functions/marketplace-pubsub');
  const accountApprovalHandler = freshRequire('../netlify/functions/marketplace-account-approval');
  const reconcileHandler = freshRequire('../netlify/functions/marketplace-entitlements-reconcile');
  const entitlementApprovalHandler = freshRequire('../netlify/functions/marketplace-entitlement-approval');
  const planChangeApprovalHandler = freshRequire('../netlify/functions/marketplace-plan-change-approval');
  const pubsubCerts = { [SHARED_PUBSUB_KEYS.kid]: SHARED_PUBSUB_KEYS.publicKey };
  const pubsubToken = signJwt({
    kid: SHARED_PUBSUB_KEYS.kid,
    privateKey: SHARED_PUBSUB_KEYS.privateKey,
    payload: makePubSubPayload(),
  });

  try {
    await withFetchStub([
      {
        match: GOOGLE_OIDC_CERTS_URL,
        handle: async () => createResponse({ json: pubsubCerts }),
      },
    ], async () => {
      const rawPayload = makeAcceptedEvent({ entitlementId: 'sim-entitlement-raw' });
      const rawDecoded = decodePubSubEnvelope(rawPayload);
      expect(rawDecoded && rawDecoded.entitlement.id === 'sim-entitlement-raw', 'decodePubSubEnvelope accepts raw payload', rawDecoded ? rawDecoded.entitlement.id : 'decode failed', failures);

      const envelopeDecoded = decodePubSubEnvelope(makePubSubEnvelope(rawPayload));
      expect(envelopeDecoded && envelopeDecoded.entitlement.id === 'sim-entitlement-raw', 'decodePubSubEnvelope unwraps Pub/Sub envelope', envelopeDecoded ? envelopeDecoded.entitlement.id : 'decode failed', failures);

      const jsonEnvelopeDecoded = decodePubSubEnvelope({ message: { json: rawPayload } });
      expect(jsonEnvelopeDecoded && jsonEnvelopeDecoded.entitlement.id === 'sim-entitlement-raw', 'decodePubSubEnvelope accepts message.json payload', jsonEnvelopeDecoded ? jsonEnvelopeDecoded.entitlement.id : 'decode failed', failures);

      await withEnv({
        PUBSUB_REQUIRE_AUTH: '1',
        PUBSUB_PUSH_AUDIENCE: 'https://dcpo-servicenow-gcp-bynet.netlify.app/.netlify/functions/marketplace-pubsub',
        PUBSUB_PUSH_EMAIL: 'pubsub-push@example.com',
      }, async () => {
        const authMissing = await verifyPubSubPushAuth({ headers: {} });
        expect(authMissing.ok === false && authMissing.error === 'missing_authorization', 'verifyPubSubPushAuth requires Authorization header when enabled', authMissing.error, failures);

        const authInvalidAudience = await verifyPubSubPushAuth({
          headers: {
            authorization: `Bearer ${signJwt({
              kid: SHARED_PUBSUB_KEYS.kid,
              privateKey: SHARED_PUBSUB_KEYS.privateKey,
              payload: makePubSubPayload({ aud: 'wrong-audience' }),
            })}`,
          },
        });
        expect(authInvalidAudience.ok === false && authInvalidAudience.error === 'invalid_audience', 'verifyPubSubPushAuth rejects invalid audience', authInvalidAudience.error, failures);

        const authInvalidEmail = await verifyPubSubPushAuth({
          headers: {
            authorization: `Bearer ${signJwt({
              kid: SHARED_PUBSUB_KEYS.kid,
              privateKey: SHARED_PUBSUB_KEYS.privateKey,
              payload: makePubSubPayload({ email: 'other@example.com' }),
            })}`,
          },
        });
        expect(authInvalidEmail.ok === false && authInvalidEmail.error === 'unexpected_email', 'verifyPubSubPushAuth rejects unexpected email', authInvalidEmail.error, failures);

        const authValid = await verifyPubSubPushAuth({
          headers: {
            authorization: `Bearer ${pubsubToken}`,
            host: 'dcpo-servicenow-gcp-bynet.netlify.app',
            'x-forwarded-proto': 'https',
          },
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(authValid.ok, 'verifyPubSubPushAuth accepts signed push token', authValid.ok ? 'ok' : authValid.error, failures);

        const noAuthHandler = await invoke(pubsubHandler, {
          httpMethod: 'POST',
          headers: { host: 'dcpo-servicenow-gcp-bynet.netlify.app' },
          body: JSON.stringify(makePubSubEnvelope(makeAcceptedEvent({ entitlementId: 'sim-entitlement-no-auth' }))),
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(noAuthHandler.statusCode === 401 && parseJsonBody(noAuthHandler.body)?.error === 'missing_authorization', 'marketplace-pubsub enforces push auth when enabled', noAuthHandler.body, failures);

        const pubsubResponse = await invoke(pubsubHandler, {
          httpMethod: 'POST',
          headers: {
            authorization: `Bearer ${pubsubToken}`,
            host: 'dcpo-servicenow-gcp-bynet.netlify.app',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify(makePubSubEnvelope(makeAcceptedEvent({ entitlementId: 'sim-entitlement-202' }))),
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(pubsubResponse.statusCode === 202, 'marketplace-pubsub stores accepted offer', `status=${pubsubResponse.statusCode}, body=${pubsubResponse.body}`, failures);

        const storedAccepted = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-202'];
        expect(
          storedAccepted && storedAccepted.status === 'scheduled' && storedAccepted.approvalStatus === 'pending',
          'accepted entitlement is stored as scheduled/pending',
          storedAccepted ? JSON.stringify({
            status: storedAccepted.status,
            approvalStatus: storedAccepted.approvalStatus,
          }) : 'missing store record',
          failures,
        );

        const approvalHandler = await invoke(accountApprovalHandler, {
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entitlement_id: 'sim-entitlement-202',
            account_id: 'demo-account',
            approved_by: 'integration-test',
            approval_name: 'account-approval',
          }),
        });
        const approvalBody = parseJsonBody(approvalHandler.body);
        expect(approvalHandler.statusCode === 200 && approvalBody?.ok === true, 'marketplace-account-approval approves pending entitlement', approvalHandler.body, failures);
        expect(approvalBody?.entitlement?.approvalStatus === 'approved', 'marketplace-account-approval updates approval status', approvalHandler.body, failures);

        const approvedStoreRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-202'];
        expect(
          approvedStoreRecord && approvedStoreRecord.approvalStatus === 'approved' && approvedStoreRecord.accountId === 'demo-account',
          'approval persists account id and approved status',
          approvedStoreRecord ? JSON.stringify({
            accountId: approvedStoreRecord.accountId,
            approvalStatus: approvedStoreRecord.approvalStatus,
          }) : 'missing store record',
          failures,
        );

        const creationSeed = makeCreationEvent({ entitlementId: 'sim-entitlement-create' });
        const creationHandler = await invoke(pubsubHandler, {
          httpMethod: 'POST',
          headers: {
            authorization: `Bearer ${pubsubToken}`,
            host: 'dcpo-servicenow-gcp-bynet.netlify.app',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify(makePubSubEnvelope(creationSeed)),
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(creationHandler.statusCode === 202, 'marketplace-pubsub stores creation-requested offers', `status=${creationHandler.statusCode}`, failures);

        const creationRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-create'];
        expect(
          creationRecord && creationRecord.eventType === 'ENTITLEMENT_CREATION_REQUESTED' && creationRecord.approvalStatus === 'pending',
          'creation-requested entitlement waits for approval',
          creationRecord ? JSON.stringify({
            eventType: creationRecord.eventType,
            approvalStatus: creationRecord.approvalStatus,
          }) : 'missing store record',
          failures,
        );

        const creationApproval = await invoke(entitlementApprovalHandler, {
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entitlement_id: 'sim-entitlement-create',
            account_id: 'demo-account',
            approved_by: 'integration-test',
            approval_name: 'entitlement-approval',
          }),
        });
        const creationApprovalBody = parseJsonBody(creationApproval.body);
        expect(creationApproval.statusCode === 200 && creationApprovalBody?.ok === true, 'marketplace-entitlement-approval approves creation-requested entitlement', creationApproval.body, failures);
        expect(creationApprovalBody?.entitlement?.approvalStatus === 'approved', 'marketplace-entitlement-approval updates approval status', creationApproval.body, failures);

        const planChangeSeed = makePlanChangeEvent({ entitlementId: 'sim-entitlement-plan-change', newPendingPlan: 'ultimate', newPendingOffer: 'OFFER2' });
        await blobRuntime.getStore('marketplace-entitlements').setJSON('entitlement:sim-entitlement-plan-change', createEntitlementRecord(planChangeSeed));

        const planChangeRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-plan-change'];
        expect(
          planChangeRecord && planChangeRecord.planChangeStatus === 'pending' && planChangeRecord.pendingPlanName === 'ultimate',
          'plan change request is stored as pending',
          planChangeRecord ? JSON.stringify({
            planChangeStatus: planChangeRecord.planChangeStatus,
            pendingPlanName: planChangeRecord.pendingPlanName,
          }) : 'missing store record',
          failures,
        );

        const planChangeApproval = await invoke(planChangeApprovalHandler, {
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entitlement_id: 'sim-entitlement-plan-change',
            pending_plan_name: 'ultimate',
            approved_by: 'integration-test',
            reason: 'Approved through simulator',
          }),
        });
        const planChangeApprovalBody = parseJsonBody(planChangeApproval.body);
        expect(planChangeApproval.statusCode === 200 && planChangeApprovalBody?.ok === true, 'marketplace-plan-change-approval approves pending plan changes', planChangeApproval.body, failures);
        expect(planChangeApprovalBody?.entitlement?.planChangeStatus === 'approved', 'marketplace-plan-change-approval updates plan change status', planChangeApproval.body, failures);

        const planChangedSeed = makePlanChangedEvent({ entitlementId: 'sim-entitlement-plan-change', newPendingPlan: 'ultimate' });
        const planChangedHandler = await invoke(pubsubHandler, {
          httpMethod: 'POST',
          headers: {
            authorization: `Bearer ${pubsubToken}`,
            host: 'dcpo-servicenow-gcp-bynet.netlify.app',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify(makePubSubEnvelope(planChangedSeed)),
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(planChangedHandler.statusCode === 202, 'marketplace-pubsub stores plan-changed event', `status=${planChangedHandler.statusCode}`, failures);

        const planChangedRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-plan-change'];
        expect(
          planChangedRecord && planChangedRecord.eventType === 'ENTITLEMENT_PLAN_CHANGED',
          'plan change completion updates event type',
          planChangedRecord ? JSON.stringify({
            eventType: planChangedRecord.eventType,
            plan: planChangedRecord.entitlement && planChangedRecord.entitlement.plan,
          }) : 'missing store record',
          failures,
        );

        const endedHandler = await invoke(pubsubHandler, {
          httpMethod: 'POST',
          headers: {
            authorization: `Bearer ${pubsubToken}`,
            host: 'dcpo-servicenow-gcp-bynet.netlify.app',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify(makePubSubEnvelope(makeOfferEndedEvent({ entitlementId: 'sim-entitlement-ended' }))),
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(endedHandler.statusCode === 202, 'marketplace-pubsub stores offer-ended events', `status=${endedHandler.statusCode}`, failures);

        const endedRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-ended'];
        expect(
          endedRecord && endedRecord.status === 'expired' && endedRecord.eventType === 'ENTITLEMENT_OFFER_ENDED',
          'offer-ended entitlement is marked expired',
          endedRecord ? JSON.stringify({
            status: endedRecord.status,
            eventType: endedRecord.eventType,
          }) : 'missing store record',
          failures,
        );

        const rejectedSeed = makeAcceptedEvent({
          entitlementId: 'sim-entitlement-rejected',
          start: makeFutureIso(-2),
          end: makeFutureIso(28),
        });
        const rejectedHandler = await invoke(pubsubHandler, {
          httpMethod: 'POST',
          headers: {
            authorization: `Bearer ${pubsubToken}`,
            host: 'dcpo-servicenow-gcp-bynet.netlify.app',
            'x-forwarded-proto': 'https',
          },
          body: JSON.stringify(makePubSubEnvelope(rejectedSeed)),
          path: '/.netlify/functions/marketplace-pubsub',
        });
        expect(rejectedHandler.statusCode === 202, 'marketplace-pubsub stores past-start offers', `status=${rejectedHandler.statusCode}`, failures);

        const rejectedRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-rejected'];
        expect(
          rejectedRecord && rejectedRecord.status === 'rejected' && rejectedRecord.approvalStatus === 'rejected',
          'past-start entitlement is automatically rejected',
          rejectedRecord ? JSON.stringify({
            status: rejectedRecord.status,
            approvalStatus: rejectedRecord.approvalStatus,
          }) : 'missing store record',
          failures,
        );

        const rejectedApproval = await invoke(accountApprovalHandler, {
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entitlement_id: 'sim-entitlement-rejected',
            account_id: 'demo-account',
            approved_by: 'integration-test',
            approval_name: 'account-approval',
          }),
        });
        const rejectedApprovalBody = parseJsonBody(rejectedApproval.body);
        expect(
          rejectedApproval.statusCode === 200 && rejectedApprovalBody?.entitlement?.approvalStatus === 'rejected',
          'approval handler does not resurrect rejected entitlements',
          rejectedApproval.body,
          failures,
        );

        const reconcileSeed = {
          eventId: 'evt-reconcile',
          eventType: 'ENTITLEMENT_OFFER_ACCEPTED',
          entitlement: {
            id: 'sim-entitlement-reconcile',
            updateTime: makeFutureIso(0),
            newPendingOfferDuration: 'P30D',
            newOfferStartTime: makeFutureIso(-1),
            newOfferEndTime: makeFutureIso(29),
          },
          receivedAt: makeFutureIso(-2),
          approvalRequired: true,
          approvalStatus: 'pending',
          status: 'scheduled',
        };
        await blobRuntime.getStore('marketplace-entitlements').setJSON('entitlement:sim-entitlement-reconcile', reconcileSeed);

        const reconcileResult = await invoke(reconcileHandler, {
          httpMethod: 'GET',
          headers: { host: 'dcpo-servicenow-gcp-bynet.netlify.app' },
          path: '/.netlify/functions/marketplace-entitlements-reconcile',
        });
        const reconcileBody = parseJsonBody(reconcileResult.body);
        expect(reconcileResult.statusCode === 200 && reconcileBody?.ok === true, 'marketplace-entitlements-reconcile runs successfully', reconcileResult.body, failures);

        const reconciledRecord = blobRuntime.dump('marketplace-entitlements')['entitlement:sim-entitlement-reconcile'];
        expect(
          reconciledRecord && reconciledRecord.status === 'rejected',
          'reconcile updates overdue pending offers to rejected',
          reconciledRecord ? JSON.stringify({
            status: reconciledRecord.status,
            approvalStatus: reconciledRecord.approvalStatus,
          }) : 'missing store record',
          failures,
        );
      });
    });
  } finally {
    blobRuntime.restore();
  }
}

async function googleApiSuite(failures) {
  console.log('\n=== Google Marketplace API helper contract ===');
  const serviceAccount = makeRsaKeyMaterial('service-account');
  const providerId = 'provider-123';
  const issuedToken = 'access-token-123';
  const calls = [];

  await withEnv({
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: 'svc@example.iam.gserviceaccount.com',
      private_key: serviceAccount.privateKey,
      token_uri: GOOGLE_TOKEN_URL,
    }),
    GOOGLE_MARKETPLACE_PROVIDER_ID: providerId,
  }, async () => {
    await withFetchStub([
      {
        match: GOOGLE_TOKEN_URL,
        handle: async (url, options) => {
          calls.push({ url, options });
          return createResponse({ json: { access_token: issuedToken } });
        },
      },
      {
        match: new RegExp(`${GOOGLE_COMMERCE_API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
        handle: async (url, options) => {
          calls.push({ url, options });
          return createResponse({ json: { ok: true, url, method: options.method } });
        },
      },
    ], async () => {
      const tokenResult = await getAccessToken();
      expect(tokenResult.ok && tokenResult.token === issuedToken, 'getAccessToken exchanges service-account JWT', tokenResult.ok ? 'ok' : tokenResult.error, failures);

      const accountApproval = await approveMarketplaceAccount({
        accountId: 'customer-001',
        approvalName: 'signup',
        reason: 'Approved through simulator',
      });
      expect(accountApproval.ok, 'approveMarketplaceAccount calls Google Commerce API', accountApproval.ok ? 'ok' : accountApproval.error, failures);

      const entitlementApproval = await approveMarketplaceEntitlement({
        entitlementId: 'entitlement-001',
        reason: 'Approved through simulator',
      });
      expect(entitlementApproval.ok, 'approveMarketplaceEntitlement calls Google Commerce API', entitlementApproval.ok ? 'ok' : entitlementApproval.error, failures);

      const entitlementRejection = await rejectMarketplaceEntitlement({
        entitlementId: 'entitlement-002',
        reason: 'Rejected through simulator',
      });
      expect(entitlementRejection.ok, 'rejectMarketplaceEntitlement calls Google Commerce API', entitlementRejection.ok ? 'ok' : entitlementRejection.error, failures);

      const planChangeApproval = await approveMarketplacePlanChange({
        entitlementId: 'entitlement-003',
        pendingPlanName: 'ultimate',
        reason: 'Approved through simulator',
      });
      expect(planChangeApproval.ok, 'approveMarketplacePlanChange calls Google Commerce API', planChangeApproval.ok ? 'ok' : planChangeApproval.error, failures);
    });
  });

  const tokenCall = calls.find((call) => call.url === GOOGLE_TOKEN_URL);
  const approveCall = calls.find((call) => call.url.includes('/accounts/customer-001:approve'));
  const entitlementApproveCall = calls.find((call) => call.url.includes('/entitlements/entitlement-001:approve'));
  const entitlementRejectCall = calls.find((call) => call.url.includes('/entitlements/entitlement-002:reject'));
  const planChangeApproveCall = calls.find((call) => call.url.includes('/entitlements/entitlement-003:approvePlanChange'));

  expect(!!tokenCall, 'service-account token exchange was attempted', tokenCall ? 'seen' : 'missing', failures);
  expect(!!approveCall, 'account approval path was requested', approveCall ? approveCall.url : 'missing', failures);
  expect(!!entitlementApproveCall, 'entitlement approval path was requested', entitlementApproveCall ? entitlementApproveCall.url : 'missing', failures);
  expect(!!entitlementRejectCall, 'entitlement rejection path was requested', entitlementRejectCall ? entitlementRejectCall.url : 'missing', failures);
  expect(!!planChangeApproveCall, 'plan change approval path was requested', planChangeApproveCall ? planChangeApproveCall.url : 'missing', failures);
}

async function htmlContractSuite(failures) {
  console.log('\n=== Local HTML contract ===');
  const signupHtml = fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf8');
  const loginHtml = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
  const entitlementHtml = fs.readFileSync(path.join(ROOT, 'entitlement-status', 'index.html'), 'utf8');
  const accessHelpHtml = fs.readFileSync(path.join(ROOT, 'access-help', 'index.html'), 'utf8');
  const signupSimulatorHtml = fs.readFileSync(path.join(ROOT, 'signup-simulator', 'index.html'), 'utf8');

  checkStaticPage(
    path.join(ROOT, 'signup.html'),
    ['id="gcp-actions"', 'id="gcp-status-link"', 'View Entitlement Status', 'approval_mode', 'approval_status', 'offer_state'],
    'signup page exposes Marketplace guidance controls',
    failures,
  );
  checkStaticPage(
    path.join(ROOT, 'login.html'),
    ['/signup', '/marketplace', '/instance-help', '/privacy', '/terms', '/contact', '/access-help', 'Sign in to ServiceNow'],
    'login page keeps navigation inside the site before external handoff',
    failures,
  );
  checkStaticPage(
    path.join(ROOT, 'entitlement-status', 'index.html'),
    ['Approve Customer Account', 'Approval Status', 'Account ID', '/login', '/contact'],
    'entitlement status page exposes approval workflow and recovery links',
    failures,
  );
  checkStaticPage(
    path.join(ROOT, 'access-help', 'index.html'),
    ['Complete Access With Your Service Provider', 'Back to Login', 'Open Entered Instance Anyway'],
    'access-help page provides guided instance handoff',
    failures,
  );
  checkStaticPage(
    path.join(ROOT, 'signup-simulator', 'index.html'),
    ['Signup Flow Simulator', 'Run Selected Request', 'Run Full Matrix', 'Contract replay', 'Live endpoint attempt', 'Transcript'],
    'signup simulator page exposes replay controls',
    failures,
  );

  checkLinks(loginHtml, ['/signup', '/marketplace', '/instance-help'], 'login page links to all internal support pages', failures);
  checkLinks(signupHtml, ['/login', '/entitlement-status/'], 'signup page links back to login and entitlement tracking', failures);
  checkLinks(entitlementHtml, ['/login', '/contact', '/instance-help'], 'entitlement status page links to recovery pages', failures);
  checkLinks(accessHelpHtml, ['/login', '/contact', '/instance-help'], 'access-help page keeps the workflow inside the app', failures);
  checkLinks(signupSimulatorHtml, ['/signup', '/login'], 'signup simulator page keeps navigation inside the app', failures);
}

async function lifecycleSuite(failures) {
  console.log('\n=== Entitlement lifecycle ===');
  const accepted = createEntitlementRecord(makeAcceptedEvent({ entitlementId: 'sim-entitlement-accepted' }));
  expect(accepted.status === 'scheduled', 'accepted offer starts scheduled', accepted.status, failures);
  expect(accepted.approvalStatus === 'pending', 'accepted offer waits for approval', accepted.approvalStatus, failures);
  expect(
    summarizeEntitlementState(accepted).includes('waiting on customer account approval'),
    'summary explains pending approval',
    summarizeEntitlementState(accepted),
    failures,
  );

  const approved = approveEntitlementRecord(accepted, {
    approvedBy: 'sim-account-admin',
    accountId: 'sim-account',
  });
  expect(approved.approvalStatus === 'approved', 'approval records approved status', approved.approvalStatus, failures);
  expect(approved.accountId === 'sim-account', 'approval stores account id', String(approved.accountId), failures);

  const active = computeLifecycle(
    {
      ...approved,
      entitlement: {
        ...approved.entitlement,
        newOfferStartTime: makeFutureIso(-1),
        newOfferEndTime: makeFutureIso(29),
      },
    },
    Date.now(),
  );
  expect(active.status === 'active', 'approved offer becomes active at start time', active.status, failures);

  const rejected = computeLifecycle(
    createEntitlementRecord(makeAcceptedEvent({
      entitlementId: 'sim-entitlement-rejected',
      start: makeFutureIso(-1),
      end: makeFutureIso(29),
    })),
    Date.now(),
  );
  expect(rejected.status === 'rejected', 'missing approval at start time triggers rejection', rejected.status, failures);
  expect(
    summarizeEntitlementState(rejected).includes('automatically rejected'),
    'summary explains automatic rejection',
    summarizeEntitlementState(rejected),
    failures,
  );

  const expired = computeLifecycle(
    {
      ...approved,
      entitlement: {
        ...approved.entitlement,
        newOfferStartTime: makeFutureIso(-45),
        newOfferEndTime: makeFutureIso(-15),
      },
    },
    Date.now(),
  );
  expect(expired.status === 'expired', 'ended offer becomes expired after end time', expired.status, failures);

  const amendment = createEntitlementRecord(makeAcceptedEvent({
    entitlementId: 'sim-entitlement-amendment',
    eventId: 'evt-sim-amendment',
    newPendingOfferDuration: 'P60D',
    start: makeFutureIso(14),
    end: makeFutureIso(74),
  }));
  expect(amendment.status === 'scheduled', 'amendment stays scheduled until its later start', amendment.status, failures);
  expect(amendment.entitlement.newPendingOfferDuration === 'P60D', 'amendment duration is preserved', amendment.entitlement.newPendingOfferDuration, failures);
}

async function handlerContractSuite(failures) {
  console.log('\n=== Handler contract and reconciliation ===');
  const blobRuntime = installBlobMock();
  const accountApprovalHandler = freshRequire('../netlify/functions/marketplace-account-approval');
  const wrapperApprovalHandler = freshRequire('../netlify/functions/marketplace-entitlement-approval');
  const pubsubHandler = freshRequire('../netlify/functions/marketplace-pubsub');
  const reconcileHandler = freshRequire('../netlify/functions/marketplace-entitlements-reconcile');

  try {
    const store = blobRuntime.getStore('marketplace-entitlements');
    await store.setJSON('entitlement:manual-rejected', {
      eventId: 'evt-manual-rejected',
      eventType: 'ENTITLEMENT_OFFER_ACCEPTED',
      entitlement: {
        id: 'manual-rejected',
        updateTime: makeFutureIso(0),
        newPendingOfferDuration: 'P30D',
        newOfferStartTime: makeFutureIso(-1),
        newOfferEndTime: makeFutureIso(29),
      },
      raw: { source: 'seed' },
      receivedAt: makeFutureIso(-2),
      isAutomaticApproval: true,
      approvalRequired: true,
      approvalStatus: 'rejected',
      approvalRejectedAt: makeFutureIso(-1),
      approvalRejectionReason: 'approval_not_completed_before_start',
      status: 'rejected',
      activationStartTime: makeFutureIso(-1),
      activationEndTime: makeFutureIso(29),
    });

    const rejectedApproval = await invoke(accountApprovalHandler, {
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entitlement_id: 'manual-rejected',
        account_id: 'demo-account',
        approved_by: 'integration-test',
        approval_name: 'account-approval',
      }),
    });
    const rejectedApprovalBody = parseJsonBody(rejectedApproval.body);
    expect(
      rejectedApproval.statusCode === 200 && rejectedApprovalBody?.entitlement?.approvalStatus === 'rejected',
      'approval handler leaves rejected entitlements rejected',
      rejectedApproval.body,
      failures,
    );

    const wrapperApproval = await invoke(wrapperApprovalHandler, {
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entitlement_id: 'manual-rejected',
        account_id: 'demo-account',
        approved_by: 'integration-test',
        approval_name: 'account-approval',
      }),
    });
    const wrapperBody = parseJsonBody(wrapperApproval.body);
    expect(
      wrapperApproval.statusCode === 200 && wrapperBody?.entitlement?.approvalStatus === 'rejected',
      'compatibility approval wrapper behaves like account approval handler',
      wrapperApproval.body,
      failures,
    );

    const noAccountApproval = await invoke(accountApprovalHandler, {
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entitlement_id: 'manual-rejected',
      }),
    });
    const noAccountApprovalBody = parseJsonBody(noAccountApproval.body);
    expect(
      noAccountApproval.statusCode === 400 && noAccountApprovalBody?.error === 'missing_account_id',
      'approval handler rejects missing account id',
      noAccountApproval.body,
      failures,
    );

    const noAuthPubsub = await invoke(pubsubHandler, {
      httpMethod: 'POST',
      headers: { host: 'dcpo-servicenow-gcp-bynet.netlify.app' },
      body: JSON.stringify(makePubSubEnvelope(makeAcceptedEvent({ entitlementId: 'manual-pubsub' }))),
      path: '/.netlify/functions/marketplace-pubsub',
    });
    expect(noAuthPubsub.statusCode === 202, 'marketplace-pubsub accepts envelope when auth is not required', noAuthPubsub.body, failures);

    const acceptedManual = await store.get('entitlement:manual-pubsub');
    expect(
      acceptedManual && acceptedManual.status === 'scheduled' && acceptedManual.approvalStatus === 'pending',
      'pubsub handler stores accepted entitlement in blobs store',
      acceptedManual ? JSON.stringify({
        status: acceptedManual.status,
        approvalStatus: acceptedManual.approvalStatus,
      }) : 'missing store record',
      failures,
    );

    const reconcileResult = await invoke(reconcileHandler, {
      httpMethod: 'GET',
      headers: { host: 'dcpo-servicenow-gcp-bynet.netlify.app' },
      path: '/.netlify/functions/marketplace-entitlements-reconcile',
    });
    const reconcileBody = parseJsonBody(reconcileResult.body);
    expect(reconcileResult.statusCode === 200 && reconcileBody?.ok === true, 'reconcile handler runs on the in-memory store', reconcileResult.body, failures);

    const latest = await store.get('latest');
    expect(!!latest, 'reconcile updates latest entitlement pointer', latest ? latest.entitlement?.id : 'missing latest', failures);
  } finally {
    blobRuntime.restore();
  }
}

async function main() {
  const failures = [];
  console.log('Running Google Marketplace local production-grade simulation...');
  console.log(`Workspace: ${ROOT}`);

  try {
    await tokenMatrixSuite(failures);
    await loginSignupSuite(failures);
    await pubsubAndLifecycleSuite(failures);
    await googleApiSuite(failures);
    await htmlContractSuite(failures);
    await lifecycleSuite(failures);
    await handlerContractSuite(failures);
  } catch (error) {
    failures.push(error && error.stack ? error.stack : String(error));
    console.error('\nSimulation aborted unexpectedly:');
    console.error(error && error.stack ? error.stack : error);
  }

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed.`);
    for (const failure of failures) {
      console.log(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nAll Google Marketplace simulation checks passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
