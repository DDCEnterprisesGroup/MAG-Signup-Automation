(function initializeSupabaseConfig(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  // Fill these with the dedicated MAG project's public URL/key before UAT.
  // Never use the historical DDC project or add a service-role key here.
  MAG.SUPABASE = Object.freeze({
    url: "https://qtjpahbuewptnocqklas.supabase.co",
    publishableKey: "sb_publishable_V209L8i-bGTLSXfTXZIpfg_qRc6Qxfq",
    restrictedFunction: "mag-restricted-value"
  });
})(globalThis);
