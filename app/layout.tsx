import type { Metadata } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";

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
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://buyhalfcow.com",
    title: "BuyHalfCow — Private Access Network",
    description: "Private network connecting verified ranchers, serious buyers, and partners.",
    siteName: "BuyHalfCow",
  },
  twitter: {
    card: "summary_large_image",
    title: "BuyHalfCow — Private Access Network",
    description: "Private network connecting verified ranchers with serious buyers.",
    creator: "@buyhalfcow",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${playfair.variable} ${inter.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
