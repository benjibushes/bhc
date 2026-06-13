'use client';

import { useState, useEffect } from 'react';
import Container from '../components/Container';
import Divider from '../components/Divider';
import Link from 'next/link';

interface NewsPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  published_date: string;
  author: string;
}

export default function NewsPage() {
  const [posts, setPosts] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    fetchPosts();
  }, []);

  const fetchPosts = async () => {
    try {
      const response = await fetch('/api/news');
      const data = await response.json();
      // Drop records that can't render (no title or slug) — half-filled
      // Airtable rows shouldn't produce blank articles on the public feed.
      const publishable = Array.isArray(data)
        ? data.filter((p: NewsPost) => p?.title && p?.slug)
        : [];
      setPosts(publishable);
    } catch (error) {
      console.error('Error fetching news:', error);
      setLoadError(true);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="text-center">
            <p className="text-lg text-saddle">Pulling the latest from the ranch...</p>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-12">
          {/* Header */}
          <div className="text-center space-y-6">
            <h1 className="font-serif text-4xl md:text-5xl">
              News & Updates
            </h1>
            <Divider />
            <p className="text-lg leading-relaxed text-saddle">
              Weekly insights from the ranch, land deals, and the BuyHalfCow community.
            </p>
          </div>

          {/* Posts List */}
          {loadError && !loading ? (
            <div className="text-center py-12">
              <p className="text-lg text-saddle">
                Couldn&apos;t load the news feed - the server didn&apos;t respond. Refresh the page, or check back in a few minutes.
              </p>
            </div>
          ) : posts.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-lg text-saddle">
                No posts yet. Check back soon for updates.
              </p>
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
                        <span>{new Date(post.published_date).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric'
                        })}</span>
                      )}
                      {post.author && <span>by {post.author}</span>}
                    </div>
                  </div>
                  <p className="text-lg leading-relaxed">{post.excerpt}</p>
                  <Link
                    href={`/news/${post.slug}`}
                    className="inline-block text-charcoal hover:text-saddle transition-colors font-medium"
                  >
                    Read more →
                  </Link>
                  <Divider />
                </article>
              ))}
            </div>
          )}

          <div className="text-center pt-8">
            <Link href="/" className="text-charcoal hover:text-saddle transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}


