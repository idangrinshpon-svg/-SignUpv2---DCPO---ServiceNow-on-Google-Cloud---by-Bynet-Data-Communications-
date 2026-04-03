const { connectLambda, getStore } = require('@netlify/blobs');

const STORE_NAME = 'marketplace-entitlements';
const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  };
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function decodePubSubEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.eventType && payload.entitlement) {
    return payload;
  }

  const data = payload?.message?.data;
  if (typeof data === 'string' && data) {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    const parsed = safeJsonParse(decoded);
    if (parsed) {
      return parsed;
    }
  }

  return payload?.message?.json || null;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function computeStatus(entitlement) {
  const now = Date.now();
  const start = isoOrNull(entitlement.newOfferStartTime);
  const end = isoOrNull(entitlement.newOfferEndTime);
  const startMs = start ? Date.parse(start) : NaN;
  const endMs = end ? Date.parse(end) : NaN;

  if (Number.isFinite(startMs) && now < startMs) {
    return 'scheduled';
  }

  if (Number.isFinite(endMs) && now > endMs) {
    return 'expired';
  }

  if (start || end) {
    return 'active';
  }

  return 'accepted';
}

function normalizeEvent(payload) {
  const entitlement = payload.entitlement || {};
  const entitlementId = String(entitlement.id || payload.entitlementId || payload.id || '').trim();
  const eventType = String(payload.eventType || 'ENTITLEMENT_OFFER_ACCEPTED').trim();
  const normalized = {
    eventId: String(payload.eventId || payload.messageId || '').trim() || null,
    eventType,
    entitlement: {
      id: entitlementId,
      updateTime: isoOrNull(entitlement.updateTime),
      newPendingOfferDuration: entitlement.newPendingOfferDuration || null,
      newOfferStartTime: isoOrNull(entitlement.newOfferStartTime),
      newOfferEndTime: isoOrNull(entitlement.newOfferEndTime),
    },
    raw: payload,
  };

  normalized.status = computeStatus(normalized.entitlement);
  normalized.receivedAt = new Date().toISOString();
  normalized.isAutomaticApproval = eventType === 'ENTITLEMENT_OFFER_ACCEPTED';
  return normalized;
}

async function loadStore(event) {
  connectLambda(event);
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  const store = await loadStore(event);

  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const entitlementId = params.get('entitlement_id');
    const key = entitlementId ? `entitlement:${entitlementId}` : 'latest';
    const record = await store.get(key, { type: 'json' });

    if (!record) {
      return response(404, { error: 'not_found', key });
    }

    return response(200, record);
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const payload = decodePubSubEnvelope(safeJsonParse(event.body));
  if (!payload) {
    return response(400, { error: 'invalid_payload' });
  }

  const record = normalizeEvent(payload);
  if (!record.entitlement.id) {
    return response(400, { error: 'missing_entitlement_id' });
  }

  const key = `entitlement:${record.entitlement.id}`;
  await store.setJSON(key, record);
  await store.setJSON('latest', record);

  return response(202, {
    ok: true,
    key,
    status: record.status,
    entitlement: record.entitlement,
  });
};
