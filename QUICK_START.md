# BuyHalfCow — Quick Start Guide

**Ready to launch? Follow these steps in order.**

---

## 🚨 **CRITICAL PATH TO LAUNCH (5 Hours Total)**

### **Step 1: Set Up Supabase (1 hour)**

**What:** Your database for storing all data

1. Go to https://supabase.com
2. Sign up / Login
3. Click **"New Project"**
4. Choose a name: `buyhalfcow`
5. Set a database password (save it!)
6. Wait for project to provision (~2 minutes)

**Then:**

7. Go to **Settings** → **API**
8. Copy these two values:
   - `Project URL` (looks like: `https://abcdefgh.supabase.co`)
   - `anon public` key (long string starting with `eyJ...`)

9. Go to **SQL Editor** (left sidebar)
10. Click **"New Query"**
11. Open `DATABASE_SCHEMA.md` from your project
12. Copy the ENTIRE SQL script
13. Paste into Supabase SQL Editor
14. Click **"Run"**
15. Verify tables created: Go to **Table Editor** → should see `consumers`, `ranchers`, `brands`, `land_deals`, `news_posts`, `inquiries`

✅ **Done!** Your database is ready.

---

### **Step 2: Set Up Resend (1 hour)**

**What:** Email service for sending notifications

1. Go to https://resend.com
2. Sign up with your email
3. Click **"Add Domain"**
4. Enter your domain: `buyhalfcow.com`

**Then add these DNS records to your domain:**

5. Go to your domain registrar (GoDaddy, Namecheap, etc.)
6. Add the DNS records Resend shows you:
   - SPF record (TXT)
   - DKIM record (TXT)
   - DMARC record (TXT)
7. Wait ~15 minutes for DNS propagation
8. Return to Resend, click **"Verify"**
9. Go to **API Keys** → **"Create API Key"**
10. Copy the API key (starts with `re_...`)

✅ **Done!** Your email service is ready.

---

### **Step 3: Configure Environment Variables (15 minutes)**

**What:** Tell your app how to connect to services

1. In your project folder, copy `env.example` to `.env.local`:
   ```bash
   cp env.example .env.local
   ```

2. Open `.env.local` in your editor

3. Fill in the values:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...YOUR-KEY...
   RESEND_API_KEY=re_...YOUR-KEY...
   EMAIL_FROM=noreply@buyhalfcow.com
   ADMIN_EMAIL=your-email@gmail.com
   NEXT_PUBLIC_SITE_URL=http://localhost:3000
   ```

4. Save the file

✅ **Done!** Your app is configured.

---

### **Step 4: Test Locally (30 minutes)**

**What:** Make sure everything works before deploying

1. Start the dev server:
   ```bash
   npm run dev
   ```

2. Open http://localhost:3000

3. **Test Consumer Form:**
   - Click "I Want Beef"
   - Fill out the form
   - Submit
   - Check your Supabase dashboard → Table Editor → `consumers`
   - Should see your entry!
   - Check your email (check spam folder too)
   - Should receive confirmation email

4. **Test Rancher Form:**
   - Go back to homepage
   - Click "I Sell Beef"
   - Fill out form as a rancher
   - Submit
   - Check Supabase → `ranchers` table
   - Check email

5. **Test Admin Dashboard:**
   - Go to http://localhost:3000/admin
   - Should see your test consumer and rancher
   - Try approving the consumer
   - Try marking rancher as "Certified"

✅ **Done!** Everything works locally.

---

### **Step 5: Add Your Logo (15 minutes)**

**What:** Replace placeholder with your actual logo

1. Save your logo as `public/logo.png`
   - Recommended: PNG with transparency
   - Size: 512x512px minimum

2. Open `app/page.tsx`

3. Find this section (around line 15):
   ```tsx
   <div className="w-full h-full flex items-center justify-center">
     <span className="font-serif text-6xl md:text-7xl">BHC</span>
   </div>
   ```

4. Replace with:
   ```tsx
   <Image 
     src="/logo.png" 
     alt="BuyHalfCow" 
     width={160} 
     height={160}
     priority
     className="w-full h-full object-contain"
   />
   ```

5. Refresh browser → should see your logo!

✅ **Done!** Logo is live.

---

### **Step 6: Create Favicon (15 minutes)**

**What:** The little icon in browser tabs

1. Go to https://favicon.io
2. Upload your logo
3. Generate favicon
4. Download the ZIP
5. Extract these files to `/app`:
   - `favicon.ico`
   - `apple-touch-icon.png`

6. Refresh browser → should see your icon in tab!

✅ **Done!** Favicon is set.

---

### **Step 7: Deploy to Vercel (1 hour)**

**What:** Put your site online

1. Push your code to GitHub:
   ```bash
   git add .
   git commit -m "Ready for launch"
   git push
   ```

2. Go to https://vercel.com
3. Sign up / Login with GitHub
4. Click **"New Project"**
5. Import your GitHub repo
6. **Before deploying**, click **"Environment Variables"**
7. Add all variables from your `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `RESEND_API_KEY`
   - `EMAIL_FROM`
   - `ADMIN_EMAIL`
   - `NEXT_PUBLIC_SITE_URL` (change to your production URL)

