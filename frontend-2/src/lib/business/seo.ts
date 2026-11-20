import type { Requirement, SeoAdvice } from "./types";

/**
 * SEO advice for every web project: what is done as standard, and what is
 * worth adding for this kind of site. Pure, so it is part of every quote.
 */
export function seoAdvice(req: Requirement): SeoAdvice {
  const has = (m: string) => req.modules.includes(m as never);
  const pages = req.pages.join(" ").toLowerCase();

  const included = [
    "Unique page title and meta description on every page",
    "Mobile-friendly, fast-loading pages (optimised images, Core Web Vitals)",
    "Clean URLs, heading structure (H1-H3) and image alt text",
    "sitemap.xml, robots.txt and HTTPS",
    "Open Graph previews for WhatsApp, Facebook and LinkedIn shares",
  ];

  const recommended: string[] = [];
  if (!has("seo-setup")) recommended.push("Google Search Console and Google Analytics set-up (SEO setup module)");
  if (req.projectType === "ecommerce") {
    recommended.push("Product structured data (price, stock, reviews) for rich Google results");
    recommended.push("Canonical URLs on filtered and sorted product lists to avoid duplicate pages");
    recommended.push("Unique descriptions for each product instead of manufacturer text");
  } else if (req.projectType === "web-app") {
    recommended.push("Keep public marketing pages separate from the logged-in app so Google can index them");
  } else {
    recommended.push("LocalBusiness structured data with address, hours and phone");
    recommended.push("Google Business Profile listing linked to the website (free; important for local search)");
  }
  if (has("blog") || req.projectType === "cms-website") {
    recommended.push("Article structured data and a posting plan of 2-4 posts a month");
  } else if (req.projectType !== "web-app") {
    recommended.push("A blog or news section later, for ongoing search traffic");
  }
  if (has("multilingual")) recommended.push("hreflang tags so Google shows the right language version");
  if (req.pages.length === 1 || /one page/.test(pages)) {
    recommended.push("One-page sites rank for fewer search terms; add separate pages for key services later");
  }

  return { included, recommended, keywords: (req.seoKeywords ?? []).slice(0, 12) };
}
