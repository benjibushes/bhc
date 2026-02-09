import { NextResponse } from 'next/server';

// Placeholder auth check route
// This will be implemented when you add authentication
export async function GET(request: Request) {
  try {
    // TODO: Implement actual authentication check
    // For now, return not authenticated
    return NextResponse.json({ authenticated: false }, { status: 401 });
  } catch (error: any) {
    console.error('API error checking auth:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
