'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Link from 'next/link';

interface NewsPost {
  id: string;
  title: string;
  slug: string;
  content: string;
  published_date: string;
  author: string;
}

export default function NewsPostPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [post, setPost] = useState<NewsPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (slug) {
      fetchPost();
    }
  }, [slug]);

  const fetchPost = async () => {
    try {
      const response = await fetch(`/api/news/${slug}`);
      if (!response.ok) {
        setError(true);
        setLoading(false);
        return;
      }
      const data = await response.json();
      setPost(data);
    } catch (error) {
      console.error('Error fetching post:', error);
      setError(true);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="text-center">
            <p className="text-lg text-saddle">Loading...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (error || !post) {
    return (
      <main className="min-h-screen py-24 bg-bone text-charcoal">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-8">
            <h1 className="font-serif text-4xl">
              Post Not Found
            </h1>
            <Divider />
            <Link href="/news" className="inline-block text-charcoal hover:text-saddle transition-colors">
              ← Back to News
            </Link>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-bone text-charcoal">
      <Container>
        <article className="max-w-3xl mx-auto space-y-8">
          {/* Header */}
          <div className="space-y-4">
            <h1 className="font-serif text-4xl md:text-5xl leading-tight">
              {post.title}
            </h1>
            <div className="flex gap-4 text-sm text-saddle">
              <span>{new Date(post.published_date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}</span>
              {post.author && <span>by {post.author}</span>}
            </div>
          </div>

          <Divider />

          {/* Content — render as text with paragraph breaks. Previously
              dangerouslySetInnerHTML opened XSS via Airtable content. Audit
              finding 2026-05-20 #21. If we need rich content later, swap to
              Markdown + a vetted renderer (react-markdown). */}
          <div className="prose prose-lg max-w-none leading-relaxed space-y-6">
            {post.content.split(/\n\n+/).map((para, idx) => (
              <p key={idx} className="whitespace-pre-wrap">{para}</p>
            ))}
          </div>

          <Divider />

          <div className="flex justify-between items-center">
            <Link href="/news" className="text-charcoal hover:text-saddle transition-colors">
              ← Back to News
            </Link>
            <Link href="/" className="text-charcoal hover:text-saddle transition-colors">
              Home
            </Link>
          </div>
        </article>
      </Container>
    </main>
  );
}