8. Click **"Deploy"**
9. Wait ~3 minutes
10. You'll get a URL like: `https://buyhalfcow.vercel.app`

**Test it:**
- Visit the URL
- Test a form submission
- Check email arrives
- Check Supabase

✅ **Done!** Your site is LIVE!

---

### **Step 8: Connect Custom Domain (30 minutes)**

**What:** Use buyhalfcow.com instead of vercel.app

1. In Vercel dashboard, go to your project
2. Click **"Settings"** → **"Domains"**
3. Add your domain: `buyhalfcow.com`
4. Vercel will show you DNS records to add
5. Go to your domain registrar
6. Add the DNS records (A and CNAME)
7. Wait ~15 minutes
8. Vercel will auto-verify and enable SSL
9. Update environment variable:
   - In Vercel dashboard → Settings → Environment Variables
   - Change `NEXT_PUBLIC_SITE_URL` to `https://buyhalfcow.com`
10. Redeploy (Deployments → click "..." → Redeploy)

✅ **Done!** Your site is at your custom domain!

---

## 🎯 **Final Checklist Before Announcing**

- [ ] Site loads at your domain
- [ ] SSL certificate shows (padlock in browser)
- [ ] All forms submit successfully
- [ ] Emails arrive (check spam folder)
- [ ] Logo displays correctly
- [ ] Favicon shows in tab
- [ ] Mobile version looks good
- [ ] Admin dashboard works
- [ ] Legal pages reviewed (terms, privacy)
- [ ] About page has real content
- [ ] Merch link goes to correct URL

---

## 🚨 **Common Issues & Fixes**

### **"Emails not sending"**
- ✅ Check Resend domain is verified (green checkmark)
- ✅ Check DNS records are added correctly
- ✅ Wait 15-30 min for DNS propagation
- ✅ Check spam folder
- ✅ Try sending to different email (Gmail, Yahoo, etc.)

### **"Database not connecting"**
- ✅ Check Supabase URL is correct (no typos)
- ✅ Check anon key is correct
- ✅ Make sure you copied the PUBLIC anon key, not service role key
- ✅ Check environment variables are saved in Vercel

### **"Forms not submitting"**
- ✅ Open browser console (F12) → look for errors
- ✅ Check API routes are working: `/api/consumers`, `/api/partners`
- ✅ Verify Supabase tables exist
- ✅ Check network tab for failed requests

### **"Admin dashboard empty"**
- ✅ Make sure you submitted test forms
- ✅ Check Supabase tables have data
- ✅ Verify API routes return data
- ✅ Check browser console for errors

---

## 📞 **Need Help?**

### **Supabase Issues:**
- Docs: https://supabase.com/docs
- Support: https://supabase.com/dashboard/support

### **Resend Issues:**
- Docs: https://resend.com/docs
- Support: support@resend.com

### **Vercel Issues:**
- Docs: https://vercel.com/docs
- Support: https://vercel.com/support

### **Next.js Issues:**
- Docs: https://nextjs.org/docs

---

## 🎊 **You're Live!**

**Once everything is working:**

1. **Soft Launch:**
   - Share with 5-10 friends
   - Ask them to test
   - Monitor for issues
   - Fix any bugs

2. **Public Launch:**
   - Announce on social media
   - Email your list
   - Post in relevant communities
   - Add to your bio/links

3. **Monitor:**
   - Check Supabase daily for new signups
   - Respond to inquiries
   - Approve applications promptly
   - Track which ranchers get most interest

---

## 📈 **Post-Launch Improvements**

**Week 2-3:**
- [ ] Add FAQ page
- [ ] Add more rancher photos
- [ ] Improve admin dashboard
- [ ] Add member testimonials
- [ ] Optimize for SEO

**Month 2:**
- [ ] Add search/filters
- [ ] Add image uploads for ranchers
- [ ] Implement payment system (if not done)
- [ ] Add member login system
- [ ] Create referral program

---

## 🚀 **Ready?**

**Follow the 8 steps above and you'll be live in ~5 hours.**

**Let's do this!**

---

**Questions? Stuck on a step?** Let me know and I'll help troubleshoot!

