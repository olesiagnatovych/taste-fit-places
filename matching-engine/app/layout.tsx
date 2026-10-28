import type { Viewport } from "next";
import "./globals.css";

export const metadata = {
  title: "Discover",
};

// Real fix, 2026-09-26 — direct report, real iPhone (16 Pro Max, iOS Safari): a visible white
// gap above the hero photo, real device only, not reproducible in this project's own testing
// tools (Chromium-based emulation, including the "mobile" Android-UA preset — genuinely
// different rendering behavior from real iOS Safari, confirmed by trying both). `viewportFit:
// "cover"` is the real, standard fix for exactly this class of bug — without it, Safari
// letterboxes page content to the safe area only and won't let a fixed/100vh element paint
// under the status bar/notch, which is what a "gap above a full-bleed photo" looks like on a
// real notched/Dynamic-Island iPhone. Paired with page.module.css's own real fix (100dvh) for
// the layout-height half of this same class of bug. Honest limit, not glossed over: this is
// the well-documented, correct fix for the exact mechanism described, not something this
// session could visually confirm on a real device — no access to real iOS Safari here.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Root layout — no longer just a mount point (see the removed comment below this used to carry):
// the real homepage now exists (Task 85/86, app/page.tsx), ported from the real, confirmed-final
// design mockups (discover-v1-launch-FINAL.html and
// discover-error-state-category-FINAL.html, private, not in this repo). The Google Fonts <link> tags below are ported
// verbatim from those same mockups (Inter + IBM Plex Mono) — global here since this is currently
// the only real page besides the admin page (not in this repo), and loading the fonts once at the root avoids a second,
// per-page fetch. The handwritten 'Handwriting' font is NOT loaded here — it's a real, local file
// (public/fonts/Myfont4-Regular.ttf) declared via @font-face in app/page.module.css, scoped to
// the one page that actually uses it.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
