import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import SwRegister from "@/components/sw-register";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

// Body and UI text. Variable font: the weights it's used at (400/500/600/700)
// come from the classes applied in markup, not a fixed weight list here.
const hankenGrotesk = localFont({
  src: "./fonts/hanken-grotesk-latin-variable.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-hanken-grotesk",
});

// Headings only: page titles and band headers. Static font, so the weights
// actually used (500 for titles, 600 for occasional emphasis) must be listed.
const spectral = localFont({
  src: [
    { path: "./fonts/spectral-latin-400.woff2", weight: "400" },
    { path: "./fonts/spectral-latin-500.woff2", weight: "500" },
    { path: "./fonts/spectral-latin-600.woff2", weight: "600" },
  ],
  display: "swap",
  variable: "--font-spectral",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin-variable.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Life OS",
  description: "Executive assistant and work-life second brain",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-180.png",
  },
  appleWebApp: {
    capable: true,
    title: "Life OS",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f9fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1e30" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${hankenGrotesk.variable} ${spectral.variable} ${geistMono.variable} h-full antialiased`}
      // The boot script below writes data-theme on this element before React
      // hydrates, which is the whole point: it stops the app flashing light
      // before turning dark. React then sees an attribute the server did not
      // render and warns. The warning is correct and the behaviour is
      // deliberate, so it is suppressed on this element only, which is the
      // standard way to run a pre-paint theme script.
      suppressHydrationWarning
    >
      <head>
        {/* Resolves the theme setting before first paint, so the app never
            flashes light before turning dark. Must run ahead of React. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
