(function initializeAdapters(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  // Adapters supplement the generic classifier. They never control submission.
  const adapters = [
    {
      id: "mag-fixtures",
      hosts: ["127.0.0.1", "localhost"],
      pathPattern: /\/mag-fixtures\//i,
      mappings: {
        "[data-mag-semantic]": { fromAttribute: "data-mag-semantic" }
      }
    }
  ];

  function findAdapter(locationLike) {
    const host = String(locationLike && locationLike.hostname || "").toLowerCase();
    const path = String(locationLike && locationLike.pathname || "");
    return adapters.find((adapter) => adapter.hosts.includes(host) && (!adapter.pathPattern || adapter.pathPattern.test(path))) || null;
  }

  function semanticForElement(element, adapter) {
    if (!adapter) return null;
    for (const [selector, config] of Object.entries(adapter.mappings || {})) {
      if (!element.matches(selector)) continue;
      const raw = config.fromAttribute ? element.getAttribute(config.fromAttribute) : config.semantic;
      const semantic = String(raw || "").toUpperCase();
      if (MAG.SEMANTIC_TYPES.includes(semantic)) return { semantic, adapterId: adapter.id };
    }
    return null;
  }

  MAG.SiteAdapters = Object.freeze({ adapters, findAdapter, semanticForElement });
})(globalThis);
