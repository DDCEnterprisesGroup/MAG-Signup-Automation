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

  // A US number as its 10 national digits ("" when it is not one): a leading
  // country code 1 is accepted, anything else (other lengths/countries) is not
  // normalized so it can only match exactly.
  function usPhoneDigits(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    return digits.length === 10 ? digits : "";
  }

  // Whether a value already on the page is the same as the profile value.
  function equivalentValue(semantic, pageValue, profileValue) {
    const page = String(pageValue ?? "").trim();
    const approved = String(profileValue ?? "").trim();
    if (!page || !approved) return false;
    if (page === approved) return true;
    if (semantic === "PHONE") {
      const pageDigits = usPhoneDigits(page);
      return Boolean(pageDigits) && pageDigits === usPhoneDigits(approved);
    }
    return false;
  }

  MAG.Normalize = Object.freeze({ normalizeText, confidenceLevel, getPath, unique, splitFullName, usPhoneDigits, equivalentValue });
})(globalThis);
