(function initializeDynamicRegistry(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  let definitions = [];
  const normalize = (value) => MAG.Normalize.normalizeText(value || "");

  function setDefinitions(next) {
    definitions = Array.isArray(next) ? next.filter((item) => item && item.active) : [];
  }

  function match(field) {
    const sources = [field.label, field.ariaLabel, field.name, field.id, field.placeholder, field.describedBy, field.legend].map(normalize).filter(Boolean);
    let best = null;
    for (const definition of definitions) {
      const aliases = [definition.display_name, definition.canonical_key.replaceAll("_", " "), ...(definition.aliases || [])].map(normalize);
      let score = 0;
      for (const source of sources) for (const alias of aliases) {
        if (source === alias) score = Math.max(score, 96);
        else if (source.includes(alias) || alias.includes(source)) score = Math.max(score, 78);
      }
      if (score > (best?.score || 0)) best = { definition, score };
    }
    return best;
  }

  MAG.DynamicRegistry = Object.freeze({ setDefinitions, match, definitions: () => [...definitions] });
})(globalThis);
