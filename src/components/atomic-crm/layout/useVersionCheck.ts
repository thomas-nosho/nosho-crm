import { useCallback, useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { APP_VERSION } from "../../../version";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

type VersionPayload = { version?: string };

async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const url = `${import.meta.env.BASE_URL}version.json?t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data: VersionPayload = await res.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

async function nukeCachesAndReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } finally {
    window.location.reload();
  }
}

export function useVersionCheck() {
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  const { updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        registration.update().catch(() => {});
      }, POLL_INTERVAL_MS);
    },
  });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const remote = await fetchRemoteVersion();
      if (cancelled || !remote) return;
      if (remote !== APP_VERSION) {
        setLatestVersion(remote);
      }
    };

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      await updateServiceWorker(true);
    } catch {
      await nukeCachesAndReload();
    }
  }, [updateServiceWorker]);

  return {
    hasUpdate: latestVersion !== null,
    currentVersion: APP_VERSION,
    latestVersion,
    reload,
  };
}
