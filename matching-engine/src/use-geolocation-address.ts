"use client";
// Real, standalone browser-geolocation hook (2026-08-19) — the first client-side React state
// anywhere in this codebase (confirmed zero existing client components before this file; the
// only prior UI, app/admin/login/page.tsx, is a plain server-rendered <form>, no useState at
// all). NOT wired into explore-mode.ts or any real search UI yet — that UI doesn't exist yet
// either. Standalone, demonstrable via app/geolocation-test/page.tsx, per direct instruction.
//
// Real, deliberate: this hook does NOT import places-client.ts's reverseGeocode() directly — it
// POSTs real coordinates to /api/reverse-geocode instead, since GOOGLE_PLACES_API_KEY is a real
// server secret and must never reach the browser (same already-locked reasoning as the API
// route's own header comment).
import { useCallback, useState } from "react";

export type GeolocationAddressState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "resolving"; latitude: number; longitude: number }
  | { status: "granted"; latitude: number; longitude: number; address: string }
  | { status: "denied"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

/**
 * Real, three-state geolocation flow, per direct spec:
 *   1. granted -> real coordinates -> resolved into a real address string via /api/reverse-geocode
 *   2. denied -> real browser permission-denial error state
 *   3. unavailable/unsupported -> real fallback state (no navigator.geolocation at all, or a
 *      real non-permission error like a timeout/position-unavailable)
 * `state` is the single real source of truth for which of these applies right now;
 * `requestLocation()` is the real trigger — never fires automatically, only on real user action
 * (the calling page's button), consistent with browsers requiring a real user gesture for the
 * permission prompt anyway.
 */
export function useGeolocationAddress() {
  const [state, setState] = useState<GeolocationAddressState>({ status: "idle" });

  const requestLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setState({ status: "unavailable", message: "This browser does not support geolocation." });
      return;
    }

    setState({ status: "requesting" });

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setState({ status: "resolving", latitude, longitude });
        try {
          const res = await fetch("/api/reverse-geocode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ latitude, longitude }),
          });
          const body = (await res.json()) as { address?: string; error?: string };
          if (!res.ok || !body.address) {
            setState({ status: "error", message: body.error ?? "Could not resolve a real address for your location." });
            return;
          }
          setState({ status: "granted", latitude, longitude, address: body.address });
        } catch {
          setState({ status: "error", message: "Real network error resolving your address — could not reach /api/reverse-geocode." });
        }
      },
      (positionError) => {
        // Real, honest split — GeolocationPositionError.code: 1 = PERMISSION_DENIED (the real
        // "denied" state), 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT (both real "unavailable" cases,
        // distinct from the user actively denying permission).
        if (positionError.code === 1) {
          setState({ status: "denied", message: "Location permission was denied." });
        } else {
          setState({ status: "unavailable", message: `Could not determine your location (${positionError.message || "position unavailable"}).` });
        }
      },
      { timeout: 10000 }
    );
  }, []);

  return { state, requestLocation };
}
