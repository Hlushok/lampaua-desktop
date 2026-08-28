const MAIN_ONLY_KEYS = new Set(["selectedPlayerPath", "trustedPlayerPath"]);
const STORE_PATH_SYNTAX = /[.\\[\]\\]/u;

function isFlatStoreKey(key) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key === key.trim() &&
    !STORE_PATH_SYNTAX.test(key)
  );
}

function isMainOnlyStoreKey(key) {
  return isFlatStoreKey(key) && MAIN_ONLY_KEYS.has(key);
}

function isPublicStoreKey(key) {
  return isFlatStoreKey(key) && !isMainOnlyStoreKey(key);
}

function assertRendererStoreKey(key) {
  if (!isFlatStoreKey(key)) {
    throw new Error("Store key must be a flat non-empty string");
  }
  if (isMainOnlyStoreKey(key)) {
    throw new Error(`Store key ${key} is managed by the main process`);
  }
}

function publicStoreSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => isPublicStoreKey(key)),
  );
}

module.exports = {
  assertRendererStoreKey,
  isFlatStoreKey,
  isMainOnlyStoreKey,
  isPublicStoreKey,
  publicStoreSnapshot,
};
