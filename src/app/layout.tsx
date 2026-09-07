import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif, Newsreader } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import { SettingsProvider } from "@/components/SettingsProvider";
import { SettingsSync } from "@/components/SettingsSync";
import { InstallPromptCatcher } from "@/components/install/InstallPromptCatcher";
import { ServiceWorker } from "@/components/install/ServiceWorker";
import { DEFAULT_SETTINGS } from "@/lib/storage/prefs";
import "./globals.css";

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
  weight: ["400", "500", "600"],
});

/** Display only: the wordmark, the hero counter, screen titles. Never body. */
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Aloud",
  description: "Listen to your books read aloud, with the words lighting up as they're spoken.",
  manifest: "/manifest.webmanifest",
  applicationName: "Aloud",
  appleWebApp: {
    capable: true,
    title: "Aloud",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
  metadataBase: new URL("https://aloud-red.vercel.app"),
  openGraph: {
    title: "Aloud",
    description: "Bring your own books. Press play, and every word lights up as it's spoken.",
    url: "/",
    siteName: "Aloud",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
  twitter: { card: "summary", title: "Aloud", description: "Bring your own books. Press play, and every word lights up as it's spoken.", images: ["/icons/icon-512.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    // The dark canvas, oklch(0.235 0.011 250), as sRGB. SettingsProvider
    // rewrites this to the chosen theme's canvas once the app is running.
    { media: "(prefers-color-scheme: dark)", color: "#1a1f23" },
    { media: "(prefers-color-scheme: light)", color: "#f1f4f6" },
  ],
};

/** Applies the stored theme and type settings before first paint, so opening
 *  the app at night never flashes a bright page. */
const themeScript = `(function(){try{
var s=JSON.parse(localStorage.getItem('aloud.settings.v1')||'{}');
var d=document.documentElement;
d.dataset.theme=['dark','warm','light','sepia'].indexOf(s.theme)>=0?s.theme:'${DEFAULT_SETTINGS.theme}';
d.dataset.face=s.face==='sans'?'sans':'serif';
d.dataset.accent=['slate','violet','moss'].indexOf(s.accent)>=0?s.accent:'slate';
d.style.setProperty('--reader-size',(s.fontSize||${DEFAULT_SETTINGS.fontSize})+'px');
d.style.setProperty('--reader-leading',String(s.lineHeight||${DEFAULT_SETTINGS.lineHeight}));
}catch(e){document.documentElement.dataset.theme='${DEFAULT_SETTINGS.theme}';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The font variables live on <html>, not <body>: the --font-ui tokens in
  // globals.css are resolved on :root, and a variable defined further down
  // the tree is invisible there.
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${instrumentSans.variable} ${instrumentSerif.variable}`}
      data-theme={DEFAULT_SETTINGS.theme}
      data-accent={DEFAULT_SETTINGS.accent}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AuthProvider>
          <SettingsProvider>
            <SettingsSync />
            <InstallPromptCatcher />
            <ServiceWorker />
            {children}
            {/* Page views only, and only where Vercel is serving: the script
                no-ops elsewhere, so local and self-hosted runs stay silent. */}
            <Analytics />
          </SettingsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
