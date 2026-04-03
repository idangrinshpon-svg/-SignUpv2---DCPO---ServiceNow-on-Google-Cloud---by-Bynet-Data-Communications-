const { connectLambda, getStore } = require('@netlify/blobs');
const { createEntitlementRecord } = require('./_shared/entitlement-lifecycle');
const { decodePubSubEnvelope, verifyPubSubPushAuth } = require('./_shared/pubsub');

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

async function loadStore(event) {
  connectLambda(event);
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const auth = await verifyPubSubPushAuth(event);
  if (!auth.ok) {
    return response(401, { error: auth.error });
  }

  const rawBody = safeJsonParse(event.body);
  const payload = decodePubSubEnvelope(rawBody);
  if (!payload) {
    return response(400, { error: 'invalid_payload' });
  }

  const record = createEntitlementRecord(payload);
  if (!record.entitlement.id) {
    return response(400, { error: 'missing_entitlement_id' });
  }

  const store = await loadStore(event);
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
