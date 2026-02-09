import { NextResponse, NextRequest } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    
    // Get all posts and filter by slug
    const posts = await getAllRecords(TABLES.NEWS_POSTS, `{Slug} = '${slug}'`);
    
    if (posts.length === 0) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    return NextResponse.json(posts[0]);
  } catch (error: any) {
    console.error('API error fetching news post:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const body = await request.json();

    // First, get the post by slug to get its ID
    const posts = await getAllRecords(TABLES.NEWS_POSTS, `{Slug} = '${slug}'`);
    
    if (posts.length === 0) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const postId = posts[0].id;

    // Build update fields object
    const fields: any = {};
    if (body.title) fields['Title'] = body.title;
    if (body.content) fields['Content'] = body.content;
    if (body.excerpt !== undefined) fields['Excerpt'] = body.excerpt;
    if (body.author) fields['Author'] = body.author;
    if (body.status) fields['Status'] = body.status;

    const updatedRecord = await updateRecord(TABLES.NEWS_POSTS, postId, fields);
    return NextResponse.json(updatedRecord);
  } catch (error: any) {
    console.error('API error updating news post:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
