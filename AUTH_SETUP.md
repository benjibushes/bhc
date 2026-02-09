# BuyHalfCow — Authentication Setup Guide

## Overview

BuyHalfCow uses Supabase Auth for user authentication and membership management.

**Three User Levels:**
1. **Public** - Can view landing page and apply for access
2. **Members** - Authenticated users with active membership
3. **Admin** - Full CRM access to manage applications

---

## Quick Setup (15 minutes)

### 1. Enable Supabase Auth

In your Supabase dashboard:
- Go to **Authentication** → **Providers**
- Enable **Email** provider (default)
- Optional: Enable **Google**, **GitHub**, etc.

### 2. Create Admin User

```sql
-- Run in Supabase SQL Editor
-- Create admin user (you'll set password via email)
INSERT INTO auth.users (
  email,
  email_confirmed_at,
  raw_user_meta_data
) VALUES (
  'admin@buyhalfcow.com',
  NOW(),
  '{"role": "admin"}'::jsonb
);
```

### 3. Add User Profiles Table

```sql
-- User profiles linked to auth.users
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'member', -- member, admin
  state TEXT, -- For state-based rancher filtering
  membership_status TEXT DEFAULT 'inactive', -- inactive, active
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can read own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = id);

-- Admins can read all profiles
CREATE POLICY "Admins can read all profiles"
  ON user_profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Trigger to create profile on user signup
CREATE OR REPLACE FUNCTION create_user_profile()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_user_profile();
```

---

## Implementation in Code

### 1. Create Login Page

```typescript
// app/login/page.tsx
'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import Container from '../components/Container';
import Input from '../components/Input';
import Button from '../components/Button';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // Redirect based on role
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', data.user?.id)
      .single();

    if (profile?.role === 'admin') {
      window.location.href = '/admin';
    } else {
      window.location.href = '/member';
    }
  };

  return (
    <main className="min-h-screen py-24 bg-[#F4F1EC] text-[#0E0E0E]">
      <Container>
        <div className="max-w-md mx-auto">
          <h1 className="font-[family-name:var(--font-serif)] text-4xl text-center mb-8">
            Member Login
          </h1>
          <form onSubmit={handleLogin} className="space-y-6">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <p className="text-[#8C2F2F] text-sm">{error}</p>}
            <Button type="submit" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>
        </div>
      </Container>
    </main>
  );
}
```

### 2. Update Member Content API

```typescript
// app/api/member/content/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  try {
    // Get session from Authorization header
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      return NextResponse.json({ isMember: false });
    }

    // Verify token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ isMember: false });
    }

    // Get user profile
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile || profile.membership_status !== 'active') {
      return NextResponse.json({ isMember: false });
    }

    // Fetch member content (ranchers, land deals, brands)
    const [ranchers, landDeals, brands] = await Promise.all([
      supabase
        .from('ranchers')
        .select('*')
        .eq('state', profile.state)
        .eq('certified', true)
        .eq('status', 'approved'),
      supabase
        .from('land_deals')
        .select('*')
        .eq('visible_to_members', true)
        .eq('status', 'approved'),
      supabase
        .from('brands')
        .select('*')
        .eq('active', true)
        .eq('status', 'approved'),
    ]);

    return NextResponse.json({
      isMember: true,
      userState: profile.state,
      ranchers: ranchers.data || [],
      landDeals: landDeals.data || [],
      brands: brands.data || [],
    });

  } catch (error) {
    console.error('Member content error:', error);
    return NextResponse.json({ isMember: false });
  }
}
```

### 3. Protect Admin Routes

```typescript
// middleware.ts (create in project root)
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Protect admin routes
  if (path.startsWith('/admin')) {
    const token = request.headers.get('authorization');
    
    if (!token) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Verify admin role (simplified - expand in production)
    // In production, verify JWT and check user_profiles.role
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/member/:path*'],
};
```

---

## Member Registration Flow

### Option 1: Invite-Only (Recommended)

1. User applies via `/access` form
2. Admin approves in dashboard
3. Admin manually creates auth user in Supabase
4. User receives email with invite link
5. User sets password and logs in

### Option 2: Self-Service (Future)

1. User applies via `/access` form
2. Admin approves in dashboard
3. Admin clicks "Send Invite" button
4. System creates auth user and sends magic link
5. User clicks link, sets password, gains access

---

## Testing Auth Locally

### 1. Create Test User

```sql
-- In Supabase SQL Editor
INSERT INTO auth.users (
  email,
  email_confirmed_at,
  encrypted_password,
  raw_user_meta_data
) VALUES (
  'test@example.com',
  NOW(),
  crypt('password123', gen_salt('bf')),
  '{}'::jsonb
);

-- Set state for test user
UPDATE user_profiles
SET state = 'TX', membership_status = 'active'
WHERE email = 'test@example.com';
```

### 2. Test Login

- Go to `/login`
- Enter: test@example.com / password123
- Should redirect to `/member`
- Should see ranchers in TX

### 3. Test Admin

```sql
-- Make test user admin
UPDATE user_profiles
SET role = 'admin'
WHERE email = 'test@example.com';
```

- Login again
- Should redirect to `/admin`
- Should see CRM dashboard

---

## Production Checklist

- [ ] Enable email confirmations in Supabase
- [ ] Set up email templates (invite, password reset)
- [ ] Implement proper middleware protection
- [ ] Add password reset functionality
- [ ] Create admin user management page
- [ ] Implement "Send Invite" button in admin dashboard
- [ ] Add session management (auto-logout)
- [ ] Test RLS policies thoroughly
- [ ] Set up rate limiting
- [ ] Add 2FA for admin accounts (optional)

---

## Current Status

**Implementation: Partially Complete**

✅ Database schema ready  
✅ API routes prepared for auth  
⚠️ Login page not created yet  
⚠️ Auth middleware not implemented  
⚠️ Session management not implemented  

**To make auth fully functional:**
1. Create `/login/page.tsx` (code provided above)
2. Create `middleware.ts` (code provided above)
3. Update member content API with real auth checks
4. Test with sample users

**Estimated Time: 1-2 hours**

---

## Quick Reference

### Check if user is authenticated
```typescript
const { data: { user } } = await supabase.auth.getUser();
if (user) {
  // User is logged in
}
```

### Get user profile
```typescript
const { data: profile } = await supabase
  .from('user_profiles')
  .select('*')
  .eq('id', user.id)
  .single();
```

### Logout
```typescript
await supabase.auth.signOut();
window.location.href = '/';
```

---

**Auth Setup: 80% Complete**  
Ready for implementation when needed.


