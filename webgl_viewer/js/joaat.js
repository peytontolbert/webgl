// GTA "joaat" (Jenkins one-at-a-time) hash, used heavily for model/archetype names.
// Returns an unsigned 32-bit integer.
export function joaat(input) {
  const str = String(input ?? '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash += str.charCodeAt(i);
    hash += (hash << 10);
    hash ^= (hash >>> 6);
  }
  hash += (hash << 3);
  hash ^= (hash >>> 11);
  hash += (hash << 15);
  return (hash >>> 0);
}


