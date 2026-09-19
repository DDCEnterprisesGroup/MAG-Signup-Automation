(function initializeAutofillEngine(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  const records = new Map();
  const ownership = new Map();
  let activeProfileId = "";

  function ensureStyles() {
    if (document.getElementById("mag-review-styles")) return;
    const style = document.createElement("style");
    style.id = "mag-review-styles";
    style.textContent = `
      .mag-field-filled { outline: 2px solid #238636 !important; outline-offset: 2px !important; }
      .mag-field-review { outline: 3px solid #d97706 !important; outline-offset: 2px !important; background-image: linear-gradient(rgba(245,158,11,.08),rgba(245,158,11,.08)) !important; }
      .mag-field-missing { outline: 3px dashed #c62828 !important; outline-offset: 2px !important; background-image: linear-gradient(rgba(198,40,40,.06),rgba(198,40,40,.06)) !important; }
      .mag-field-skipped { outline: 2px dotted #6b7280 !important; outline-offset: 2px !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function setHighlight(record, status) {
    const element = record.element;
    element.classList.remove("mag-field-filled", "mag-field-review", "mag-field-missing", "mag-field-skipped");
    const className = { FILLED: "mag-field-filled", REVIEW: "mag-field-review", MISSING: "mag-field-missing", SKIPPED: "mag-field-skipped" }[status];
    if (className) element.classList.add(className);
    element.dataset.magStatus = status;
    record.status = status;
  }

  function setControlValue(element, value) {
    if (element instanceof HTMLSelectElement) {
      const normalized = MAG.Normalize.normalizeText(value);
      const option = [...element.options].find((item) => MAG.Normalize.normalizeText(item.value) === normalized || MAG.Normalize.normalizeText(item.textContent) === normalized);
      if (!option) return false;
      element.value = option.value;
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (["checkbox", "radio", "file", "password", "hidden", "submit", "button", "image", "reset"].includes(element.type)) return false;
      element.value = value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    } else {
      return false;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function serialize(record) {
    return {
      fieldId: record.field.fieldId,
      label: record.field.label || record.field.ariaLabel || record.field.placeholder || record.field.name || record.classification.semantic,
      semantic: record.classification.semantic,
      confidence: record.mapping.level,
      score: record.mapping.score,
      value: record.mapping.value,
      source: record.mapping.source,
      status: record.status,
      required: record.field.required,
      reason: record.reason,
      maxlength: record.field.maxlength,
      variant: record.mapping.variant || "",
      canonicalKey: record.classification.canonicalKey || "",
      securityClass: record.classification.securityClass || "STANDARD",
      restricted: Boolean(record.classification.restricted)
    };
  }

  function summary() {
    const items = [...records.values()].map(serialize);
    return {
      detected: items.length,
      filled: items.filter((item) => item.status === "FILLED").length,
      needsReview: items.filter((item) => item.status === "REVIEW").length,
      missing: items.filter((item) => item.status === "MISSING").length,
      skipped: items.filter((item) => item.status === "SKIPPED").length,
      profileId: activeProfileId,
      items
    };
  }

  function analyze(profile, settings = MAG.DEFAULT_SETTINGS) {
    ensureStyles();
    records.clear();
    activeProfileId = profile?.id || "";
    const fields = MAG.FieldDetector.detect();
    for (const field of fields) {
      const classification = MAG.FieldClassifier.classify(field);
      const mapping = MAG.ProfileMapper.map(field, classification, profile || {});
      const originalValue = MAG.FieldDetector.currentValue(field.element);
      let status = "REVIEW";
      let reason = "Review this suggestion.";
      if (classification.protected) {
        reason = classification.restricted ? "Restricted information requires re-authentication and explicit Fill approval." : "Human-controlled field. MAG will not fill it.";
      } else if (!mapping.value) {
        status = field.required ? "MISSING" : "REVIEW";
        reason = field.required ? "Required field has no approved profile value." : "No approved profile value is stored.";
      } else if (!mapping.fits) {
        reason = `Shortest approved variant exceeds the ${field.maxlength}-character limit.`;
      } else if (originalValue && settings.preserveExistingValues) {
        reason = "Existing page value preserved for human review.";
      } else if (mapping.level === "UNKNOWN" || classification.semantic === "OTHER") {
        reason = "Field meaning is uncertain.";
      } else {
        reason = `${mapping.level.toLowerCase()} confidence from ${classification.evidence.join(", ") || mapping.source}.`;
      }
      const record = { field, classification, mapping, element: field.element, originalValue, status, reason, changedByMag: false };
      records.set(field.fieldId, record);
      setHighlight(record, status);
      if (!field.element.dataset.magObserved) {
        field.element.dataset.magObserved = "true";
        field.element.addEventListener("input", (event) => {
          if (!event.isTrusted) return;
          const current = records.get(field.fieldId);
          if (current) {
            current.reason = "Manually edited; review retained.";
            ownership.delete(field.fieldId);
            setHighlight(current, "REVIEW");
          }
        });
      }
    }
    return summary();
  }

  function fillRecord(record, force = false, settings = MAG.DEFAULT_SETTINGS) {
    if (!record || record.classification.protected || !record.mapping.value || !record.mapping.fits) return false;
    if (record.field.disabled || record.field.readOnly) return false;
    if (!force && record.originalValue && settings.preserveExistingValues) return false;
    if (!setControlValue(record.element, record.mapping.value)) return false;
    record.changedByMag = true;
    ownership.set(record.field.fieldId, {
      element: record.element,
      originalValue: record.originalValue,
      filledValue: record.mapping.value,
      profileId: activeProfileId
    });
    record.reason = record.mapping.level === "HIGH" ? "Filled from approved profile data." : "Filled suggestion requires review.";
    setHighlight(record, record.mapping.level === "HIGH" ? "FILLED" : "REVIEW");
    return true;
  }

  function autofill(profile, settings = MAG.DEFAULT_SETTINGS) {
    restoreOwnedValues(profile?.id || "");
    analyze(profile, settings);
    const threshold = MAG.CONFIDENCE[settings.autofillThreshold] ?? MAG.CONFIDENCE.HIGH;
    for (const record of records.values()) {
      if (record.mapping.score >= threshold) fillRecord(record, false, settings);
    }
    return summary();
  }

  function restoreOwnedValues(nextProfileId = "") {
    for (const [fieldId, owned] of ownership) {
      if (nextProfileId && owned.profileId === nextProfileId) continue;
      if (MAG.FieldDetector.currentValue(owned.element) === owned.filledValue) setControlValue(owned.element, owned.originalValue);
      owned.element.classList.remove("mag-field-filled", "mag-field-review", "mag-field-missing", "mag-field-skipped");
      delete owned.element.dataset.magStatus;
      ownership.delete(fieldId);
    }
  }

  function fieldAction(fieldId, action) {
    const record = records.get(fieldId);
    if (!record) return summary();
    if (action === "accept") fillRecord(record, true, { ...MAG.DEFAULT_SETTINGS, preserveExistingValues: false });
    if (action === "clear" && !record.classification.protected && setControlValue(record.element, "")) {
      record.changedByMag = true;
      record.reason = "Cleared by user through MAG.";
      setHighlight(record, "REVIEW");
    }
    if (action === "skip") {
      record.reason = "Skipped by user.";
      setHighlight(record, "SKIPPED");
    }
    if (action === "focus") {
      record.element.focus({ preventScroll: false });
      record.element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return summary();
  }

  function fillRestricted(fieldId, plaintext) {
    if (!MAG.RESTRICTED_AUTOFILL_ENABLED) return summary();
    const record = records.get(fieldId);
    if (!record?.classification.restricted || typeof plaintext !== "string" || !plaintext) return summary();
    if (record.field.disabled || record.field.readOnly) return summary();
    if (setControlValue(record.element, plaintext)) {
      record.reason = "Restricted value filled after explicit approval. Review before manual submission.";
      record.mapping = { ...record.mapping, value: "", source: "authorized one-time retrieval", score: 0, level: "UNKNOWN" };
      setHighlight(record, "REVIEW");
    }
    plaintext = "";
    return summary();
  }

  function reset() {
    restoreOwnedValues();
    for (const record of records.values()) {
      record.element.classList.remove("mag-field-filled", "mag-field-review", "mag-field-missing", "mag-field-skipped");
      delete record.element.dataset.magStatus;
    }
    records.clear();
    activeProfileId = "";
    return summary();
  }

  MAG.AutofillEngine = Object.freeze({ analyze, autofill, summary, fieldAction, fillRestricted, reset, setControlValue });
})(globalThis);
