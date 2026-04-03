function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMillis(value) {
  const iso = isoOrNull(value);
  return iso ? Date.parse(iso) : NaN;
}

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function getApprovalStatus(record) {
  if (record.approvalStatus) {
    return record.approvalStatus;
  }

  return record.approvalRequired === false ? 'not_required' : 'pending';
}

function computeLifecycle(record, now = Date.now()) {
  const next = deepClone(record) || {};
  const entitlement = next.entitlement || {};
  const startMs = toMillis(entitlement.newOfferStartTime);
  const endMs = toMillis(entitlement.newOfferEndTime);
  const approvalRequired = next.approvalRequired !== false;
  const approvalStatus = getApprovalStatus(next);

  next.approvalRequired = approvalRequired;
  next.approvalStatus = approvalStatus;
  next.approvalDueAt = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
  next.activationStartTime = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
  next.activationEndTime = Number.isFinite(endMs) ? new Date(endMs).toISOString() : null;

  if (approvalStatus === 'rejected') {
    next.status = 'rejected';
  } else if (approvalRequired && approvalStatus !== 'approved') {
    if (Number.isFinite(startMs) && now >= startMs) {
      next.approvalStatus = 'rejected';
      next.approvalRejectedAt = new Date(now).toISOString();
      next.approvalRejectionReason = 'approval_not_completed_before_start';
      next.status = 'rejected';
    } else {
      next.status = 'scheduled';
    }
  } else if (Number.isFinite(endMs) && now > endMs) {
    next.status = 'expired';
  } else if (Number.isFinite(startMs) && now < startMs) {
    next.status = 'scheduled';
  } else if (Number.isFinite(startMs) || Number.isFinite(endMs)) {
    next.status = 'active';
  } else {
    next.status = 'accepted';
  }

  next.lifecycle = {
    approvalRequired: next.approvalRequired,
    approvalStatus: next.approvalStatus,
    status: next.status,
    activationStartTime: next.activationStartTime,
    activationEndTime: next.activationEndTime,
    approvalDueAt: next.approvalDueAt,
    approvalApprovedAt: next.approvalApprovedAt || null,
    approvalRejectedAt: next.approvalRejectedAt || null,
    approvalRejectionReason: next.approvalRejectionReason || null,
  };

  return next;
}

function createEntitlementRecord(payload, now = Date.now()) {
  const entitlement = payload.entitlement || {};
  const entitlementId = String(entitlement.id || payload.entitlementId || payload.id || '').trim();
  const eventType = String(payload.eventType || 'ENTITLEMENT_OFFER_ACCEPTED').trim();
  const record = {
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
    receivedAt: new Date(now).toISOString(),
    isAutomaticApproval: eventType === 'ENTITLEMENT_OFFER_ACCEPTED',
    approvalRequired: eventType === 'ENTITLEMENT_OFFER_ACCEPTED',
    approvalStatus: eventType === 'ENTITLEMENT_OFFER_ACCEPTED' ? 'pending' : 'not_required',
  };

  return computeLifecycle(record, now);
}

function approveEntitlementRecord(record, options = {}) {
  const now = options.now || Date.now();
  const next = deepClone(record) || {};
  next.approvalRequired = true;
  next.approvalStatus = 'approved';
  next.approvalApprovedAt = new Date(now).toISOString();
  next.approvalApprovedBy = options.approvedBy || 'manual';
  delete next.approvalRejectedAt;
  delete next.approvalRejectionReason;
  return computeLifecycle(next, now);
}

function summarizeEntitlementState(record) {
  const start = record.activationStartTime || record.entitlement?.newOfferStartTime || null;
  const end = record.activationEndTime || record.entitlement?.newOfferEndTime || null;

  if (record.status === 'rejected') {
    return 'This private offer was automatically rejected because the customer account was not approved before the scheduled start time.';
  }

  if (record.approvalStatus === 'pending') {
    return start
      ? 'This private offer has been accepted and is waiting on customer account approval before it can become active.'
      : 'This private offer has been accepted and is waiting on customer account approval.';
  }

  if (record.approvalStatus === 'approved' && record.status === 'scheduled') {
    return start
      ? `The customer account is approved. The offer will become active at ${start}.`
      : 'The customer account is approved. The offer is ready to become active.';
  }

  if (record.status === 'active') {
    return end
      ? `The offer is active and scheduled to end at ${end}.`
      : 'The offer is active.';
  }

  if (record.status === 'expired') {
    return end
      ? `The offer window ended at ${end}.`
      : 'The offer window has ended.';
  }

  return 'The Marketplace entitlement record is available below.';
}

module.exports = {
  approveEntitlementRecord,
  computeLifecycle,
  createEntitlementRecord,
  isoOrNull,
  summarizeEntitlementState,
};
