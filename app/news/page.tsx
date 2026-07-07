// /news — SERVER-RENDERED (SSR fix, 2026-07-06).
//
// This page was a 'use client' shell that fetched /api/news in a useEffect —
// crawlers (and AI search) saw an EMPTY page, so the one blog-shaped surface
// contributed zero SEO. Now it reads Airtable server-side and ships full HTML:
// every post title/excerpt is crawlable, and the page is the permanent home
// the evergreen-content plan (reach research) publishes into.
//
// ISR (5 min) keeps Airtable reads negligible while new posts appear fast.

import type { Metadata } from 'next';
import Link from 'next/link';
import Container from '../components/Container';
import Divider from '../components/Divider';
import { getAllRecords, TABLES } from '@/lib/airtable';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'News & Updates — BuyHalfCow',
  description:
    'Weekly insights from the ranch, real beef economics, and the BuyHalfCow community.',
};

interface NewsPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  published_date: string;
  author: string;
}

async function loadPosts(): Promise<NewsPost[]> {
  try {
    const rows = (await getAllRecords(TABLES.NEWS_POSTS, "{Status} = 'Published'")) as any[];
    return rows
      .map((r) => ({
        id: String(r.id),
        title: String(r['title'] || ''),
        slug: String(r['slug'] || ''),
        excerpt: String(r['excerpt'] || ''),
        published_date: String(r['published_date'] || ''),
        author: String(r['author'] || ''),
      }))
      // Half-filled Airtable rows shouldn't produce blank articles.
      .filter((p) => p.title && p.slug)
      .sort((a, b) => (b.published_date || '').localeCompare(a.published_date || ''));
  } catch {
    return []; // honest empty state — never a broken page
  }
}

export default async function NewsPage() {
  const posts = await loadPosts();

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-12">
          <div className="text-center space-y-6">
            <h1 className="font-serif text-4xl md:text-5xl">News &amp; Updates</h1>
            <Divider />
            <p className="text-lg leading-relaxed text-saddle">
              Weekly insights from the ranch, land deals, and the BuyHalfCow community.
            </p>
          </div>

          {posts.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-lg text-saddle">No posts yet. Check back soon for updates.</p>
            </div>
          ) : (
            <div className="space-y-12">
              {posts.map((post) => (
                <article key={post.id} className="space-y-4">
                  <div className="space-y-2">
                    <h2 className="font-serif text-2xl md:text-3xl">
                      <Link
                        href={`/news/${post.slug}`}
                        className="hover:text-saddle transition-colors"
                      >
                        {post.title}
                      </Link>
                    </h2>
                    <div className="flex gap-4 text-sm text-saddle">
                      {post.published_date && !Number.isNaN(new Date(post.published_date).getTime()) && (
                        <span>
                          {new Date(post.published_date).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                          })}
                        </span>
                      )}
                      {post.author && <span>by {post.author}</span>}
                    </div>
                  </div>
                  {post.excerpt && <p className="text-lg leading-relaxed">{post.excerpt}</p>}
                  <Link
                    href={`/news/${post.slug}`}
                    className="inline-block text-charcoal hover:text-saddle transition-colors font-medium"
                  >
                    Read more &rarr;
                  </Link>
                  <Divider />
                </article>
              ))}
            </div>
          )}

          {/* Every content surface carries a money path (journey rule) —
              the old footer was just "back to home". */}
          <div className="text-center pt-8 space-y-3">
            <p className="text-[14px] text-saddle">
              here for the beef?{' '}
              <a href="/shop" className="underline hover:text-charcoal transition-colors">
                shop the ranches &rarr;
              </a>{' '}
              · or{' '}
              <a href="/guide" className="underline hover:text-charcoal transition-colors">
                get the free half-cow guide &rarr;
              </a>
            </p>
            <p>
              <Link href="/" className="text-sm text-saddle hover:text-charcoal transition-colors">
                &larr; Back to home
              </Link>
            </p>
          </div>
        </div>
      </Container>
    </main>
  );
}
