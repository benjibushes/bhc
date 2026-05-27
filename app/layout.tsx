import type { Metadata } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";
import Header from "./components/Header";
import PromoBar from "./components/PromoBar";
import Analytics from "./components/Analytics";
import PixelTracker from "./components/PixelTracker";

// ClerkProvider was added Auth Phase 0 (2026-05-26) and removed same
// day after Clerk domain reservation conflict blocked production
// activation. Clerk wrappers in lib/*Auth.ts remain as flag-gated dead
// code (CLERK_*_ENABLED default false). No runtime cost. Revisit
// when picking a TOTP/SSO path (otplib, Auth.js v5, or vendor swap).

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "BuyHalfCow — Private Access Network",
    template: "%s — BuyHalfCow"
  },
  description: "Private network connecting verified ranchers, serious buyers, and partners. Not a marketplace. Not e-commerce. Built on trust, transparency, and real relationships.",
  keywords: ["ranch beef", "grass-fed beef", "direct from rancher", "ranch land deals", "certified ranchers", "private network", "beef buying", "ranch partnerships"],
  authors: [{ name: "BuyHalfCow" }],
  creator: "BuyHalfCow",
  metadataBase: new URL("https://buyhalfcow.com"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://buyhalfcow.com",
    title: "BuyHalfCow — Private Access Network",
    description: "Private network connecting verified ranchers, serious buyers, and partners.",
    siteName: "BuyHalfCow",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "BuyHalfCow — Private Access Network" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "BuyHalfCow — Private Access Network",
    description: "Private network connecting verified ranchers with serious buyers.",
    creator: "@buyhalfcow",
    images: ["/og-image.png"],
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'BuyHalfCow',
  url: 'https://buyhalfcow.com',
  logo: 'https://buyhalfcow.com/bhc-logo.png',
  description: 'Private membership network connecting verified American ranchers with serious buyers. Direct ranch beef, no middlemen.',
  address: {
    '@type': 'PostalAddress',
    streetAddress: '1001 S. Main St. Ste 600',
    addressLocality: 'Kalispell',
    addressRegion: 'MT',
    postalCode: '59901',
    addressCountry: 'US',
  },
  sameAs: [
    'https://instagram.com/buyhalfcow',
  ],
  foundingDate: '2026',
  founder: {
    '@type': 'Person',
    name: 'Benjamin Beauchman',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body
        className={`${playfair.variable} ${inter.variable} antialiased`}
      >
        <PixelTracker />
        <Analytics />
        <PromoBar />
        <Header />
        {children}
      </body>
    </html>
  );
}
