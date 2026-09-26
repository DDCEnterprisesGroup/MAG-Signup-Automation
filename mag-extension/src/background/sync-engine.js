(function initializeSyncEngine(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  function asProfile(row, values) {
    const approved = values.filter((item) => item.profile_id === row.id);
    const dynamicFields = Object.fromEntries(approved.map((item) => [item.mag_field_definitions.canonical_key, item.value]));
    const semanticValues = Object.fromEntries(approved.map((item) => [item.mag_field_definitions.semantic_type, item.value]));
    const person = Object.fromEntries([
      ["fullName", semanticValues.CONTACT_NAME || dynamicFields.full_name], ["firstName", semanticValues.FIRST_NAME || dynamicFields.first_name],
      ["middleName", semanticValues.MIDDLE_NAME || dynamicFields.middle_name], ["lastName", semanticValues.LAST_NAME || dynamicFields.last_name], ["email", semanticValues.EMAIL || dynamicFields.business_email || dynamicFields.email],
      ["phone", semanticValues.PHONE || dynamicFields.business_phone || dynamicFields.phone], ["address", semanticValues.ADDRESS || dynamicFields.address],
      ["addressLine1", semanticValues.ADDRESS_LINE_1 || dynamicFields.address], ["addressLine2", semanticValues.ADDRESS_LINE_2 || dynamicFields.address_line_2],
      ["fullAddress", semanticValues.FULL_ADDRESS || dynamicFields.full_address], ["city", semanticValues.CITY || dynamicFields.city], ["state", semanticValues.STATE || dynamicFields.state], ["zip", semanticValues.ZIP || dynamicFields.zip]
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim()));
    return {
      id: `supabase:${row.id}`,
      label: row.label,
      kind: row.profile_type,
      dynamicFields,
      ...(Object.keys(person).length ? { person } : {}),
      status: row.status,
      sync: {
        source: "SUPABASE",
        remoteId: row.id,
        version: row.profile_version,
        updatedAt: row.updated_at,
        status: row.status,
        readOnly: true
      }
    };
  }

  async function sync({ reason = "background" } = {}) {
    const [definitions, profiles, stored] = await Promise.all([
      MAG.SupabaseClient.rest("mag_field_definitions?select=canonical_key,semantic_type,display_name,aliases,data_type,security_class,cache_policy,autofill_policy,review_requirement,active&active=eq.true"),
      MAG.SupabaseClient.rest("mag_profiles?select=id,label,profile_type,status,profile_scope,profile_version,updated_at&profile_scope=eq.CUSTOMER"),
      chrome.storage.local.get(MAG.Storage.KEYS.remoteProfiles)
    ]);
    const previous = stored[MAG.Storage.KEYS.remoteProfiles] || [];
    // Keep workflow-visible customer profiles in the local remote cache.
    // ARCHIVED records are intentionally excluded.
    //
    // Visibility and autofill eligibility are separate concerns. A profile may
    // be visible in MAG while still requiring review before it can autofill.
    const syncable = profiles.filter((row) => row.status !== "ARCHIVED");

    const changedIds = syncable
      .filter((row) => {
        const cached = previous.find(
          (item) => item.sync?.remoteId === row.id
        );

        return (
          !cached ||
          cached.sync?.version !== row.profile_version ||
          cached.sync?.updatedAt !== row.updated_at ||
          cached.status !== row.status
        );
      })
      .map((row) => row.id);
    let values = [];
    if (changedIds.length) {
      const encodedIds = changedIds.map((id) => `\"${id}\"`).join(",");
      values = await MAG.SupabaseClient.rest(`mag_profile_field_values?select=profile_id,value,validation_status,mag_field_definitions!inner(canonical_key,semantic_type,security_class,cache_policy,active)&profile_id=in.(${encodedIds})&validation_status=in.(VALID,NEEDS_REVIEW)&mag_field_definitions.security_class=eq.STANDARD&mag_field_definitions.cache_policy=eq.LOCAL&mag_field_definitions.active=eq.true`);
    }
    const remote = syncable.map((row) => {
      const cached = previous.find(
        (item) =>
          item.sync?.remoteId === row.id &&
          item.sync?.version === row.profile_version &&
          item.sync?.updatedAt === row.updated_at &&
          item.status === row.status
      );

      return cached || asProfile(row, values);
    });
    const localOnly = (await chrome.storage.local.get(MAG.Storage.KEYS.profiles))[MAG.Storage.KEYS.profiles] || [];
    const conflicts = remote.filter((candidate) => localOnly.some((item) => item.id === candidate.id)).map((item) => item.id);
    const activeCount = remote.filter((profile) => profile.status === "ACTIVE").length;
    const removedProfiles = previous.filter((item) => !syncable.some((row) => row.id === item.sync?.remoteId)).length;

    await MAG.Storage.replaceRemoteCache(
      remote.filter((candidate) => !conflicts.includes(candidate.id)),
      definitions,
      {
        status: "SUCCESS",
        conflicts,
        activeProfiles: activeCount,
        syncedProfiles: remote.length,
        updatedProfiles: changedIds.length,
        removedProfiles
      }
    );
    // Background syncs run every few minutes; audit only when the cache
    // changed or a person asked for the sync. Audit failure never fails a sync.
    const auth = await MAG.SupabaseClient.status();
    if (auth.user?.id && (changedIds.length || removedProfiles || ["manual", "login"].includes(reason))) {
      await MAG.SupabaseClient.rest("mag_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor_id: auth.user.id, action: "EXTENSION_SYNC", entity_type: "PROFILE_CACHE", success: true, metadata: {
        active_profile_count: activeCount,
        synced_profile_count: remote.length,
        updated_profile_count: changedIds.length,
        removed_profile_count: removedProfiles,
        conflict_count: conflicts.length,
        trigger: reason
      } }) }).catch(() => undefined);
    }
    return {
      activeProfiles: activeCount,
      syncedProfiles: remote.length,
      updatedProfiles: changedIds.length,
      removedProfiles,
      conflicts,
      lastSuccessfulSync: new Date().toISOString()
    };
  }

  MAG.SyncEngine = Object.freeze({ sync });
})(globalThis);
