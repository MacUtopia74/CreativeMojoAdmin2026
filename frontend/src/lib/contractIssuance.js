import api from "./api";

/**
 * Auto-freeze the contract's territory snapshot if the resolver
 * complained that ``TERRITORY_MAP_URL`` needs one. Returns ``true``
 * when a freeze was attempted (regardless of outcome), so the caller
 * knows to retry the resolve step.
 *
 * Any other resolver error is left untouched — those get surfaced
 * back to the caller as the friendly "missing values" list.
 */
function _resolverErrorsNeedTerritoryFreeze(detail) {
  if (!detail || typeof detail !== "object") return false;
  const errs = Array.isArray(detail.errors) ? detail.errors : [];
  return errs.some(
    (e) =>
      e && e.code === "TERRITORY_MAP_URL" &&
      typeof e.reason === "string" &&
      /frozen territory snapshot/i.test(e.reason),
  );
}

/**
 * Extract a human-friendly summary from a resolver detail payload.
 * Returns null when the detail isn't a resolver-error shape (so the
 * caller can fall back to its generic error path).
 */
function _humaniseResolverErrors(detail) {
  if (!detail || typeof detail !== "object") return null;
  const errs = Array.isArray(detail.errors) ? detail.errors : [];
  if (!errs.length) return null;
  return errs.map((x) => `${x.code}: ${x.reason}`).join("\n");
}

/**
 * Resolve + issue a draft contract, transparently freezing the
 * territory snapshot when the template needs one. Returns a plain
 * object so callers can decide how to surface success / failure
 * (toast vs. alert vs. inline).
 *
 * Never re-throws — every failure path resolves with ``{ ok: false,
 * message }`` so the caller doesn't need its own try/catch.
 */
export async function resolveAndIssueContract(contractId, { hasResolvedVariables = false } = {}) {
  const freezeIfNeeded = async () => {
    try {
      await api.post(`/admin/contracts/${contractId}/freeze-territory`);
      return { ok: true };
    } catch (e) {
      const d = e?.response?.data?.detail;
      const raw = typeof d === "string" ? d : (d?.message || e.message || "");
      // Backend already speaks in plain English for the two common
      // failure modes — franchisee has no territory at all, or the
      // contract isn't a draft anymore. Just surface those verbatim
      // (they are the "friendly" copy this task asks for).
      if (
        /no territory tiles/i.test(raw) ||
        /Assign at least one tile/i.test(raw) ||
        /no territory assigned/i.test(raw) ||
        /Assign a territory before freezing/i.test(raw)
      ) {
        return {
          ok: false,
          message:
            "This franchisee has no territory assigned. " +
            "Open the Territory Builder, assign at least one tile or " +
            "postcode sector, then try issuing the contract again.",
        };
      }
      if (/already frozen/i.test(raw)) {
        // Race — someone else froze the territory between our check
        // and this call. Treat as success and let the retry proceed.
        return { ok: true };
      }
      return { ok: false, message: raw || "Failed to freeze the territory snapshot." };
    }
  };

  const runResolve = async () => {
    try {
      await api.post(`/admin/contracts/${contractId}/resolve-variables`);
      return { ok: true };
    } catch (e) {
      const detail = e?.response?.data?.detail;
      // Idempotent retry: if a previous attempt already froze the
      // variables (e.g. an earlier issue call failed AFTER resolve
      // succeeded and rolled the status back to draft), the resolve
      // endpoint refuses to overwrite. That's the correct default —
      // but from the caller's perspective this just means "resolve
      // has already been done, continue to issue". Detect and skip.
      const rawStr = typeof detail === "string" ? detail : (detail?.message || "");
      if (/already has frozen variables/i.test(rawStr)) {
        return { ok: true };
      }
      if (_resolverErrorsNeedTerritoryFreeze(detail)) {
        const frozen = await freezeIfNeeded();
        if (!frozen.ok) return frozen;
        // Retry the resolve now that the snapshot exists.
        try {
          await api.post(`/admin/contracts/${contractId}/resolve-variables`);
          return { ok: true };
        } catch (retryErr) {
          const rd = retryErr?.response?.data?.detail;
          const human = _humaniseResolverErrors(rd);
          if (human) return { ok: false, message: `Cannot issue — missing values:\n\n${human}` };
          const raw = typeof rd === "string" ? rd : (rd?.message || retryErr.message || "");
          return { ok: false, message: raw || "Failed to resolve contract variables." };
        }
      }
      const human = _humaniseResolverErrors(detail);
      if (human) return { ok: false, message: `Cannot issue — missing values:\n\n${human}` };
      const raw = typeof detail === "string" ? detail : (detail?.message || e.message || "");
      return { ok: false, message: raw || "Failed to resolve contract variables." };
    }
  };

  if (!hasResolvedVariables) {
    const r = await runResolve();
    if (!r.ok) return r;
  }

  try {
    await api.post(`/admin/contracts/${contractId}/issue`);
    return { ok: true };
  } catch (e) {
    const d = e?.response?.data?.detail;
    const raw = typeof d === "string" ? d : (d?.message || JSON.stringify(d || e.message));
    return { ok: false, message: `Issue failed: ${raw}` };
  }
}
