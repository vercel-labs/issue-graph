import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage } from "@vercel/geistdocs/pages/docs";
import { notFound } from "next/navigation";
import { cache } from "react";
import { docsPath, isSafePathSegments, markdownPath } from "@/lib/docs-paths";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { pageMetadata } from "@/lib/page-metadata";
import { canonicalUrl, siteDescription, siteName } from "@/lib/site";

type PageProps = { params: Promise<{ slug?: string[] }> };

const getPage = cache(async (params: PageProps["params"]) => {
  const { slug = [] } = await params;
  if (!isSafePathSegments(slug)) notFound();
  const page = geistdocsSource.source.getPage(slug, "en");
  if (!page) notFound();
  return { page, params: { lang: "en", slug } };
});

const docsPage = createDocsPage({
  config,
  source: geistdocsSource,
  getMarkdownUrl: ({ page }) => markdownPath(docsPath(page.slugs)),
  renderTop: ({ data }) => (
    <>
      <span id="main-content" tabIndex={-1} className="sr-only">
        Documentation content
      </span>
      <MobileDocsBar toc={data.toc} />
    </>
  ),
});

export default async function Page({ params }: PageProps) {
  const validated = await getPage(params);
  const { page } = validated;
  const url = canonicalUrl(docsPath(page.slugs));
  // The Geistdocs frontmatter schema keeps navTitle, but PageData does not type it.
  const { navTitle } = page.data as { navTitle?: string };
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: page.data.title,
        description: page.data.description ?? siteDescription,
        url,
        isPartOf: { "@type": "WebSite", name: siteName, url: canonicalUrl("/") },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Docs", item: canonicalUrl("/docs") },
          ...(page.slugs.length
            ? [
                {
                  "@type": "ListItem",
                  position: 2,
                  name: navTitle ?? page.data.title,
                  item: url,
                },
              ]
            : []),
        ],
      },
    ],
  };
  return (
    <>
      <script type="application/ld+json">
        {JSON.stringify(structuredData).replace(/</g, "\\u003c")}
      </script>
      <docsPage.Page params={Promise.resolve(validated.params)} />
    </>
  );
}

export async function generateMetadata({ params }: PageProps) {
  const { page } = await getPage(params);
  return pageMetadata(
    docsPath(page.slugs),
    page.data.title ?? "Documentation",
    page.data.description ?? siteDescription,
  );
}

export function generateStaticParams() {
  return geistdocsSource.source.getPages("en").map((page) => ({ slug: page.slugs }));
}
