# IINA: automatically play subsequent torrent episodes (macOS)

## Enable

1. Install [IINA](https://iina.io/).
2. In Lampa Desktop, select **IINA** under **Settings → Player → Torrent player type**.
3. Use Lampa's existing **Settings → Player → Next episode** setting (`playlist_next`).
   It is enabled by default; there is **no separate IINA autoplay switch**.
4. In IINA, enable **Play next item automatically** in its Playlist settings.
5. Open an episode from a multi-episode torrent through TorrServer.

Lampa Desktop reads Lampa's built-in `playlist_next` setting when opening IINA.
When enabled, it replaces a supported TorrServer single-file stream URL with
a `/playlist/episodes.m3u?hash=...&index=...` URL. TorrServer creates the
playlist beginning at the selected file, and IINA plays it sequentially.
When disabled, IINA receives the original single-episode URL. Changes to
the built-in setting take effect on the next episode launch.

## Limitations

- Only torrents with multiple playable files **in the same torrent** are supported.
- TorrServer determines the file sequence; this may include specials or other
  media from a multi-season torrent. This feature does not filter by TV metadata.
- TorrServer GStreamer/HLS (`/gst/.../master.m3u8`) and ordinary online links
  are intentionally unaffected.
- Other external players and macOS platforms other than macOS are unaffected.
- If the server returns a missing/invalid playlist after macOS has opened IINA,
  Lampa cannot detect that playback failed. Disable the setting to restore
  the original single-episode launch.
- This does not synchronize watched-episode progress back from IINA to Lampa.

## Development tests

Run `yarn test` (or `node --test tests/*.test.js`) for URL transformation
and safety regression cases. End-to-end playback still requires macOS,
IINA and a running TorrServer instance with a multi-episode torrent.
