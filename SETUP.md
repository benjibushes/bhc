# BuyHalfCow — Complete Setup Guide

## Prerequisites

- Node.js 18+ installed
- npm or yarn
- Supabase account (free tier works)
- Code editor (VS Code recommended)

---

## Step 1: Clone/Install Project

```bash
# Navigate to project
cd /path/to/bhc

# Install dependencies
npm install

# or
yarn install
```

---

## Step 2: Set Up Supabase Database

### 2.1 Create Supabase Project

1. Go to https://supabase.com
2. Click "New Project"
3. Choose organization (or create one)
4. Set project name: "BuyHalfCow"
5. Set database password (save this!)
6. Choose region closest to you
7. Wait for project to provision (~2 minutes)

### 2.2 Get API Credentials

1. In Supabase dashboard, go to **Settings** → **API**
2. Copy two values:
   - **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - **anon public key** (long string starting with `eyJ...`)

### 2.3 Create Environment File

Create `.env.local` in project root:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
```

### 2.4 Run Database Schema

1. In Supabase dashboard, go to **SQL Editor**
2. Open `DATABASE_SCHEMA.md` in this project
3. Copy the entire SQL schema
4. Paste into SQL Editor
5. Click **Run**
6. Verify all tables were created successfully

### 2.5 Add Sample Data (Optional)

Copy the "Sample Data" section from `DATABASE_SCHEMA.md` and run it in SQL Editor to test with demo data.

---

## Step 3: Run Development Server

```bash
# Start Next.js dev server
npm run dev

# or
yarn dev
```

Your site should now be running at **http://localhost:3000**

---

## Step 4: Test Core Functionality

### Test Landing Page
1. Visit http://localhost:3000
2. Verify brand styling (bone white background, Playfair Display headlines)
3. Click "Get Private Access" → should go to `/access`
4. Click "Partner With BuyHalfCow" → should go to `/partner`

### Test Consumer Signup
1. Go to http://localhost:3000/access
2. Fill out form:
   - First Name: Test
   - Email: test@example.com
   - Phone: 555-0100
   - State: Texas
   - Check "Beef"
3. Click "Join Waitlist"
4. Should see confirmation screen
5. Check Supabase dashboard → **Table Editor** → `consumers`
6. Verify your test submission appears

### Test Partner Applications
1. Go to http://localhost:3000/partner
2. Select "Rancher"
3. Fill out form completely
4. Check commission agreement checkbox
5. Submit
6. Check Supabase → `ranchers` table
7. Verify submission appears with `status='pending'` and `certified=false`

Repeat for Brand and Land Seller types.

### Test Member Area (Paywall)
1. Go to http://localhost:3000/member
2. Should see "Members Only" paywall
3. No content should be visible (working as designed!)

### Test Admin Dashboard
1. Go to http://localhost:3000/admin
2. Should see dashboard with 4 tabs
3. Should show counts of consumers, ranchers, brands, land deals
4. Try changing a rancher's status from "pending" to "approved"
5. Try toggling a rancher's "certified" status
6. Changes should persist (check Supabase table)

### Test News Section
1. Go to http://localhost:3000/news
2. If you added sample data, should see "Welcome to BuyHalfCow" post
3. Click into post → should show full content

---

## Step 5: Set Up Authentication (Optional - For Production)

See `AUTH_SETUP.md` for complete authentication implementation.

**Quick Test (Without Full Auth):**

To test member area with mock data:

```sql
-- Run in Supabase SQL Editor
-- This temporarily bypasses auth for testing

