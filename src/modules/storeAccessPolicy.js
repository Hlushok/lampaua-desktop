const MAIN_ONLY_KEYS = new Set(["selectedPlayerPath", "trustedPlayerPath"]);

function isMainOnlyStoreKey(key) {
  if (typeof key !== "string") return false;
  const rootKey = key.split(".", 1)[0];
  return MAIN_ONLY_KEYS.has(rootKey);
}

function assertRendererStoreKey(key) {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Store key must be a non-empty string");
  }
  if (isMainOnlyStoreKey(key)) {
    throw new Error(`Store key ${key} is managed by the main process`);
  }
}

function publicStoreSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !isMainOnlyStoreKey(key)),
  );
}

module.exports = {
  assertRendererStoreKey,
  isMainOnlyStoreKey,
  publicStoreSnapshot,
};
