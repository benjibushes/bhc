# Airtable Quick Setup (5 Minutes!)

**The FASTEST way to set up your BuyHalfCow database.**

---

## 🚀 **Setup Time: 5 Minutes Total**

Instead of manually creating each field, you'll **import CSV templates** that auto-configure everything!

---

## 📋 **Step-by-Step Guide**

### **Step 1: Create Airtable Account (1 minute)**

1. Go to https://airtable.com
2. Click **"Sign up"**
3. Use your email or Google account
4. **Skip any tutorials** (just close them)

---

### **Step 2: Create Your Base (30 seconds)**

1. Click **"+ Create a base"** or **"Start from scratch"**
2. Name it: **BHC CRM**
3. Choose an icon (🐄 if available, or any icon)
4. Delete the default "Table 1" (click three dots → Delete table)

---

### **Step 3: Import CSV Files (3 minutes)**

You'll import 6 CSV files. For each one:

**Repeat this process 6 times:**

1. Click **"+ Add or import"** → **"CSV file"**
2. Click **"Choose CSV file"**
3. Select the CSV from `/airtable-templates/` folder:
   - `consumers.csv`
   - `ranchers.csv`
   - `brands.csv`
   - `land-deals.csv`
   - `inquiries.csv`
   - `news.csv`
4. **Important:** Check **"First row contains field names"**
5. Click **"Import"**
6. Wait for import to complete (~5 seconds)
7. **Rename the table** (click table name at top):
   - `consumers.csv` → `Consumers`
   - `ranchers.csv` → `Ranchers`
   - `brands.csv` → `Brands`
   - `land-deals.csv` → `Land Deals` (with space!)
   - `inquiries.csv` → `Inquiries`
   - `news.csv` → `News`

**After importing, you should have 6 tables!**

---

### **Step 4: Fix Field Types (Optional but Recommended)**

Airtable auto-detects most field types, but you may want to adjust:

**For each table, click field name → Customize field type:**

#### **Consumers Table:**
- `Interests` → Change to **"Multiple select"**
- `Status` → Change to **"Single select"**
- `Created` → Should auto-detect as **"Created time"**

#### **Ranchers Table:**
- `Monthly Capacity` → Should be **"Number"**
- `Certified` → Should be **"Checkbox"**
- `Status` → Change to **"Single select"**

#### **Brands Table:**
- `Website` → Change to **"URL"**
- `Featured` → Should be **"Checkbox"**
- `Status` → Change to **"Single select"**

#### **Land Deals Table:**
- `Acreage` → Should be **"Number"**
- `Price` → Change to **"Currency"** (USD)
- `Property Type` → Change to **"Single select"**
- `Status` → Change to **"Single select"**

#### **Inquiries Table:**
- `Sale Amount` → Change to **"Currency"** (USD)
- `Commission Amount` → Change to **"Currency"** (USD)
- `Commission Paid` → Should be **"Checkbox"**
- `Status` → Change to **"Single select"**
- `Interest Type` → Change to **"Single select"**

#### **News Table:**
- `Status` → Change to **"Single select"**
- `Published Date` → Should be **"Date"** with time

**This step takes 2-3 extra minutes but makes your database much better!**

---

### **Step 5: Delete Sample Data (30 seconds)**

Each table has one sample row. Delete them:

1. Click the checkbox next to each sample row
2. Press **Delete** key
3. Confirm deletion

**Your tables are now ready for real data!**

---

### **Step 6: Get API Credentials (1 minute)**

#### **Get API Key:**

1. Click your **account icon** (top right)
2. Click **"Account"**
3. Scroll to **"API"** section
4. Click **"Generate personal access token"**
5. Name it: `BuyHalfCow API`
6. Select scopes:
   - ✅ `data.records:read`
   - ✅ `data.records:write`
7. Click **"Create token"**
8. **Copy the token** (starts with `pat...`)
   - ⚠️ Save this! You can't see it again!

#### **Get Base ID:**

1. Go back to your `BHC CRM` base
2. Click **"Help"** (top right, question mark icon)
3. Click **"API documentation"**
4. Look for: **"The ID of this base is appXXXXXXXXXX"**
5. **Copy that ID** (starts with `app...`)

---

### **Step 7: Create .env.local**

In your project root, create `.env.local`:

```bash
# Airtable
AIRTABLE_API_KEY=patABC123YourKeyHere
AIRTABLE_BASE_ID=appXYZ789YourBaseId

# Email (get from Resend)
RESEND_API_KEY=re_your_api_key_here
EMAIL_FROM=noreply@buyhalfcow.com
ADMIN_EMAIL=your@email.com

# Site
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

---

### **Step 8: Test It! (1 minute)**

```bash
npm run dev
```

1. Go to http://localhost:3000
2. Click **"I Want Beef"**
3. Fill out the form
4. Submit
5. Check your Airtable → **Consumers** table
6. **You should see your entry!** 🎉

---

## ✅ **Done!**

**Total time: ~5 minutes**

Your database is ready with:
- ✅ 6 tables configured
- ✅ All fields set up
- ✅ API credentials ready
- ✅ Connected to your app

---

## 🎨 **Bonus: Customize Your Views**

Now that your base is set up, make it even better:

### **Consumers Table:**
- Create a view: **"Pending Approvals"**
  - Filter: `Status = Pending`
  - Sort: `Created` (newest first)

### **Ranchers Table:**
- Create a view: **"Certified Ranchers"**
  - Filter: `Certified = TRUE`
  - Sort: `State` A→Z

### **Inquiries Table:**
- Create a view: **"Unpaid Commissions"**
  - Filter: `Status = Sale Completed` AND `Commission Paid = FALSE`
  - Sort: `Sale Amount` (highest first)

**To create a view:**
1. Click **"Grid view"** at top left
2. Click **"+ Create..."**
3. Choose **"Grid"** (or Kanban, Calendar, etc.)
4. Name it
5. Add filters/sorts

---

## 🎯 **What's Different from Manual Setup?**

| Manual Setup (15 min) | CSV Import (5 min) |
|----------------------|-------------------|
| Create each field by hand | Auto-imported |
| Set field types manually | Auto-detected |
| Risk of typos | Exact field names |
| Boring! | Fast! |

**You just saved 10 minutes!** ⚡

---

## 🆘 **Troubleshooting**

### **"Import failed"**
- Make sure you selected **"First row contains field names"**
- Try importing one CSV at a time
- Check CSV files aren't corrupted (open in text editor)

### **"Field types are wrong"**
- No problem! Click field name → **"Customize field type"**
- Change to the correct type
- Airtable will auto-convert data

### **"Table names don't match what your app expects"**
- Make sure you renamed tables EXACTLY:
  - `Consumers` (not "consumers" or "Consumers Table")
  - `Land Deals` (with a space!)
  - `Ranchers`
  - `Brands`
  - `Inquiries`
  - `News`

### **"Can't find CSV files"**
- They're in `/airtable-templates/` folder in your project
- You can also create them manually from the guide in `AIRTABLE_SETUP.md`

---

## 📚 **Next Steps**

Now that Airtable is set up:

1. ✅ **Set up Resend** (email service) — See `QUICK_START.md`
2. ✅ **Test all forms** locally
3. ✅ **Deploy to Vercel**

---

## 🎊 **You're Ready to Launch!**

**5 minutes and you have:**
- Professional database
- Visual admin interface
- API-ready backend
- No code required

**Way better than spending 2 hours on SQL!** 🚀

---

**Questions?** Let me know and I'll help!




