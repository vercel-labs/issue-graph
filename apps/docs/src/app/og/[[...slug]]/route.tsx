import { isSafePathSegments } from "@/lib/docs-paths";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { landingTitle } from "@/lib/landing-content";
import { renderOgImage } from "@/lib/og-image";

export async function GET(_request: Request, context: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await context.params;
  let title = landingTitle.replace(" before ", "\nbefore ");
  if (slug.length) {
    if (slug[0] !== "docs" || !isSafePathSegments(slug))
      return new Response("Not Found", { status: 404 });
    const page = geistdocsSource.source.getPage(slug.slice(1), "en");
    if (!page) return new Response("Not Found", { status: 404 });
    title = page.data.title ?? "Documentation";
  }

  return renderOgImage(title);
}
