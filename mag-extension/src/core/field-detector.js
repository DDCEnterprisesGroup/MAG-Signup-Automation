(function initializeFieldDetector(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  let nextFieldId = 1;

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest("[hidden], [aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textFromIds(ids) {
    return String(ids || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent || "").join(" ");
  }

  function labelText(element) {
    const labels = element.labels ? [...element.labels].map((label) => label.innerText || label.textContent || "") : [];
    const wrapping = element.closest("label");
    if (wrapping) labels.push(wrapping.innerText || wrapping.textContent || "");
    return MAG.Normalize.unique(labels).join(" ").slice(0, 800);
  }

  function nearestHeading(element) {
    const container = element.closest("section, article, fieldset, form, [role='group'], .form-group, .field, .question") || element.parentElement;
    if (!container) return "";
    const local = container.querySelector("legend, h1, h2, h3, h4, [role='heading']");
    if (local && !local.contains(element)) return (local.textContent || "").slice(0, 500);
    let cursor = container.previousElementSibling;
    for (let count = 0; cursor && count < 3; count += 1, cursor = cursor.previousElementSibling) {
      if (cursor.matches("h1, h2, h3, h4, [role='heading']")) return (cursor.textContent || "").slice(0, 500);
    }
    return "";
  }

  function nearbyText(element) {
    const container = element.closest(".form-group, .field, .question, [role='group'], fieldset") || element.parentElement;
    return (container?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 800);
  }

  function fieldType(element) {
    if (element instanceof HTMLInputElement) return element.type.toLowerCase();
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (element instanceof HTMLSelectElement) return "select";
    return "contenteditable";
  }

  function currentValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value || "";
    return element.textContent || "";
  }

  function buildDescriptor(element, index, adapter) {
    if (!element.dataset.magFieldId) element.dataset.magFieldId = `mag-field-${nextFieldId++}`;
    const type = fieldType(element);
    const adapterMatch = MAG.SiteAdapters.semanticForElement(element, adapter);
    const options = element instanceof HTMLSelectElement
      ? [...element.options].map((option) => ({ value: option.value, label: option.textContent?.trim() || "" }))
      : [];
    return {
      fieldId: element.dataset.magFieldId,
      domIndex: index,
      element,
      tag: element.tagName.toLowerCase(),
      type,
      required: element.matches("[required], [aria-required='true']"),
      disabled: element.matches(":disabled, [aria-disabled='true']"),
      readOnly: "readOnly" in element ? Boolean(element.readOnly) : false,
      currentValue: currentValue(element),
      label: labelText(element),
      name: element.getAttribute("name") || "",
      id: element.id || "",
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      describedBy: textFromIds(element.getAttribute("aria-describedby")),
      autocomplete: element.getAttribute("autocomplete") || "",
      legend: element.closest("fieldset")?.querySelector("legend")?.textContent || "",
      heading: nearestHeading(element),
      nearbyText: nearbyText(element),
      maxlength: Number.parseInt(element.getAttribute("maxlength") || "", 10) || null,
      options,
      adapterSemantic: adapterMatch?.semantic || "",
      adapterId: adapterMatch?.adapterId || "",
      isProtected: ["password", "file", "hidden", "submit", "button", "image", "reset"].includes(type)
    };
  }

  function detect(documentLike = document, locationLike = location) {
    const adapter = MAG.SiteAdapters.findAdapter(locationLike);
    const selector = "input, textarea, select, [contenteditable='true'], [role='textbox'][contenteditable]";
    return [...documentLike.querySelectorAll(selector)]
      .filter((element) => isVisible(element))
      .filter((element) => !["hidden", "submit", "button", "image", "reset"].includes(fieldType(element)))
      .map((element, index) => buildDescriptor(element, index, adapter));
  }

  MAG.FieldDetector = Object.freeze({ detect, buildDescriptor, isVisible, currentValue });
})(globalThis);
