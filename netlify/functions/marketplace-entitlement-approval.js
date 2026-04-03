const { connectLambda, getStore } = require('@netlify/blobs');
const { approveEntitlementRecord } = require('./_shared/entitlement-lifecycle');

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

function extractBody(event) {
  const parsed = safeJsonParse(event.body);
  if (parsed && typeof parsed === 'object') {
    return parsed;
  }

  const params = new URLSearchParams(event.body || '');
  const body = {};
  for (const [key, value] of params.entries()) {
    body[key] = value;
  }
  return body;
}

async function loadStore(event) {
  connectLambda(event);
  return getStore(STORE_NAME);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = extractBody(event);
  const entitlementId = String(body.entitlement_id || body.entitlementId || '').trim();
  const approvedBy = String(body.approved_by || body.approvedBy || body.account || 'manual').trim() || 'manual';

  if (!entitlementId) {
    return response(400, { error: 'missing_entitlement_id' });
  }

  const store = await loadStore(event);
  const key = `entitlement:${entitlementId}`;
  const record = await store.get(key, { type: 'json' });
  if (!record) {
    return response(404, { error: 'not_found', key });
  }

  if (record.status === 'rejected') {
    return response(409, {
      error: 'already_rejected',
      key,
      status: record.status,
      approvalStatus: record.approvalStatus || 'rejected',
      entitlement: record.entitlement,
    });
  }

  const approved = approveEntitlementRecord(record, { approvedBy });
  await store.setJSON(key, approved);
  await store.setJSON('latest', approved);

  return response(200, {
    ok: true,
    key,
    status: approved.status,
    approvalStatus: approved.approvalStatus,
    approvalApprovedAt: approved.approvalApprovedAt || null,
    entitlement: approved.entitlement,
  });
};
