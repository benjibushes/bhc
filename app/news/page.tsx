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

  useEffect(() => {
    fetchPosts();
  }, []);

  const fetchPosts = async () => {
    try {
      const response = await fetch('/api/news');
      const data = await response.json();
      setPosts(data);
    } catch (error) {
      console.error('Error fetching news:', error);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="text-center">
            <p className="text-lg text-[#6B4F3F]">Loading...</p>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-3xl mx-auto space-y-12">
          {/* Header */}
          <div className="text-center space-y-6">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl">
              News & Updates
            </h1>
            <Divider />
            <p className="text-lg leading-relaxed text-[#6B4F3F]">
              Weekly insights from the ranch, land deals, and the BuyHalfCow community.
            </p>
          </div>

          {/* Posts List */}
          {posts.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-lg text-[#6B4F3F]">
                No posts yet. Check back soon for updates.
              </p>
            </div>
          ) : (
            <div className="space-y-12">
              {posts.map((post) => (
                <article key={post.id} className="space-y-4">
                  <div className="space-y-2">
                    <h2 className="font-[family-name:var(--font-serif)] text-2xl md:text-3xl">
                      <Link 
                        href={`/news/${post.slug}`}
                        className="hover:text-[#6B4F3F] transition-colors"
                      >
                        {post.title}
                      </Link>
                    </h2>
                    <div className="flex gap-4 text-sm text-[#6B4F3F]">
                      <span>{new Date(post.published_date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      })}</span>
                      {post.author && <span>by {post.author}</span>}
                    </div>
                  </div>
                  <p className="text-lg leading-relaxed">{post.excerpt}</p>
                  <Link
                    href={`/news/${post.slug}`}
                    className="inline-block text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors font-medium"
                  >
                    Read more →
                  </Link>
                  <Divider />
                </article>
              ))}
            </div>
          )}

          <div className="text-center pt-8">
            <Link href="/" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              ← Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}


