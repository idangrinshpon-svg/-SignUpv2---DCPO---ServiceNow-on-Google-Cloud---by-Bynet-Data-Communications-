const crypto = require('crypto');

const MARKETPLACE_ISSUER = 'https://www.googleapis.com/robot/v1/metadata/x509/cloud-commerce-partner@system.gserviceaccount.com';
const MARKETPLACE_CERTS_URL = MARKETPLACE_ISSUER;
const ISSUER_PATH = '/robot/v1/metadata/x509/cloud-commerce-partner@system.gserviceaccount.com';
const CERT_CACHE_TTL_MS = 4 * 60 * 1000;

let certCache = {
  fetchedAt: 0,
  certs: null,
};

function base64UrlToBuffer(input) {
  let value = input.replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64');
}

function decodeJsonSegment(segment) {
  return JSON.parse(base64UrlToBuffer(segment).toString('utf8'));
}

function parseJwt(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

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

function readQueryFlag(event, key) {
  if (event?.queryStringParameters && event.queryStringParameters[key] != null) {
    const value = String(event.queryStringParameters[key]).toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
  }

  return false;
}

function normalizeAudience(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function parseAudienceList(event) {
  const values = new Set();
  const host = event?.headers?.host || event?.headers?.Host || '';
  const envAudience = process.env.MARKETPLACE_AUDIENCE || process.env.URL || '';

  if (host) {
    values.add(normalizeAudience(host));
  }

  if (envAudience) {
    String(envAudience)
      .split(',')
      .map((entry) => normalizeAudience(entry))
      .filter(Boolean)
      .forEach((entry) => values.add(entry));
  }

  return values;
}

async function fetchGoogleCerts() {
  const now = Date.now();
  if (certCache.certs && now - certCache.fetchedAt < CERT_CACHE_TTL_MS) {
    return certCache.certs;
  }

  const response = await fetch(MARKETPLACE_CERTS_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch Marketplace certs: ${response.status}`);
  }

  const certs = await response.json();
  certCache = { fetchedAt: now, certs };
  return certs;
}

function verifySignature(token, header, signingInput) {
  return fetchGoogleCerts().then((certs) => {
    const cert = certs?.[header.kid];
    if (!cert) {
      return { ok: false, error: 'unknown_kid' };
    }

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();

    const ok = verifier.verify(cert, base64UrlToBuffer(token.split('.')[2]));
    return ok ? { ok: true } : { ok: false, error: 'invalid_signature' };
  });
}

function validateClaims(payload, audiences) {
  const now = Math.floor(Date.now() / 1000);
  const issuer = payload?.iss;
  const audience = normalizeAudience(payload?.aud);
  const subject = String(payload?.sub || '').trim();

  if (issuer !== MARKETPLACE_ISSUER) {
    return { ok: false, error: 'invalid_issuer' };
  }

  if (payload?.exp && now > Number(payload.exp)) {
    return { ok: false, error: 'token_expired' };
  }

  if (!subject) {
    return { ok: false, error: 'missing_sub' };
  }

  if (audiences.size && !audiences.has(audience)) {
    return { ok: false, error: 'invalid_audience' };
  }

  const google = payload?.google || {};
  const userIdentity = String(google.user_identity || '').trim();
  if (!userIdentity) {
    return { ok: false, error: 'missing_user_identity' };
  }

  return { ok: true };
}

async function verifyMarketplaceToken(event, token, options = {}) {
  const parsed = parseJwt(token);
  if (!parsed) {
    return { ok: false, error: 'invalid_token' };
  }

  if (parsed.header?.alg !== 'RS256' && !options.demo) {
    return { ok: false, error: 'invalid_algorithm' };
  }

  const audiences = parseAudienceList(event);
  const claims = validateClaims(parsed.payload, audiences);
  if (!claims.ok) {
    return claims;
  }

  if (options.demo) {
    return { ok: true, payload: parsed.payload, demo: true };
  }

  if (!parsed.header?.kid) {
    return { ok: false, error: 'missing_kid' };
  }

  const signatureResult = await verifySignature(token, parsed.header, parsed.signingInput);
  if (!signatureResult.ok) {
    return signatureResult;
  }

  return { ok: true, payload: parsed.payload, demo: false };
}

function isDemoRequest(event) {
  if (readQueryFlag(event, 'demo')) {
    return true;
  }

  const header = event?.headers?.['x-marketplace-demo'] || event?.headers?.['X-Marketplace-Demo'] || '';
  return String(header).toLowerCase() === '1' || String(header).toLowerCase() === 'true';
}

function extractRequestParams(event) {
  const params = new URLSearchParams(event.body || '');
  const demo = isDemoRequest(event) || String(params.get('demo') || '').toLowerCase() === '1';
  const token = params.get('x-gcp-marketplace-token') || '';

  return { demo, token };
}

function buildVerifiedParams(payload) {
  const params = new URLSearchParams();
  params.set('verified', '1');
  params.set('gcp_account_id', payload?.sub || '');
  params.set('gcp_user_identity', payload?.google?.user_identity || '');
  params.set('gcp_roles', Array.isArray(payload?.google?.roles) ? payload.google.roles.join(',') : '');
  if (Array.isArray(payload?.google?.orders) && payload.google.orders.length) {
    params.set('gcp_orders', payload.google.orders.join(','));
  }
  return params;
}

module.exports = {
  MARKETPLACE_CERTS_URL,
  MARKETPLACE_ISSUER,
  buildVerifiedParams,
  extractRequestParams,
  isDemoRequest,
  normalizeAudience,
  parseJwt,
  verifyMarketplaceToken,
};
