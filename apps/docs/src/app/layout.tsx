import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DocsProvider } from "@/components/geistdocs-provider";
import { config } from "@/lib/geistdocs/config";
import { pageMetadata } from "@/lib/page-metadata";
import { siteDescription, siteTagline, siteUrl } from "@/lib/site";
import "./globals.css";

export const dynamic = "force-dynamic";
export const viewport: Viewport = { viewportFit: "cover" };
export const metadata: Metadata = {
  ...pageMetadata("/", siteTagline, siteDescription),
  metadataBase: new URL(siteUrl),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
    >
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <DocsProvider>
          <Navbar config={config} />
          {children}
          <Footer />
        </DocsProvider>
      </body>
    </html>
  );
}
