import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Newsreader } from "next/font/google";
import { SettingsProvider } from "@/components/SettingsProvider";
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
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#2b2f36" },
    { media: "(prefers-color-scheme: light)", color: "#f2f2f4" },
  ],
};

/** Applies the stored theme and type settings before first paint, so opening
 *  the app at night never flashes a bright page. */
const themeScript = `(function(){try{
var s=JSON.parse(localStorage.getItem('aloud.settings.v1')||'{}');
var d=document.documentElement;
d.dataset.theme=['dark','warm','light','sepia'].indexOf(s.theme)>=0?s.theme:'${DEFAULT_SETTINGS.theme}';
d.dataset.face=s.face==='sans'?'sans':'serif';
d.style.setProperty('--reader-size',(s.fontSize||${DEFAULT_SETTINGS.fontSize})+'px');
d.style.setProperty('--reader-leading',String(s.lineHeight||${DEFAULT_SETTINGS.lineHeight}));
}catch(e){document.documentElement.dataset.theme='${DEFAULT_SETTINGS.theme}';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme={DEFAULT_SETTINGS.theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${newsreader.variable} ${instrumentSans.variable}`}>
        <SettingsProvider>{children}</SettingsProvider>
      </body>
    </html>
  );
}