-- Add a test consumer with active membership
INSERT INTO consumers (
  first_name, email, phone, state, interests, status, membership
) VALUES (
  'Test Member', 'member@test.com', '555-9999', 'TX',
  ARRAY['beef', 'land'], 'approved', 'active'
);
```

Then modify `/app/member/page.tsx` temporarily to always show `isMember: true` for testing.

---

## Step 6: Verify All Pages Work

| Page | URL | Expected Result |
|------|-----|-----------------|
| Landing | http://localhost:3000 | Loads with brand styling |
| Consumer Form | http://localhost:3000/access | Form works, saves to DB |
| Partner Form | http://localhost:3000/partner | Dynamic forms work, save to DB |
| Member Area | http://localhost:3000/member | Shows paywall (no auth yet) |
| Admin Dashboard | http://localhost:3000/admin | Shows CRM, can manage data |
| News/Blog | http://localhost:3000/news | Shows blog posts |
| Merch Link | Footer button | Links to shop.buyhalfcow.com |

---

## Step 7: Production Deployment

### Deploy to Vercel (Recommended)

1. Push code to GitHub
2. Go to https://vercel.com
3. Click "New Project"
4. Import your GitHub repository
5. Add environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
6. Click "Deploy"
7. Wait ~2 minutes
8. Your site is live!

### Connect Custom Domain

1. In Vercel dashboard, go to **Settings** → **Domains**
2. Add your domain (e.g., `buyhalfcow.com`)
3. Update DNS records as instructed
4. Wait for SSL to provision
5. Done!

---

## Common Issues & Solutions

### Issue: "supabaseUrl is required" error

**Solution:** Make sure `.env.local` exists and has correct values:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key_here
```

Restart dev server after creating/editing `.env.local`.

### Issue: Forms submit but no data in Supabase

**Solution:** Check Supabase SQL Editor for errors. Verify:
1. All tables were created successfully
2. RLS policies are correct
3. API route logs for errors (`console.log` in route files)

### Issue: Admin dashboard shows 0 records

**Solution:** 
1. Check Supabase Table Editor to see if data exists
2. Check browser console for API errors
3. Verify API routes are running (check Network tab)

### Issue: Styling looks wrong

**Solution:**
1. Clear browser cache
2. Verify `app/globals.css` has correct brand colors
3. Check `tailwind.config.ts` extends colors
4. Restart dev server

### Issue: Member area shows paywall even with sample data

**Solution:** This is correct! The paywall checks for authentication, not just data. To bypass for testing, temporarily modify the member API route to return `isMember: true`.

---

## Project Structure

```
bhc/
├── app/
│   ├── access/          # Consumer signup
│   ├── partner/         # Partner applications
│   ├── member/          # Members-only area (paywall)
│   ├── admin/           # Admin CRM dashboard
│   ├── news/            # Blog/news section
│   ├── api/             # All API routes
│   │   ├── consumers/
│   │   ├── partners/
│   │   ├── member/
│   │   ├── admin/
│   │   └── news/
│   ├── components/      # Reusable UI components
│   ├── page.tsx         # Landing page
│   ├── layout.tsx       # Root layout (fonts, metadata)
│   └── globals.css      # Brand styling
├── lib/
│   └── supabase.ts      # Supabase client
├── DATABASE_SCHEMA.md   # Complete SQL schema
├── AUTH_SETUP.md        # Authentication guide
├── SETUP.md             # This file
└── .env.local           # Environment variables (create this!)
```

---

## Next Steps

✅ **You've completed basic setup!**

**To launch your platform:**

1. ✅ Test all forms and pages locally
2. ⚠️ Implement authentication (see `AUTH_SETUP.md`)
3. ⚠️ Create admin login page
4. ⚠️ Add real content to news section
5. ⚠️ Design email templates for notifications
6. ⚠️ Set up custom domain
7. ⚠️ Deploy to production (Vercel)
8. ⚠️ Test with real users

---

## Support & Resources

- **Supabase Docs:** https://supabase.com/docs
- **Next.js Docs:** https://nextjs.org/docs
- **Tailwind CSS:** https://tailwindcss.com/docs

---

## Summary

**What works now:**
- ✅ Landing page with brand styling
- ✅ Consumer signup form → saves to database
- ✅ Partner applications (rancher/brand/land) → save to database
- ✅ Member area with paywall (no auth yet)
- ✅ State-based rancher listings (for members)
- ✅ Admin CRM dashboard (all CRUD operations)
- ✅ News/blog section
- ✅ Merch store link

**What needs auth to be fully functional:**
- ⚠️ Member login
- ⚠️ Member content access
- ⚠️ Admin login
- ⚠️ Protected routes

**Estimated completion: 95%**  
Platform is functional and ready for testing. Auth implementation adds final 5%.


