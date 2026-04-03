const { connectLambda, getStore } = require('@netlify/blobs');
const { computeLifecycle, createEntitlementRecord } = require('./_shared/entitlement-lifecycle');

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

    const current = computeLifecycle(record);
    if (JSON.stringify(current) !== JSON.stringify(record)) {
      await store.setJSON(key, current);
      if (key !== 'latest') {
        const latestRecord = await store.get('latest', { type: 'json' });
        if (latestRecord && latestRecord.entitlement && latestRecord.entitlement.id === current.entitlement.id) {
          await store.setJSON('latest', current);
        }
      }
      return response(200, current);
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

  const record = createEntitlementRecord(payload);
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
    approvalStatus: record.approvalStatus,
    entitlement: record.entitlement,
  });
};
