const { connectLambda, getStore } = require('@netlify/blobs');
const { approveMarketplaceAccount } = require('./_shared/google-marketplace-api');
const { approveEntitlementRecord } = require('./_shared/entitlement-lifecycle');

const ENTITLEMENT_STORE = 'marketplace-entitlements';
const ACCOUNT_STORE = 'marketplace-accounts';
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

async function loadStore(event, name) {
  connectLambda(event);
  return getStore(name);
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
  const accountId = String(body.account_id || body.accountId || body.gcp_account_id || '').trim();
  const entitlementId = String(body.entitlement_id || body.entitlementId || '').trim();
  const approvalName = String(body.approval_name || body.approvalName || 'signup').trim() || 'signup';
  const reason = String(body.reason || body.approval_reason || 'Approved through Netlify workflow').trim() || 'Approved through Netlify workflow';

  if (!accountId) {
    return response(400, { error: 'missing_account_id' });
  }

  const googleApproval = await approveMarketplaceAccount({ accountId, approvalName, reason });
  const remoteSkipped = Boolean(googleApproval.skipped);

  if (!googleApproval.ok && !remoteSkipped) {
    return response(502, { error: 'google_account_approval_failed', detail: googleApproval.error });
  }

  const accountStore = await loadStore(event, ACCOUNT_STORE);
  const accountRecord = {
    accountId,
    entitlementId: entitlementId || null,
    approvalName,
    approvedAt: new Date().toISOString(),
    approvalStatus: 'approved',
    remoteSkipped,
    googleResponse: googleApproval.ok ? googleApproval.responseBody || null : null,
  };

  await accountStore.setJSON(`account:${accountId}`, accountRecord);
  await accountStore.setJSON('latest', accountRecord);

  let entitlementRecord = null;
  if (entitlementId) {
    const entitlementStore = await loadStore(event, ENTITLEMENT_STORE);
    entitlementRecord = await updateLatestEntitlement(entitlementStore, entitlementId, (record) =>
      approveEntitlementRecord(record, { approvedBy: accountId, accountId }),
    );
  }

  return response(200, {
    ok: true,
    account: accountRecord,
    entitlement: entitlementRecord ? {
      id: entitlementRecord.entitlement.id,
      status: entitlementRecord.status,
      approvalStatus: entitlementRecord.approvalStatus,
      approvalApprovedAt: entitlementRecord.approvalApprovedAt || null,
      approvalRejectedAt: entitlementRecord.approvalRejectedAt || null,
    } : null,
    remoteSkipped,
  });
};
