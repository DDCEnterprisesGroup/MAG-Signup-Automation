(function initializeSyncEngine(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  function asProfile(row, values) {
    return {
      id: `supabase:${row.id}`,
      label: row.label,
      kind: row.profile_type,
      dynamicFields: Object.fromEntries(values.filter((item) => item.profile_id === row.id).map((item) => [item.mag_field_definitions.canonical_key, item.value])),
      sync: { source: "SUPABASE", remoteId: row.id, version: row.profile_version, updatedAt: row.updated_at, readOnly: true }
    };
  }

  async function sync() {
    const [definitions, profiles, stored] = await Promise.all([
      MAG.SupabaseClient.rest("mag_field_definitions?select=canonical_key,semantic_type,display_name,aliases,data_type,security_class,cache_policy,autofill_policy,review_requirement,active&active=eq.true"),
      MAG.SupabaseClient.rest("mag_profiles?select=id,label,profile_type,status,profile_scope,profile_version,updated_at&profile_scope=eq.CUSTOMER"),
      chrome.storage.local.get(MAG.Storage.KEYS.remoteProfiles)
    ]);
    const previous = stored[MAG.Storage.KEYS.remoteProfiles] || [];
    const active = profiles.filter((row) => row.status === "ACTIVE");
    const changedIds = active.filter((row) => previous.find((item) => item.sync?.remoteId === row.id)?.sync?.version !== row.profile_version).map((row) => row.id);
    let values = [];
    if (changedIds.length) {
      const encodedIds = changedIds.map((id) => `\"${id}\"`).join(",");
      values = await MAG.SupabaseClient.rest(`mag_profile_field_values?select=profile_id,value,validation_status,mag_field_definitions!inner(canonical_key,security_class,cache_policy,active)&profile_id=in.(${encodedIds})&validation_status=in.(VALID,NEEDS_REVIEW)&mag_field_definitions.security_class=eq.STANDARD&mag_field_definitions.cache_policy=eq.LOCAL&mag_field_definitions.active=eq.true`);
    }
    const remote = active.map((row) => {
      const cached = previous.find((item) => item.sync?.remoteId === row.id && item.sync?.version === row.profile_version);
      return cached || asProfile(row, values);
    });
    const localOnly = (await chrome.storage.local.get(MAG.Storage.KEYS.profiles))[MAG.Storage.KEYS.profiles] || [];
    const conflicts = remote.filter((candidate) => localOnly.some((item) => item.id === candidate.id)).map((item) => item.id);
    await MAG.Storage.replaceRemoteCache(remote.filter((candidate) => !conflicts.includes(candidate.id)), definitions, { status: "SUCCESS", conflicts, activeProfiles: remote.length });
    const auth = await MAG.SupabaseClient.status();
    if (auth.user?.id) await MAG.SupabaseClient.rest("mag_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor_id: auth.user.id, action: "EXTENSION_SYNC", entity_type: "PROFILE_CACHE", success: true, metadata: { active_profile_count: remote.length, updated_profile_count: changedIds.length, conflict_count: conflicts.length } }) });
    return { activeProfiles: remote.length, updatedProfiles: changedIds.length, conflicts, lastSuccessfulSync: new Date().toISOString() };
  }

  MAG.SyncEngine = Object.freeze({ sync });
})(globalThis);
