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
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="text-center">
            <p className="text-lg text-[#6B4F3F]">Loading...</p>
          </div>
        </Container>
      </main>
    );
  }

  if (error || !post) {
    return (
      <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
        <Container>
          <div className="max-w-3xl mx-auto text-center space-y-8">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl">
              Post Not Found
            </h1>
            <Divider />
            <Link href="/news" className="inline-block text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              ← Back to News
            </Link>
          </div>
        </Container>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <article className="max-w-3xl mx-auto space-y-8">
          {/* Header */}
          <div className="space-y-4">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl leading-tight">
              {post.title}
            </h1>
            <div className="flex gap-4 text-sm text-[#6B4F3F]">
              <span>{new Date(post.published_date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}</span>
              {post.author && <span>by {post.author}</span>}
            </div>
          </div>

          <Divider />

          {/* Content */}
          <div 
            className="prose prose-lg max-w-none leading-relaxed space-y-6"
            dangerouslySetInnerHTML={{ __html: post.content }}
          />

          <Divider />

          <div className="flex justify-between items-center">
            <Link href="/news" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              ← Back to News
            </Link>
            <Link href="/" className="text-[#0E0E0E] hover:text-[#6B4F3F] transition-colors">
              Home
            </Link>
          </div>
        </article>
      </Container>
    </main>
  );
}


