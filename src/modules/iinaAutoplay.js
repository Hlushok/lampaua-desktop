// Convert an IINA single-file TorrServer stream into a playlist starting at that file.
// Return null for unsupported URLs to preserve the normal player behavior.
function buildIinaAutoplayUrl(externalUrl) {
  try {
    const iinaUrl = new URL(externalUrl);
    if (iinaUrl.protocol !== "iina:" || iinaUrl.hostname !== "weblink") {
      return null;
    }

    const requestedUrl = iinaUrl.searchParams.get("url");
    if (!requestedUrl) return null;

    const streamUrl = new URL(requestedUrl);
    if (
      !["http:", "https:"].includes(streamUrl.protocol) ||
      !/^\/stream\/[^/]+$/.test(streamUrl.pathname)
    ) {
      return null;
    }

    const hash = streamUrl.searchParams.get("link");
    const index = streamUrl.searchParams.get("index");
    if (
      !hash ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash) ||
      !index ||
      !/^(?:0|[1-9]\d*)$/.test(index)
    ) {
      return null;
    }

    const playlistUrl = new URL("/playlist/episodes.m3u", streamUrl);
    playlistUrl.searchParams.set("hash", hash);
    playlistUrl.searchParams.set("index", index);

    iinaUrl.searchParams.set("url", playlistUrl.toString());
    return iinaUrl.toString();
  } catch {
    return null;
  }
}

// The built-in Lampa "Next episode" switch is the only source of truth.
// Read its value when an episode is opened, rather than mirroring a second setting.
async function resolveIinaAutoplayUrl(externalUrl, isNextEpisodeEnabled) {
  const playlistUrl = buildIinaAutoplayUrl(externalUrl);
  if (!playlistUrl) return null;
  return (await isNextEpisodeEnabled()) ? playlistUrl : null;
}

module.exports = { buildIinaAutoplayUrl, resolveIinaAutoplayUrl };
