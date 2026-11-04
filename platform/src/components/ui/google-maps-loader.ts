/// <reference types="google.maps" />

/**
 * Loads the Maps JavaScript API once per page and reports whether Google
 * accepted the key.
 *
 * Two failure modes matter in production and neither throws on its own:
 *
 *  - the script never arrives (offline office, ad-blocker, blocked domain),
 *    so there is a timeout;
 *  - the key is rejected (wrong key, referrer restriction, billing disabled).
 *    Google reports that by calling a global `gm_authFailure` *after* the map
 *    has been created, and greys the map out. We listen for it and let the
 *    caller swap to OpenStreetMap instead of leaving a grey rectangle.
 */

type Listener = (reason: string) => void;

const LOAD_TIMEOUT_MS = 12_000;
const CALLBACK = "__rautGoogleMapsReady";

let loading: Promise<typeof google> | null = null;
let authFailure: string | null = null;
const listeners = new Set<Listener>();

type MapsWindow = Window & {
  gm_authFailure?: () => void;
  __rautGoogleMapsReady?: () => void;
  google?: typeof google;
};

export function onGoogleMapsUnavailable(listener: Listener): () => void {
  listeners.add(listener);
  if (authFailure) listener(authFailure);
  return () => {
    listeners.delete(listener);
  };
}

function broadcast(reason: string) {
  authFailure = reason;
  for (const l of listeners) l(reason);
}

export function loadGoogleMaps(apiKey: string): Promise<typeof google> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps can only load in a browser"));
  }
  if (authFailure) return Promise.reject(new Error(authFailure));

  // One key per page load. The settings screen reloads after a key change, so
  // this only trips if two companies' pages were somehow composed together.
  if (loading) return loading;

  const w = window as MapsWindow;

  loading = new Promise<typeof google>((resolve, reject) => {
    const fail = (reason: string) => {
      window.clearTimeout(timer);
      broadcast(reason);
      reject(new Error(reason));
    };

    const timer = window.setTimeout(() => {
      fail("the Google Maps script did not load");
    }, LOAD_TIMEOUT_MS);

    w.gm_authFailure = () => {
      // Fires asynchronously, possibly long after resolve(); broadcast so
      // mounted maps hear it even though the promise has settled.
      window.clearTimeout(timer);
      broadcast("Google rejected the API key");
      reject(new Error("Google rejected the API key"));
    };

    w.__rautGoogleMapsReady = () => {
      window.clearTimeout(timer);
      if (w.google?.maps) resolve(w.google);
      else fail("Google Maps loaded without a maps namespace");
    };

    const params = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      loading: "async",
      libraries: "maps,marker",
      callback: CALLBACK,
    });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => fail("the Google Maps script could not be fetched");
    document.head.appendChild(script);
  });

  return loading;
}
