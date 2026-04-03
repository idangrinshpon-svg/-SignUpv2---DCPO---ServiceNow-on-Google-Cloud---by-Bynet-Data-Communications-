const { connectLambda, getStore } = require('@netlify/blobs');
const { computeLifecycle } = require('./_shared/entitlement-lifecycle');

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

async function loadStore(event) {
  connectLambda(event);
  return getStore(STORE_NAME);
}

async function listEntitlementKeys(store) {
  const keys = [];
  for await (const page of store.list({ prefix: 'entitlement:', paginate: true })) {
    for (const blob of page.blobs || []) {
      keys.push(blob.key);
    }
  }
  return keys;
}

exports.handler = async (event) => {
  const store = await loadStore(event);
  const now = Date.now();
  const keys = await listEntitlementKeys(store);
  const updated = [];
  let latestRecord = null;

  for (const key of keys) {
    const record = await store.get(key, { type: 'json' });
    if (!record) continue;

    const next = computeLifecycle(record, now);
    const changed = JSON.stringify(next) !== JSON.stringify(record);
    if (changed) {
      await store.setJSON(key, next);
      updated.push(key);
    }

    if (!latestRecord || new Date(next.receivedAt || 0).getTime() >= new Date(latestRecord.receivedAt || 0).getTime()) {
      latestRecord = next;
    }
  }

  if (latestRecord) {
    await store.setJSON('latest', latestRecord);
  }

  return response(200, {
    ok: true,
    updated,
    reconciled: keys.length,
    latest: latestRecord ? {
      entitlementId: latestRecord.entitlement?.id || null,
      status: latestRecord.status,
      approvalStatus: latestRecord.approvalStatus,
      approvalApprovedAt: latestRecord.approvalApprovedAt || null,
      approvalRejectedAt: latestRecord.approvalRejectedAt || null,
    } : null,
  });
};
