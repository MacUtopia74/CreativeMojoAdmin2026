// YouTube serves thumbnails from stable URLs (e.g. .../hqdefault.jpg),
// so when an admin updates a thumbnail on YouTube the file changes but
// the URL doesn't — the browser keeps showing its cached old copy. We
// append a cache-busting query param tied to the playlist's
// ``last_synced_at`` so every fresh sync produces a unique URL,
// forcing the browser to refetch.
export function bustThumb(url, ver) {
  if (!url) return url;
  if (!ver) return url;
  // Reduce the version to something short + stable per sync
  const tag = encodeURIComponent(String(ver).slice(0, 25));
  return url + (url.includes("?") ? "&" : "?") + `v=${tag}`;
}
