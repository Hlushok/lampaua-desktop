const DEFAULT_LAMPA_URL = "https://kinohub.uk/";
const LEGACY_LAMPA_URL = "http://lampaua.mooo.com/";
const ALLOWED_LAMPA_URLS = [DEFAULT_LAMPA_URL, LEGACY_LAMPA_URL];

function normalizeLampaUrl(value) {
  if (value === "https://kinohub.uk") return DEFAULT_LAMPA_URL;
  if (value === "http://lampaua.mooo.com") return LEGACY_LAMPA_URL;

  if (ALLOWED_LAMPA_URLS.includes(value)) return value;

  return DEFAULT_LAMPA_URL;
}

module.exports = {
  ALLOWED_LAMPA_URLS,
  DEFAULT_LAMPA_URL,
  LEGACY_LAMPA_URL,
  normalizeLampaUrl,
};
