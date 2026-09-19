(function initializeNormalize(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[’']/g, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-./]+/g, " ")
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function confidenceLevel(score) {
    if (score >= MAG.CONFIDENCE.HIGH) return "HIGH";
    if (score >= MAG.CONFIDENCE.MEDIUM) return "MEDIUM";
    if (score >= MAG.CONFIDENCE.LOW) return "LOW";
    return "UNKNOWN";
  }

  function getPath(object, path) {
    return String(path).split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function splitFullName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    return {
      firstName: parts[0] || "",
      lastName: parts.length > 1 ? parts.slice(1).join(" ") : ""
    };
  }

  MAG.Normalize = Object.freeze({ normalizeText, confidenceLevel, getPath, unique, splitFullName });
})(globalThis);
