# 🚀 DEPLOY NOW — Quick Commands

## Pre-Flight Check (5 min)

```bash
# 1. Make sure you're in the right directory
cd bhc

# 2. Test build locally
npm run build

# If build fails, fix errors first
# If build succeeds, continue below
```

---

## Deploy to Vercel (10 min) — RECOMMENDED

### One-Time Setup:

```bash
# Install Vercel CLI
npm install -g vercel

# Login to Vercel
vercel login
# → Opens browser, login with GitHub/Email
```

### Deploy:

```bash
# From the /bhc directory
cd bhc

# First deployment
vercel

# Answer prompts:
# ? Set up and deploy "~/BHC/untitled folder/bhc"? [Y/n] y
# ? Which scope? [Your account]
# ? Link to existing project? [y/N] n
# ? What's your project's name? bhc
# ? In which directory is your code located? ./
# ? Want to override the settings? [y/N] n

# Vercel will deploy and give you a preview URL
# Example: https://bhc-abc123.vercel.app
```

### Add Environment Variables:

1. Go to: https://vercel.com/dashboard
2. Click your project: "bhc"
3. Click "Settings" tab
4. Click "Environment Variables"
5. Add each variable from your `.env.local`:

```
AIRTABLE_API_KEY=your_key
AIRTABLE_BASE_ID=your_base_id
RESEND_API_KEY=your_key
EMAIL_FROM=BuyHalfCow <support@buyhalfcow.com>
ADMIN_EMAIL=support@buyhalfcow.com
ADMIN_PASSWORD=bhc-admin-2026
NEXT_PUBLIC_COMMISSION_RATE=0.10
NEXT_PUBLIC_CALENDLY_LINK=https://calendly.com/your-username/rancher-onboarding
CALENDLY_LINK=https://calendly.com/your-username/rancher-onboarding
```

6. For each variable:
   - Click "Add"
   - Enter Name (e.g., `AIRTABLE_API_KEY`)
   - Enter Value (paste your actual key)
   - Select: Production, Preview, Development (all)
   - Click "Save"

### Deploy to Production:

```bash
# Deploy to production (live URL)
vercel --prod

# Vercel gives you production URL
# Example: https://bhc.vercel.app
```

### Test Production:

```bash
# Open in browser
open https://bhc.vercel.app

# Or use your custom domain if configured
open https://buyhalfcow.com
```

---

## Deploy to Netlify (Alternative)

### One-Time Setup:

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login
# → Opens browser, login with GitHub/Email
```

### Deploy:

```bash
# From the /bhc directory
cd bhc

# Build first
npm run build

# Deploy to production
netlify deploy --prod

# Follow prompts:
# ? Create & configure a new site? Yes
# ? Team: [Your team]
# ? Site name (optional): bhc
# ? Publish directory: .next

# Netlify will give you a live URL
# Example: https://bhc.netlify.app
```

### Add Environment Variables:

1. Go to: https://app.netlify.com
2. Click your site: "bhc"
3. Click "Site settings"
4. Click "Environment variables"
5. Click "Add a variable"
6. Add each variable from your `.env.local` (same as Vercel above)

### Redeploy:

```bash
# After adding env vars, redeploy
netlify deploy --prod
```

---

## Custom Domain Setup (Optional)

### If you want `buyhalfcow.com` instead of `bhc.vercel.app`:

**Vercel:**
1. Go to project settings → Domains
2. Click "Add Domain"
3. Enter: `buyhalfcow.com`
4. Follow DNS instructions (add A record or CNAME)
5. Wait 5-10 min for SSL certificate
6. Test: `https://buyhalfcow.com`

**Netlify:**
1. Go to site settings → Domain management
2. Click "Add custom domain"
3. Enter: `buyhalfcow.com`
4. Follow DNS instructions
5. Wait 5-10 min for SSL certificate
6. Test: `https://buyhalfcow.com`

**Can do this later if needed.**

---

## Post-Deployment Test (5 min)

Visit your production URL and test:

```bash
# Replace with your actual production URL
PROD_URL="https://bhc.vercel.app"

# Test these pages:
# 1. Homepage
open $PROD_URL

# 2. Consumer application
open $PROD_URL/access

# 3. Rancher application
open $PROD_URL/partner

# 4. FAQ
open $PROD_URL/faq

# 5. Admin login
open $PROD_URL/admin/login
```

**Manual Tests:**
- [ ] Homepage loads
- [ ] Submit consumer application → check email arrives
- [ ] Submit rancher application → check Calendly link works → check email arrives
- [ ] Login to admin → check dashboard loads
- [ ] Check `/admin/inquiries` page loads

**If anything fails:**
- Check Vercel/Netlify deployment logs
- Verify all environment variables are set correctly
- Check browser console for errors

---

## Rollback (If Something Breaks)

**Vercel:**
```bash
# List deployments
vercel list

# Rollback to previous deployment
vercel rollback [deployment-url]
```

**Netlify:**
1. Go to Netlify dashboard
2. Click "Deploys" tab
3. Find previous working deployment
4. Click "..." → "Publish deploy"

---

## Monitoring Production

**Check Deployment Logs:**

Vercel:
```bash
vercel logs [deployment-url]
```

Netlify:
- Dashboard → Deploys → Click deploy → View logs

**Check Function Logs (API Routes):**
- Vercel: Dashboard → Functions → Select function → View logs
- Netlify: Dashboard → Functions → Select function → View logs

---

## Update Production After Changes

**Vercel:**
```bash
# Make code changes
# Commit changes (optional but recommended)
git add .
git commit -m "Update copy"

# Deploy to production
vercel --prod

# Done! Vercel auto-builds and deploys
```

**Netlify:**
```bash
# Make code changes
# Build
npm run build

# Deploy
netlify deploy --prod
```

---

## Quick Troubleshooting

**Issue: Build fails**
```bash
# Test build locally first
npm run build

# If it fails locally, fix errors
# If it succeeds locally but fails on Vercel/Netlify:
# - Check Node.js version (Vercel/Netlify settings)
# - Check build logs for specific error
```

**Issue: "Internal Server Error" on production**
- Check environment variables are set correctly
- Check API route logs for errors
- Verify Airtable/Resend API keys work

**Issue: Emails not sending**
- Check `RESEND_API_KEY` is set in production
- Check `EMAIL_FROM` domain is verified in Resend
- Check Resend dashboard for errors

**Issue: Admin login not working**
- Check `ADMIN_PASSWORD` is set in production env vars
- Try clearing cookies
- Check browser console for errors

---

## You're Live! 🎉

Once deployed and tested:
- ✅ Share production URL with 20K people
- ✅ Monitor `/admin` for incoming applications
- ✅ Respond to inquiries within 24 hours
- ✅ Track everything in Airtable

**Production URL:** `https://bhc.vercel.app` (or your custom domain)

**Let's gooooo! 🚀🤠**
