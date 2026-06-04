// useUnreadUpdates — small polling hook for the HQ Updates badge.
//
// Used by the portal sidebar (desktop) + bottom-nav (mobile) to render
// a notification dot/count next to the HQ Updates link. Polls every
// 60 seconds and also re-fetches on window focus, so opening the
// portal in another tab + reading there auto-clears the badge here.
//
// The mark-read flow lives inside PortalUpdatesPage — it calls
// `bumpUnread()` returned here to force an immediate re-fetch instead
// of waiting for the next poll tick.
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";

export default function useUnreadUpdates(enabled = true, intervalMs = 60_000) {
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { data } = await api.get("/portal/announcements/unread-count");
      setUnread(Number(data?.unread) || 0);
    } catch {
      // Silent — badge is non-critical; don't surface noise to user.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const id = setInterval(refresh, intervalMs);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, intervalMs, refresh]);

  return { unread, refresh };
}
