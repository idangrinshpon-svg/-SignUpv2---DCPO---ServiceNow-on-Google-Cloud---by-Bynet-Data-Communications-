const crypto = require('crypto');

const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CERT_CACHE_TTL_MS = 4 * 60 * 1000;

let certCache = {
  fetchedAt: 0,
  certs: null,
};

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function base64UrlToBuffer(input) {
  let value = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64');
}

function decodeJsonSegment(segment) {
  return JSON.parse(base64UrlToBuffer(segment).toString('utf8'));
}

function parseJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: decodeJsonSegment(parts[0]),
      payload: decodeJsonSegment(parts[1]),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: parts[2],
    };
  } catch (error) {
    return null;
  }
}

function extractBearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function buildRequestUrl(event) {
  const proto = String(event?.headers?.['x-forwarded-proto'] || event?.headers?.['X-Forwarded-Proto'] || 'https').split(',')[0].trim();
  const host = String(event?.headers?.host || event?.headers?.Host || '').split(',')[0].trim();
  const path = String(event?.path || event?.rawPath || '/').trim() || '/';
  if (!host) return '';
  return `${proto}://${host}${path}`;
}

function expectedAudience(event) {
  return String(process.env.PUBSUB_PUSH_AUDIENCE || buildRequestUrl(event) || '').trim();
}

function expectedEmail() {
  return String(process.env.PUBSUB_PUSH_EMAIL || process.env.PUBSUB_PUSH_SERVICE_ACCOUNT || '').trim();
}

async function fetchGoogleCerts() {
  const now = Date.now();
  if (certCache.certs && now - certCache.fetchedAt < CERT_CACHE_TTL_MS) {
    return certCache.certs;
  }

  const response = await fetch(GOOGLE_OIDC_CERTS_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch Pub/Sub certs: ${response.status}`);
  }

  const certs = await response.json();
  certCache = { fetchedAt: now, certs };
  return certs;
}

async function verifyPubSubPushAuth(event) {
  const bearerToken = extractBearerToken(event?.headers || {});
  if (!bearerToken) {
    if (String(process.env.PUBSUB_REQUIRE_AUTH || '').toLowerCase() === '1' || String(process.env.PUBSUB_REQUIRE_AUTH || '').toLowerCase() === 'true') {
      return { ok: false, error: 'missing_authorization' };
    }

    return { ok: true, skipped: true };
  }

  const parsed = parseJwt(bearerToken);
  if (!parsed) {
    return { ok: false, error: 'invalid_token' };
  }

  if (parsed.header?.alg !== 'RS256') {
    return { ok: false, error: 'invalid_algorithm' };
  }

  const certs = await fetchGoogleCerts();
  const cert = certs?.[parsed.header.kid];
  if (!cert) {
    return { ok: false, error: 'unknown_kid' };
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parsed.signingInput);
  verifier.end();

  const ok = verifier.verify(cert, base64UrlToBuffer(parsed.signature));
  if (!ok) {
    return { ok: false, error: 'invalid_signature' };
  }

  const payload = parsed.payload || {};
  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    return { ok: false, error: 'invalid_issuer' };
  }

  const audience = expectedAudience(event);
  if (audience && String(payload.aud || '').trim() !== audience) {
    return { ok: false, error: 'invalid_audience' };
  }

  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    return { ok: false, error: 'unverified_email' };
  }

  const expected = expectedEmail();
  if (expected && String(payload.email || '').trim() !== expected) {
    return { ok: false, error: 'unexpected_email' };
  }

  return { ok: true, claim: payload };
}

function decodePubSubEnvelope(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (input.eventType && input.entitlement) {
    return input;
  }

  const data = input?.message?.data;
  if (typeof data === 'string' && data) {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    const parsed = safeJsonParse(decoded);
    if (parsed) return parsed;
    return safeJsonParse(data);
  }

  if (input?.message?.json) {
    return input.message.json;
  }

  return input.payload && typeof input.payload === 'object' ? input.payload : null;
}

module.exports = {
  decodePubSubEnvelope,
  expectedAudience,
  verifyPubSubPushAuth,
};
