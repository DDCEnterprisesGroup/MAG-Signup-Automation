(function initializeProfileMapper(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  const get = MAG.Normalize.getPath;

  function first(profile, paths) {
    for (const path of paths) {
      const value = get(profile, path);
      if (Array.isArray(value) && value.length) return value.join(", ");
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return "";
  }

  function selectVariant(variants, maxlength) {
    if (!variants) return { value: "", fits: true, variant: "" };
    if (typeof variants === "string") return { value: variants, fits: !maxlength || variants.length <= maxlength, variant: "approved" };
    const entries = ["long", "medium", "short"].map((key) => [key, variants[key]]).filter(([, value]) => typeof value === "string" && value.trim());
    if (!entries.length) return { value: "", fits: true, variant: "" };
    if (!maxlength) return { value: entries[0][1], fits: true, variant: entries[0][0] };
    const match = entries.find(([, value]) => value.length <= maxlength);
    if (match) return { value: match[1], fits: true, variant: match[0] };
    const shortest = [...entries].sort((a, b) => a[1].length - b[1].length)[0];
    return { value: shortest[1], fits: false, variant: shortest[0] };
  }

  function valueFor(profile, semantic, field) {
    if (field?.canonicalKey && profile?.dynamicFields && Object.hasOwn(profile.dynamicFields, field.canonicalKey)) {
      const dynamic = profile.dynamicFields[field.canonicalKey];
      if (dynamic && typeof dynamic === "object" && !Array.isArray(dynamic)) return { ...selectVariant(dynamic, field.maxlength), source: `approved ${field.canonicalKey}` };
      return { value: dynamic === undefined || dynamic === null ? "" : String(dynamic), source: `approved ${field.canonicalKey}` };
    }
    switch (semantic) {
      case "CONTACT_NAME": return { value: first(profile, ["person.fullName", "event.contact.name"]), source: "person.fullName" };
      case "FIRST_NAME": return { value: first(profile, ["person.firstName"]), source: "person.firstName" };
      case "LAST_NAME": return { value: first(profile, ["person.lastName"]), source: "person.lastName" };
      case "EMAIL": return { value: first(profile, ["person.email", "event.contact.email", "organization.email"]), source: "approved email" };
      case "PHONE": return { value: first(profile, ["person.phone", "event.contact.phone", "organization.phone"]), source: "approved phone" };
      case "ORGANIZATION": return { value: first(profile, ["event.organizer", "organization.publicName", "organization.legalName"]), source: "organization name" };
      case "WEBSITE": {
        const isEvent = MAG.FieldClassifier.fieldContext(field).includes("event");
        return { value: first(profile, isEvent ? ["event.eventUrl", "organization.website", "person.website"] : ["organization.website", "person.website", "event.eventUrl"]), source: isEvent ? "event/organization URL" : "organization/person URL" };
      }
      case "ADDRESS": return { value: first(profile, ["event.address", "organization.address", "person.address"]), source: "approved address" };
      case "CITY": return { value: first(profile, ["event.city", "organization.city", "person.city"]), source: "approved city" };
      case "STATE": return { value: first(profile, ["event.state", "organization.state", "person.state"]), source: "approved state" };
      case "ZIP": return { value: first(profile, ["event.zip", "organization.zip", "person.zip"]), source: "approved ZIP" };
      case "EVENT_NAME": return { value: first(profile, ["event.name"]), source: "event.name" };
      case "EVENT_DATE": return { value: first(profile, ["event.date"]), source: "event.date" };
      case "START_TIME": return { value: first(profile, ["event.startTime"]), source: "event.startTime" };
      case "END_TIME": return { value: first(profile, ["event.endTime"]), source: "event.endTime" };
      case "VENUE": return { value: first(profile, ["event.venue"]), source: "event.venue" };
      case "EVENT_DESCRIPTION": return { ...selectVariant(get(profile, "content.eventDescription"), field.maxlength), source: "approved event description" };
      case "ORGANIZATION_DESCRIPTION": return { ...selectVariant(get(profile, "content.organizationDescription"), field.maxlength), source: "approved organization description" };
      case "BIO": return { ...selectVariant(get(profile, "content.founderBio") || get(profile, "person.biography"), field.maxlength), source: "approved biography" };
      case "SOCIAL_URL": return { value: first(profile, ["organization.socialLinks.facebook", "organization.socialLinks.instagram", "organization.socialLinks.linkedin", "person.socialLinks.linkedin", "person.socialLinks.instagram"]), source: "approved social link" };
      case "CATEGORY": return { value: first(profile, ["event.categories", "product.category"]), source: "approved category" };
      case "ADMISSION": return { value: first(profile, ["event.admission"]), source: "event.admission" };
      case "MISSION": return { value: first(profile, ["organization.mission", "content.mission"]), source: "approved mission" };
      case "PRESS_RELEASE": return { ...selectVariant(get(profile, "content.pressRelease"), field.maxlength), source: "approved press release" };
      case "COMMENTS": return { value: first(profile, ["content.approvedCta", "event.sponsorshipInformation"]), source: "approved contextual text", confidencePenalty: 25 };
      default: return { value: "", source: "no mapping" };
    }
  }

  function map(field, classification, profile) {
    if (classification.protected) return { value: "", source: "human-controlled field", score: 0, level: "UNKNOWN", fits: true };
    const candidate = valueFor(profile, classification.semantic, { ...field, canonicalKey: classification.canonicalKey });
    const score = Math.max(0, classification.score - (candidate.confidencePenalty || 0) - (candidate.fits === false ? 25 : 0));
    return {
      value: candidate.value || "", source: candidate.source, score,
      level: MAG.Normalize.confidenceLevel(score), fits: candidate.fits !== false,
      variant: candidate.variant || ""
    };
  }

  MAG.ProfileMapper = Object.freeze({ map, valueFor, selectVariant });
})(globalThis);
