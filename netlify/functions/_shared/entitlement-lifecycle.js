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

function getPlanChangeStatus(record) {
  if (record.planChangeStatus) {
    return record.planChangeStatus;
  }

  return record.planChangeRequired ? 'pending' : 'not_required';
}

function computeLifecycle(record, now = Date.now()) {
  const next = deepClone(record) || {};
  const entitlement = next.entitlement || {};
  const startMs = toMillis(entitlement.newOfferStartTime);
  const endMs = toMillis(entitlement.newOfferEndTime);
  const approvalRequired = next.approvalRequired !== false;
  const approvalStatus = getApprovalStatus(next);
  const planChangeRequired = next.planChangeRequired === true;
  const planChangeStatus = getPlanChangeStatus(next);

  next.approvalRequired = approvalRequired;
  next.approvalStatus = approvalStatus;
  next.planChangeRequired = planChangeRequired;
  next.planChangeStatus = planChangeStatus;
  next.approvalDueAt = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
  next.activationStartTime = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
  next.activationEndTime = Number.isFinite(endMs) ? new Date(endMs).toISOString() : null;

  if (next.eventType === 'ENTITLEMENT_OFFER_ENDED') {
    next.status = 'expired';
  } else if (approvalStatus === 'rejected') {
    next.status = 'rejected';
  } else if (approvalRequired && approvalStatus !== 'approved') {
    if (Number.isFinite(startMs) && now >= startMs) {
      next.approvalStatus = 'rejected';
      next.approvalRejectedAt = new Date(now).toISOString();
      next.approvalRejectionReason = 'approval_not_completed_before_start';
      next.status = 'rejected';
    } else if (next.eventType === 'ENTITLEMENT_CREATION_REQUESTED' && !Number.isFinite(startMs) && !Number.isFinite(endMs)) {
      next.status = 'pending';
    } else {
      next.status = 'scheduled';
    }
  } else if (planChangeRequired && planChangeStatus === 'pending') {
    next.status = next.status || 'active';
  } else if (next.eventType === 'ENTITLEMENT_PLAN_CHANGED') {
    next.status = 'active';
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
    planChangeRequired: next.planChangeRequired,
    planChangeStatus: next.planChangeStatus,
    planChangeApprovedAt: next.planChangeApprovedAt || null,
    planChangeRejectedAt: next.planChangeRejectedAt || null,
    planChangeRejectionReason: next.planChangeRejectionReason || null,
    pendingPlanName: next.pendingPlanName || null,
    pendingOfferName: next.pendingOfferName || null,
    plan: next.plan || next.entitlement?.plan || null,
  };

  return next;
}

function createEntitlementRecord(payload, now = Date.now()) {
  const entitlement = payload.entitlement || {};
  const entitlementId = String(entitlement.id || payload.entitlementId || payload.id || '').trim();
  const eventType = String(payload.eventType || 'ENTITLEMENT_OFFER_ACCEPTED').trim();
  const pendingPlanName = String(entitlement.newPendingPlan || payload.pendingPlanName || '').trim() || null;
  const pendingOfferName = String(entitlement.newPendingOffer || payload.pendingOfferName || '').trim() || null;
  const currentPlan = String(entitlement.plan || payload.plan || '').trim() || null;
  const automaticOffer = eventType === 'ENTITLEMENT_OFFER_ACCEPTED';
  const creationRequest = eventType === 'ENTITLEMENT_CREATION_REQUESTED';
  const planChangeRequest = eventType === 'ENTITLEMENT_PLAN_CHANGE_REQUESTED';
  const offerEnded = eventType === 'ENTITLEMENT_OFFER_ENDED';
  const record = {
    eventId: String(payload.eventId || payload.messageId || '').trim() || null,
    eventType,
    entitlement: {
      id: entitlementId,
      updateTime: isoOrNull(entitlement.updateTime),
      newPendingOfferDuration: entitlement.newPendingOfferDuration || null,
      newOfferStartTime: isoOrNull(entitlement.newOfferStartTime),
      newOfferEndTime: isoOrNull(entitlement.newOfferEndTime),
      newPendingPlan: pendingPlanName,
      newPendingOffer: pendingOfferName,
      plan: currentPlan,
    },
    raw: payload,
    receivedAt: new Date(now).toISOString(),
    isAutomaticApproval: automaticOffer,
    approvalRequired: automaticOffer || creationRequest,
    approvalStatus: automaticOffer || creationRequest ? 'pending' : 'not_required',
    planChangeRequired: planChangeRequest,
    planChangeStatus: planChangeRequest ? 'pending' : 'not_required',
    pendingPlanName,
    pendingOfferName,
    plan: currentPlan,
  };

  if (offerEnded) {
    record.approvalRequired = false;
    record.approvalStatus = 'not_required';
  }

  return computeLifecycle(record, now);
}

function approveEntitlementRecord(record, options = {}) {
  const now = options.now || Date.now();
  const next = deepClone(record) || {};
  next.approvalRequired = true;
  next.approvalStatus = 'approved';
  next.accountId = options.accountId || next.accountId || null;
  next.approvalApprovedAt = new Date(now).toISOString();
  next.approvalApprovedBy = options.approvedBy || 'manual';
  delete next.approvalRejectedAt;
  delete next.approvalRejectionReason;
  return computeLifecycle(next, now);
}

function approvePlanChangeRecord(record, options = {}) {
  const now = options.now || Date.now();
  const next = deepClone(record) || {};
  next.planChangeRequired = true;
  next.planChangeStatus = 'approved';
  next.planChangeApprovedAt = new Date(now).toISOString();
  next.planChangeApprovedBy = options.approvedBy || 'manual';
  next.pendingPlanName = options.pendingPlanName || next.pendingPlanName || next.entitlement?.newPendingPlan || null;
  if (next.pendingPlanName) {
    next.entitlement = next.entitlement || {};
    next.entitlement.plan = next.pendingPlanName;
  }
  delete next.planChangeRejectedAt;
  delete next.planChangeRejectionReason;
  return computeLifecycle(next, now);
}

function summarizeEntitlementState(record) {
  const start = record.activationStartTime || record.entitlement?.newOfferStartTime || null;
  const end = record.activationEndTime || record.entitlement?.newOfferEndTime || null;

  if (record.eventType === 'ENTITLEMENT_OFFER_ENDED' || record.status === 'expired' && record.eventType === 'ENTITLEMENT_OFFER_ENDED') {
    return 'This private offer has ended.';
  }

  if (record.status === 'rejected') {
    return 'This private offer was automatically rejected because the customer account was not approved before the scheduled start time.';
  }

  if (record.planChangeStatus === 'pending') {
    return record.pendingPlanName
      ? `This active offer has a pending plan change to ${record.pendingPlanName}. Approve the plan change to continue.`
      : 'This active offer has a pending plan change. Approve the plan change to continue.';
  }

  if (record.planChangeStatus === 'approved' && record.pendingPlanName) {
    return `The plan change to ${record.pendingPlanName} has been approved and is awaiting Marketplace to apply it.`;
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
  approvePlanChangeRecord,
  computeLifecycle,
  createEntitlementRecord,
  isoOrNull,
  summarizeEntitlementState,
};
