const crypto = require('crypto');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_COMMERCE_API_BASE = 'https://cloudcommerceprocurement.googleapis.com/v1';
const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;

let tokenCache = {
  fetchedAt: 0,
  token: null,
};

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function readServiceAccount() {
  const raw =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.MARKETPLACE_SERVICE_ACCOUNT_JSON ||
    '';

  if (!raw) {
    return null;
  }

  const parsed = safeJsonParse(raw);
  if (!parsed || !parsed.client_email || !parsed.private_key) {
    return null;
  }

  return parsed;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signJwt(privateKey, payload) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getAccessToken() {
  const serviceAccount = readServiceAccount();
  if (!serviceAccount) {
    return { ok: false, skipped: true, error: 'missing_service_account' };
  }

  const now = Date.now();
  if (tokenCache.token && now - tokenCache.fetchedAt < ACCESS_TOKEN_TTL_MS) {
    return { ok: true, token: tokenCache.token, skipped: false };
  }

  const tokenUri = serviceAccount.token_uri || GOOGLE_TOKEN_URL;
  const iat = Math.floor(now / 1000);
  const jwt = signJwt(serviceAccount.private_key, {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat,
    exp: iat + 3600,
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `token_exchange_failed:${response.status}:${text}` };
  }

  const json = await response.json();
  if (!json.access_token) {
    return { ok: false, error: 'missing_access_token' };
  }

  tokenCache = {
    fetchedAt: now,
    token: json.access_token,
  };

  return { ok: true, token: json.access_token, skipped: false };
}

async function callMarketplaceApi(method, path, body) {
  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return tokenResult;
  }

  const response = await fetch(`${GOOGLE_COMMERCE_API_BASE}/${String(path || '').replace(/^\/+/, '')}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokenResult.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `${response.status}:${text}` };
  }

  const text = await response.text();
  return { ok: true, responseBody: text ? safeJsonParse(text) || text : null };
}

function providerId() {
  return String(process.env.GOOGLE_MARKETPLACE_PROVIDER_ID || process.env.MARKETPLACE_PROVIDER_ID || '').trim();
}

function requireProviderId() {
  const value = providerId();
  return value || null;
}

async function approveMarketplaceAccount({ accountId, approvalName = 'signup', reason = 'Approved through Netlify workflow' }) {
  const provider = requireProviderId();
  if (!provider) {
    return { ok: false, skipped: true, error: 'missing_provider_id' };
  }

  const path = `providers/${provider}/accounts/${encodeURIComponent(accountId)}:approve`;
  return callMarketplaceApi('POST', path, { approvalName, reason });
}

async function approveMarketplaceEntitlement({ entitlementId, reason = 'Approved through Netlify workflow' }) {
  const provider = requireProviderId();
  if (!provider) {
    return { ok: false, skipped: true, error: 'missing_provider_id' };
  }

  const path = `providers/${provider}/entitlements/${encodeURIComponent(entitlementId)}:approve`;
  return callMarketplaceApi('POST', path, { reason });
}

async function rejectMarketplaceEntitlement({ entitlementId, reason = 'Rejected through Netlify workflow' }) {
  const provider = requireProviderId();
  if (!provider) {
    return { ok: false, skipped: true, error: 'missing_provider_id' };
  }

  const path = `providers/${provider}/entitlements/${encodeURIComponent(entitlementId)}:reject`;
  return callMarketplaceApi('POST', path, { reason });
}

async function approveMarketplacePlanChange({ entitlementId, pendingPlanName, reason = 'Approved through Netlify workflow' }) {
  const provider = requireProviderId();
  if (!provider) {
    return { ok: false, skipped: true, error: 'missing_provider_id' };
  }

  const path = `providers/${provider}/entitlements/${encodeURIComponent(entitlementId)}:approvePlanChange`;
  return callMarketplaceApi('POST', path, { pendingPlanName, reason });
}

module.exports = {
  approveMarketplaceAccount,
  approveMarketplaceEntitlement,
  approveMarketplacePlanChange,
  rejectMarketplaceEntitlement,
  callMarketplaceApi,
  getAccessToken,
  providerId,
};
