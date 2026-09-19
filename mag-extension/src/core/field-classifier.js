(function initializeFieldClassifier(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  const normalize = MAG.Normalize.normalizeText;

  const rules = [
    ["FIRST_NAME", ["first name", "given name", "firstname", "fname"]],
    ["LAST_NAME", ["last name", "family name", "surname", "lastname", "lname"]],
    ["CONTACT_NAME", ["contact name", "your name", "submitter name", "full name", "name"]],
    ["EMAIL", ["email address", "contact email", "email", "e mail"]],
    ["PHONE", ["phone number", "contact phone", "telephone", "mobile phone", "phone"]],
    ["ORGANIZATION", ["organization name", "organisation name", "company name", "business name", "nonprofit name", "organization", "company"]],
    ["WEBSITE", ["organization website", "business website", "event website", "website url", "web site", "website"]],
    ["ADDRESS", ["street address", "address line 1", "mailing address", "address"]],
    ["CITY", ["event city", "organization city", "city", "town"]],
    ["STATE", ["event state", "state", "province", "region"]],
    ["ZIP", ["zip code", "postal code", "postcode", "zipcode", "zip"]],
    ["EVENT_NAME", ["event title", "event name", "name of event", "listing title"]],
    ["EVENT_DATE", ["event date", "date of event", "start date", "date"]],
    ["START_TIME", ["event start time", "start time", "time starts", "from time"]],
    ["END_TIME", ["event end time", "end time", "time ends", "to time"]],
    ["VENUE", ["venue name", "event venue", "location name", "venue"]],
    ["EVENT_DESCRIPTION", ["event description", "describe the event", "event details", "about the event"]],
    ["ORGANIZATION_DESCRIPTION", ["organization description", "company description", "about your organization", "about the organization", "business description"]],
    ["BIO", ["speaker bio", "founder bio", "biography", "your bio", "bio"]],
    ["SOCIAL_URL", ["social media url", "social media link", "facebook url", "instagram url", "linkedin url", "social link"]],
    ["CATEGORY", ["event category", "business category", "category", "type of event"]],
    ["ADMISSION", ["admission cost", "ticket price", "admission", "cost", "price"]],
    ["MISSION", ["mission statement", "your mission", "mission"]],
    ["PRESS_RELEASE", ["press release", "news release", "media release"]],
    ["COMMENTS", ["additional comments", "additional information", "anything else", "comments", "notes"]]
  ];

  const autocompleteMap = {
    "given-name": "FIRST_NAME", "family-name": "LAST_NAME", name: "CONTACT_NAME",
    email: "EMAIL", tel: "PHONE", url: "WEBSITE", organization: "ORGANIZATION",
    "street-address": "ADDRESS", "address-line1": "ADDRESS", "address-level2": "CITY",
    "address-level1": "STATE", "postal-code": "ZIP"
  };

  function fieldContext(field) {
    return normalize([field.label, field.ariaLabel, field.name, field.id, field.placeholder, field.describedBy, field.legend, field.heading, field.nearbyText].join(" "));
  }

  function aliasScore(text, alias, weight) {
    if (!text) return 0;
    const normalizedAlias = normalize(alias);
    if (text === normalizedAlias) return weight;
    if (text.includes(normalizedAlias)) return Math.max(1, weight - 18);
    return 0;
  }

  function classify(field) {
    const context = fieldContext(field);
    const primaryContext = normalize([field.label, field.ariaLabel, field.name, field.id, field.placeholder, field.describedBy, field.legend].join(" "));
    const dynamic = MAG.DynamicRegistry?.match(field);
    if (dynamic?.score >= 78) {
      const definition = dynamic.definition;
      const protectedField = definition.security_class !== "STANDARD" || definition.autofill_policy === "NEVER";
      return {
        semantic: definition.semantic_type || "OTHER", canonicalKey: definition.canonical_key,
        securityClass: definition.security_class, autofillPolicy: definition.autofill_policy,
        score: dynamic.score, level: MAG.Normalize.confidenceLevel(dynamic.score),
        evidence: ["approved field registry"], protected: protectedField,
        restricted: definition.security_class === "RESTRICTED"
      };
    }
    const protectedByMeaning = MAG.PROTECTED_FIELD_PATTERN.test(context);
    if (field.isProtected || protectedByMeaning) {
      return {
        semantic: "OTHER", score: 0, level: "UNKNOWN",
        evidence: [field.isProtected ? `protected input type: ${field.type}` : "protected legal, consent, credential, verification, or financial meaning"],
        protected: true, securityClass: "HUMAN_CONTROLLED"
      };
    }
    if (field.type === "checkbox" || field.type === "radio") {
      return { semantic: "OTHER", score: 0, level: "UNKNOWN", evidence: ["choice controls require human action"], protected: true, securityClass: "HUMAN_CONTROLLED" };
    }
    if (field.adapterSemantic) {
      return { semantic: field.adapterSemantic, score: 100, level: "HIGH", evidence: [`site adapter: ${field.adapterId}`], protected: false };
    }
    if (/\b(?:organization|organisation|company|business|nonprofit)\b.*\b(?:description|describe|about)\b|\b(?:description|describe|about)\b.*\b(?:organization|organisation|company|business|nonprofit)\b/.test(primaryContext)) {
      return { semantic: "ORGANIZATION_DESCRIPTION", score: 96, level: "HIGH", evidence: ["explicit organization description context"], protected: false };
    }
    if (/\bevent\b.*\b(?:description|describe|details|about)\b|\b(?:description|describe|details|about)\b.*\bevent\b/.test(primaryContext)) {
      return { semantic: "EVENT_DESCRIPTION", score: 96, level: "HIGH", evidence: ["explicit event description context"], protected: false };
    }
    if (/\b(?:organization|organisation|company|business|nonprofit)\b.*\bname\b|\bname\b.*\b(?:organization|organisation|company|business|nonprofit)\b/.test(primaryContext)) {
      return { semantic: "ORGANIZATION", score: 96, level: "HIGH", evidence: ["explicit organization name context"], protected: false };
    }
    if (/\bevent\b.*\b(?:name|title)\b|\b(?:name|title)\b.*\bevent\b/.test(primaryContext)) {
      return { semantic: "EVENT_NAME", score: 96, level: "HIGH", evidence: ["explicit event name context"], protected: false };
    }
    const autocomplete = normalize(field.autocomplete).replaceAll(" ", "-");
    if (autocompleteMap[autocomplete]) {
      return { semantic: autocompleteMap[autocomplete], score: 100, level: "HIGH", evidence: ["autocomplete attribute"], protected: false };
    }

    const sources = [
      [normalize(field.label), 92, "label"],
      [normalize(field.ariaLabel), 88, "aria-label"],
      [normalize(`${field.name} ${field.id}`), 80, "name/id"],
      [normalize(field.placeholder), 72, "placeholder"],
      [normalize(field.describedBy), 64, "description"],
      [normalize(field.legend), 52, "legend"],
      [normalize(field.heading), 38, "section heading"],
      [normalize(field.nearbyText), 26, "nearby text"]
    ];
    const scored = rules.map(([semantic, aliases]) => {
      let score = 0;
      const evidence = [];
      for (const [text, weight, source] of sources) {
        const best = Math.max(0, ...aliases.map((alias) => aliasScore(text, alias, weight)));
        if (best > 0) { score += best; evidence.push(source); }
      }
      if (semantic === "EMAIL" && field.type === "email") { score += 45; evidence.push("input type=email"); }
      if (semantic === "PHONE" && field.type === "tel") { score += 45; evidence.push("input type=tel"); }
      if (semantic === "WEBSITE" && field.type === "url") { score += 30; evidence.push("input type=url"); }
      if (semantic === "EVENT_DATE" && field.type === "date") { score += 18; evidence.push("input type=date"); }
      if ((semantic === "START_TIME" || semantic === "END_TIME") && field.type === "time") { score += 16; evidence.push("input type=time"); }
      return { semantic, score: Math.min(100, score), evidence: MAG.Normalize.unique(evidence) };
    }).sort((a, b) => b.score - a.score);

    let best = scored[0];
    const second = scored[1];
    if (!best || best.score < MAG.CONFIDENCE.LOW || (second && best.score - second.score < 12)) {
      best = { semantic: "OTHER", score: 0, evidence: context ? ["no reliable semantic match"] : ["no field context"] };
    }
    return { ...best, level: MAG.Normalize.confidenceLevel(best.score), protected: false };
  }

  MAG.FieldClassifier = Object.freeze({ classify, fieldContext, rules });
})(globalThis);
