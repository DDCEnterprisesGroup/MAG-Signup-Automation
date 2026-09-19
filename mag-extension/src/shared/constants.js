(function initializeConstants(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  MAG.VERSION = "1.1.0";
  // Keep retrieval and filling closed until Dre completes live AAL2 acceptance.
  MAG.RESTRICTED_AUTOFILL_ENABLED = false;
  MAG.SEMANTIC_TYPES = Object.freeze([
    "CONTACT_NAME", "FIRST_NAME", "LAST_NAME", "EMAIL", "PHONE", "ORGANIZATION",
    "WEBSITE", "ADDRESS", "CITY", "STATE", "ZIP", "EVENT_NAME", "EVENT_DATE",
    "START_TIME", "END_TIME", "VENUE", "EVENT_DESCRIPTION", "ORGANIZATION_DESCRIPTION",
    "BIO", "SOCIAL_URL", "CATEGORY", "ADMISSION", "MISSION", "PRESS_RELEASE",
    "COMMENTS", "DATE_OF_BIRTH", "SOCIAL_SECURITY_NUMBER", "TAX_IDENTIFIER",
    "BANK_ACCOUNT", "ROUTING_NUMBER", "OTHER"
  ]);
  MAG.CONFIDENCE = Object.freeze({ HIGH: 85, MEDIUM: 65, LOW: 40, UNKNOWN: 0 });
  MAG.DEFAULT_SETTINGS = Object.freeze({
    autofillThreshold: "HIGH",
    preserveExistingValues: true,
    debug: false
  });
  MAG.PROTECTED_FIELD_PATTERN = /\b(certif(?:y|ication)|consent|agree(?:ment)?|attest|acknowledge|terms|privacy|authorize|authorization|signature|initials|captcha|not a robot|verification code|one[- ]time|otp|password|passcode|pin|ssn|social security|tax id|ein|passport|driver'?s? license|routing|bank account|card number|cvv|cvc)\b/i;
  MAG.MESSAGE = Object.freeze({
    PING: "MAG_PING",
    ANALYZE: "MAG_ANALYZE",
    AUTOFILL: "MAG_AUTOFILL",
    RESET: "MAG_RESET",
    FIELD_ACTION: "MAG_FIELD_ACTION",
    GET_STATUS: "MAG_GET_STATUS",
    FORM_DETECTED: "MAG_FORM_DETECTED",
    AUTH_STATUS: "MAG_AUTH_STATUS",
    AUTH_LOGIN: "MAG_AUTH_LOGIN",
    AUTH_LOGOUT: "MAG_AUTH_LOGOUT",
    MFA_VERIFY: "MAG_MFA_VERIFY",
    AUDIT_EVENT: "MAG_AUDIT_EVENT",
    SYNC_PROFILES: "MAG_SYNC_PROFILES",
    RESTRICTED_UNLOCK: "MAG_RESTRICTED_UNLOCK",
    FILL_RESTRICTED: "MAG_FILL_RESTRICTED"
  });
})(globalThis);
