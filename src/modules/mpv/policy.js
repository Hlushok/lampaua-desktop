const origins = new Set(["https://kinohub.uk", "http://lampaua.mooo.com"]);
function authorize(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    return false;
  try {
    return origins.has(new URL(event.senderFrame.url).origin);
  } catch {
    return false;
  }
}
function normalizeSource(value) {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  )
    throw new TypeError("Invalid media URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new TypeError("Only HTTP/HTTPS media is allowed");
  return url.href;
}
module.exports = { authorize, normalizeSource };
