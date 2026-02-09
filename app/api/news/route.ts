import { NextResponse } from 'next/server';
import { getAllRecords, createRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const news = await getAllRecords(TABLES.NEWS_POSTS, "{Status} = 'Published'");
    return NextResponse.json(news);
  } catch (error: any) {
    console.error('API error fetching news:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, slug, content, excerpt, author } = body;

    if (!title || !slug || !content) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const record = await createRecord(TABLES.NEWS_POSTS, {
      'Title': title,
      'Slug': slug,
      'Content': content,
      'Excerpt': excerpt || '',
      'Author': author || 'BuyHalfCow Team',
      'Status': 'Draft',
    });

    return NextResponse.json({ success: true, post: record }, { status: 201 });
  } catch (error: any) {
    console.error('API error creating news post:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
