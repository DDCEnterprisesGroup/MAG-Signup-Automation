(function initializeSupabaseConfig(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  // This publishable key is intentionally client-safe. Never add a service-role key here.
  MAG.SUPABASE = Object.freeze({
    url: "https://swsnttpchmxekbftcvlu.supabase.co",
    publishableKey: "sb_publishable_ZCWoAuyp-QFK0YP3uQvOXQ_c9saifdt",
    restrictedFunction: "mag-restricted-value"
  });
})(globalThis);
