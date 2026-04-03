const { connectLambda, getStore } = require('@netlify/blobs');
const { computeLifecycle, summarizeEntitlementState } = require('./_shared/entitlement-lifecycle');

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

async function loadStore(event, name) {
  connectLambda(event);
  return getStore(name);
}

async function listJsonRecords(store, prefix) {
  const keys = [];
  for await (const page of store.list({ prefix, paginate: true })) {
    for (const blob of page.blobs || []) {
      keys.push(blob.key);
    }
  }

  const records = [];
  for (const key of keys) {
    const record = await store.get(key, { type: 'json' });
    if (record) {
      records.push({ key, record });
    }
  }
  return records;
}

function isoToMillis(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function classifyEntitlement(record) {
  if (record.eventType === 'ENTITLEMENT_OFFER_ACCEPTED' || record.isAutomaticApproval) {
    return 'automatic';
  }
  if (record.eventType === 'ENTITLEMENT_CREATION_REQUESTED') {
    return 'manual-entitlement';
  }
  if (record.eventType === 'ENTITLEMENT_PLAN_CHANGE_REQUESTED' || record.planChangeRequired) {
    return 'plan-change';
  }
  if (record.eventType === 'ENTITLEMENT_OFFER_ENDED') {
    return 'offer-ended';
  }
  return 'other';
}

function toEntitlementCard(entry) {
  const lifecycle = computeLifecycle(entry.record);
  const entitlement = lifecycle.entitlement || {};
  return {
    key: entry.key,
    category: classifyEntitlement(lifecycle),
    id: entitlement.id || null,
    accountId: lifecycle.accountId || null,
    eventType: lifecycle.eventType || null,
    status: lifecycle.status || null,
    approvalStatus: lifecycle.approvalStatus || null,
    planChangeStatus: lifecycle.planChangeStatus || null,
    approvalRequired: lifecycle.approvalRequired === true,
    planChangeRequired: lifecycle.planChangeRequired === true,
    pendingPlanName: lifecycle.pendingPlanName || null,
    pendingOfferName: lifecycle.pendingOfferName || null,
    activationStartTime: lifecycle.activationStartTime || null,
    activationEndTime: lifecycle.activationEndTime || null,
    approvalDueAt: lifecycle.approvalDueAt || null,
    approvalApprovedAt: lifecycle.approvalApprovedAt || null,
    approvalRejectedAt: lifecycle.approvalRejectedAt || null,
    planChangeApprovedAt: lifecycle.planChangeApprovedAt || null,
    planChangeRejectedAt: lifecycle.planChangeRejectedAt || null,
    receivedAt: lifecycle.receivedAt || null,
    summary: summarizeEntitlementState(lifecycle),
  };
}

function toAccountCard(entry) {
  const record = entry.record || {};
  return {
    key: entry.key,
    accountId: record.accountId || null,
    entitlementId: record.entitlementId || null,
    approvalName: record.approvalName || 'account-approval',
    approvalStatus: record.approvalStatus || 'unknown',
    approvedAt: record.approvedAt || null,
    entitlementStatus: record.entitlement ? record.entitlement.status || null : null,
    entitlementApprovalStatus: record.entitlement ? record.entitlement.approvalStatus || null : null,
    remoteSkipped: Boolean(record.remoteSkipped),
    receivedAt: record.approvedAt || record.receivedAt || null,
    summary: record.approvalStatus === 'approved'
      ? 'Customer account approval completed.'
      : 'Customer account approval is pending.',
  };
}

function sortNewestFirst(a, b) {
  return isoToMillis(b.receivedAt) - isoToMillis(a.receivedAt);
}

function latestByCategory(items, category) {
  return items.find((item) => item.category === category) || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const params = new URLSearchParams(event.queryStringParameters || {});
  const entitlementId = String(params.get('entitlement_id') || '').trim();
  const accountId = String(params.get('account_id') || '').trim();
  const entitlementStore = await loadStore(event, ENTITLEMENT_STORE);
  const accountStore = await loadStore(event, ACCOUNT_STORE);

  const entitlementEntries = await listJsonRecords(entitlementStore, 'entitlement:');
  const accountEntries = await listJsonRecords(accountStore, 'account:');

  const entitlements = entitlementEntries.map(toEntitlementCard).sort(sortNewestFirst);
  const accounts = accountEntries.map(toAccountCard).sort(sortNewestFirst);
  const pendingManualApprovals = entitlements.filter((item) => item.category === 'manual-entitlement' && item.approvalStatus === 'pending');
  const pendingPlanChangeApprovals = entitlements.filter((item) => item.category === 'plan-change' && item.planChangeStatus === 'pending');

  return response(200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    filters: {
      entitlementId: entitlementId || null,
      accountId: accountId || null,
    },
    summary: {
      automatic: latestByCategory(entitlements, 'automatic'),
      manualEntitlement: latestByCategory(entitlements, 'manual-entitlement'),
      planChange: latestByCategory(entitlements, 'plan-change'),
      accountApproval: accounts[0] || null,
    },
    focused: {
      entitlement: entitlementId ? entitlements.find((item) => item.id === entitlementId) || null : null,
      account: accountId ? accounts.find((item) => item.accountId === accountId) || null : null,
    },
    recent: {
      entitlements: entitlements.slice(0, 8),
      accounts: accounts.slice(0, 8),
    },
    pending: {
      manualEntitlements: pendingManualApprovals,
      planChanges: pendingPlanChangeApprovals,
    },
    counts: {
      entitlements: entitlements.length,
      automatic: entitlements.filter((item) => item.category === 'automatic').length,
      manualEntitlement: entitlements.filter((item) => item.category === 'manual-entitlement').length,
      planChange: entitlements.filter((item) => item.category === 'plan-change').length,
      pendingManualEntitlement: pendingManualApprovals.length,
      pendingPlanChange: pendingPlanChangeApprovals.length,
      accounts: accounts.length,
    },
  });
};
