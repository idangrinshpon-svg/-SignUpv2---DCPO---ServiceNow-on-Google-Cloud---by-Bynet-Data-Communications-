const { connectLambda, getStore } = require('@netlify/blobs');
const { approveMarketplacePlanChange } = require('./_shared/google-marketplace-api');
const { approvePlanChangeRecord } = require('./_shared/entitlement-lifecycle');

const ENTITLEMENT_STORE = 'marketplace-entitlements';
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
  return getStore(ENTITLEMENT_STORE);
}

async function updateLatestEntitlement(store, entitlementId, updater) {
  const key = `entitlement:${entitlementId}`;
  const record = await store.get(key, { type: 'json' });
  if (!record) {
    return null;
  }

  if (record.status === 'rejected') {
    return record;
  }

  const updated = updater(record);
  await store.setJSON(key, updated);
  await store.setJSON('latest', updated);
  return updated;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = extractBody(event);
  const entitlementId = String(body.entitlement_id || body.entitlementId || '').trim();
  const pendingPlanName = String(body.pending_plan_name || body.pendingPlanName || '').trim();
  const approvedBy = String(body.approved_by || body.approvedBy || 'manual').trim() || 'manual';
  const reason = String(body.reason || body.approval_reason || 'Approved through Netlify workflow').trim() || 'Approved through Netlify workflow';

  if (!entitlementId) {
    return response(400, { error: 'missing_entitlement_id' });
  }

  const googleApproval = await approveMarketplacePlanChange({ entitlementId, pendingPlanName, reason });
  const remoteSkipped = Boolean(googleApproval.skipped);

  if (!googleApproval.ok && !remoteSkipped) {
    return response(502, { error: 'google_plan_change_approval_failed', detail: googleApproval.error });
  }

  const store = await loadStore(event);
  const entitlementRecord = await updateLatestEntitlement(store, entitlementId, (record) =>
    approvePlanChangeRecord(record, {
      approvedBy,
      pendingPlanName: pendingPlanName || record.pendingPlanName || record.entitlement?.newPendingPlan || null,
    }),
  );

  return response(200, {
    ok: true,
    remoteSkipped,
    entitlement: entitlementRecord ? {
      id: entitlementRecord.entitlement.id,
      status: entitlementRecord.status,
      planChangeStatus: entitlementRecord.planChangeStatus,
      pendingPlanName: entitlementRecord.pendingPlanName || null,
      planChangeApprovedAt: entitlementRecord.planChangeApprovedAt || null,
    } : null,
  });
};
