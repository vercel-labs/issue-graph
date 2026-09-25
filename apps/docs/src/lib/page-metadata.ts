import type { Metadata } from "next";
import { markdownPath } from "./docs-paths";
import { canonicalUrl, isPreview, siteName } from "./site";

export function pageMetadata(pathname: string, title: string, description: string): Metadata {
  const fullTitle = `${siteName} | ${title}`;
  const image = pathname === "/" ? "/og" : `/og${pathname}`;
  return {
    title: { absolute: fullTitle },
    description,
    alternates: {
      canonical: canonicalUrl(pathname),
      types: { "text/markdown": canonicalUrl(markdownPath(pathname)) },
    },
    robots: isPreview ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName,
      url: canonicalUrl(pathname),
      title: fullTitle,
      description,
      images: [{ url: canonicalUrl(image), width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [canonicalUrl(image)],
    },
  };
}
