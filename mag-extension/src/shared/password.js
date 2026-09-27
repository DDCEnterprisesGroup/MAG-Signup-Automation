(function initializePassword(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});

  // Look-alike characters (0 O 1 l I) are left out so a password can be read
  // back and retyped. Symbols are ones sign-up forms commonly accept.
  const SETS = Object.freeze({
    lower: "abcdefghijkmnopqrstuvwxyz",
    upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
    digits: "23456789",
    symbols: "!@#$%^&*-_=+?"
  });
  const MIN_LENGTH = 12;
  const MAX_LENGTH = 64;
  const DEFAULT_LENGTH = 16;

  // Unbiased integer in [0, max) from the platform CSPRNG (rejection sampling).
  function randomInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buffer = new Uint32Array(1);
    do root.crypto.getRandomValues(buffer); while (buffer[0] >= limit);
    return buffer[0] % max;
  }

  function pick(characters) {
    return characters[randomInt(characters.length)];
  }

  // At least one character from every enabled set, the rest from all of them,
  // then a Fisher-Yates shuffle so the guaranteed characters are not in fixed spots.
  function generate({ length = DEFAULT_LENGTH, symbols = true } = {}) {
    const size = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Number.parseInt(length, 10) || DEFAULT_LENGTH));
    const sets = [SETS.lower, SETS.upper, SETS.digits, ...(symbols ? [SETS.symbols] : [])];
    const all = sets.join("");
    const characters = sets.map(pick);
    while (characters.length < size) characters.push(pick(all));
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swap = randomInt(index + 1);
      [characters[index], characters[swap]] = [characters[swap], characters[index]];
    }
    return characters.join("");
  }

  MAG.Password = Object.freeze({ generate, SETS, MIN_LENGTH, MAX_LENGTH, DEFAULT_LENGTH });
})(globalThis);
