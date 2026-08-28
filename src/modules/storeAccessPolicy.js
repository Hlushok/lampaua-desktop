const MAIN_ONLY_KEYS = new Set(["selectedPlayerPath", "trustedPlayerPath"]);

function isMainOnlyStoreKey(key) {
  return typeof key === "string" && MAIN_ONLY_KEYS.has(key);
}

function assertRendererStoreKey(key) {
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
