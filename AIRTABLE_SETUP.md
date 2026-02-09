# Airtable Setup Guide for BuyHalfCow

**This is your visual, no-code database!**

Setup time: **15 minutes**

---

## 🚀 **Step 1: Create Airtable Account (2 minutes)**

1. Go to https://airtable.com
2. Click **"Sign Up"**
3. Use your email or Google account
4. Free plan is perfect for launch!

---

## 📊 **Step 2: Create Your Base (2 minutes)**

1. Click **"+ Create a workspace"** (if needed)
   - Name it: `BuyHalfCow`

2. Inside workspace, click **"+ Create a base"**
   - Choose **"Start from scratch"**
   - Name it: `BHC CRM`
   - Choose an icon (🐄 or 🥩 if available!)

---

## 📋 **Step 3: Create Tables (10 minutes)**

You'll create 6 tables. For each one, click **"+ Add or import"** → **"Create empty table"**

---

### **TABLE 1: Consumers**

**Table Name:** `Consumers`

**Fields to create** (click **"+"** to add field):

| Field Name | Type | Options |
|------------|------|---------|
| Full Name | Single line text | - |
| Email | Email | - |
| Phone | Phone number | - |
| State | Single select | Add options: All 50 US states |
| Interests | Multiple select | Options: `Beef`, `Land`, `Merch`, `All` |
| Status | Single select | Options: `Pending`, `Approved`, `Rejected` |
| Created | Created time | (auto) |

**Default view:** Grid view is perfect

---

### **TABLE 2: Ranchers**

**Table Name:** `Ranchers`

**Fields:**

| Field Name | Type | Options |
|------------|------|---------|
| Ranch Name | Single line text | - |
| Operator Name | Single line text | - |
| Email | Email | - |
| Phone | Phone number | - |
| State | Single select | Add options: All 50 US states |
| Beef Types | Long text | - |
| Monthly Capacity | Number | Integer, no decimals |
| Certifications | Long text | - |
| Operation Details | Long text | - |
| Certified | Checkbox | - |
| Status | Single select | Options: `Pending`, `Approved`, `Rejected` |
| Created | Created time | (auto) |

---

### **TABLE 3: Brands**

**Table Name:** `Brands`

**Fields:**

| Field Name | Type | Options |
|------------|------|---------|
| Brand Name | Single line text | - |
| Contact Name | Single line text | - |
| Email | Email | - |
| Phone | Phone number | - |
| Website | URL | - |
| Product Category | Single line text | - |
| Proposed Discount | Single line text | - |
| Partnership Goals | Long text | - |
| Featured | Checkbox | - |
| Status | Single select | Options: `Pending`, `Approved`, `Rejected` |
| Created | Created time | (auto) |

---

### **TABLE 4: Land Deals**

**Table Name:** `Land Deals`

**Fields:**

| Field Name | Type | Options |
|------------|------|---------|
| Seller Name | Single line text | - |
| Email | Email | - |
| Phone | Phone number | - |
| Property Type | Single select | Options: `Ranch`, `Hunting`, `Farm`, `Acreage`, `Other` |
| Acreage | Number | Integer, no decimals |
| State | Single select | Add options: All 50 US states |
| County | Single line text | - |
| Price | Currency | USD, no decimals |
| Description | Long text | - |
| Status | Single select | Options: `Pending`, `Approved`, `Sold`, `Rejected` |
| Created | Created time | (auto) |

---

### **TABLE 5: Inquiries**

**Table Name:** `Inquiries`

**Fields:**

| Field Name | Type | Options |
|------------|------|---------|
| Consumer ID | Single line text | - |
| Rancher ID | Single line text | - |
| Consumer Name | Single line text | - |
| Consumer Email | Email | - |
| Consumer Phone | Phone number | - |
| Rancher Email | Email | - |
| Ranch Name | Single line text | - |
| Message | Long text | - |
| Interest Type | Single select | Options: `Half Cow`, `Quarter Cow`, `Whole Cow`, `Other` |
| Status | Single select | Options: `Sent`, `Replied`, `Sale Completed`, `No Sale`, `Archived` |
| Sale Amount | Currency | USD, 2 decimals |
| Commission Amount | Currency | USD, 2 decimals |
| Commission Paid | Checkbox | - |
| Notes | Long text | - |
| Created | Created time | (auto) |

---

### **TABLE 6: News**

**Table Name:** `News`

**Fields:**

| Field Name | Type | Options |
|------------|------|---------|
| Title | Single line text | - |
| Slug | Single line text | - |
| Content | Long text | - |
| Excerpt | Long text | - |
| Author | Single line text | Default: `BuyHalfCow Team` |
| Status | Single select | Options: `Draft`, `Published`, `Archived` |
| Published Date | Date | Include time |
| Created | Created time | (auto) |

---

## 🔑 **Step 4: Get Your API Credentials (2 minutes)**

### **Get API Key:**

1. Click your **account icon** (top right)
2. Click **"Account"**
3. Scroll to **"API"** section
4. Click **"Generate personal access token"**
5. Give it a name: `BuyHalfCow API`
6. Select scopes:
   - ✅ `data.records:read`
   - ✅ `data.records:write`
7. Click **"Create token"**
8. **Copy the token** (starts with `pat...`)
   - Save this as `AIRTABLE_API_KEY` in your `.env.local`

### **Get Base ID:**

1. Go back to your `BHC CRM` base
2. Click **"Help"** (top right, question mark icon)
3. Click **"API documentation"**
4. In the API docs, look for: **"The ID of this base is appXXXXXXXXXX"**
5. **Copy that ID** (starts with `app...`)
   - Save this as `AIRTABLE_BASE_ID` in your `.env.local`

---

## ✅ **Step 5: Verify Setup**

Your base should now have:

- ✅ 6 tables created
- ✅ All fields configured correctly
- ✅ API key generated
- ✅ Base ID copied

---

## 🎨 **Optional: Customize Your Views**

Airtable is super flexible! You can:

### **For Consumers table:**
- Create a view filtered by `Status = Pending` (your approval queue)
- Create a view filtered by `Status = Approved` (active members)

### **For Ranchers table:**
- Create a view filtered by `Certified = TRUE` (your certified ranchers)
- Create a Kanban view grouped by `Status`

### **For Inquiries table:**
- Create a view filtered by `Status = Sent` (new inquiries)
- Create a view filtered by `Commission Paid = FALSE` and `Status = Sale Completed` (unpaid commissions)

---

## 📊 **Using Airtable as Your Admin Dashboard**

You now have TWO admin interfaces:

### **1. Your Web Admin** (`/admin` page)
- Clean, branded interface
- Specific to BuyHalfCow
- Members won't see this

### **2. Airtable Interface** (airtable.com)
- More powerful
- More views and filters
- Export to CSV
- Add comments and attachments
- Share with team members
- **Use this for daily management!**

**Pro tip:** You can mostly just use Airtable directly and skip your `/admin` page for now!

---

## 🔗 **Connect to Your App**

Create `.env.local` in your project root:

```bash
AIRTABLE_API_KEY=patABC123YourKeyHere
AIRTABLE_BASE_ID=appXYZ789YourBaseId
RESEND_API_KEY=re_your_api_key_here
EMAIL_FROM=noreply@buyhalfcow.com
ADMIN_EMAIL=your@email.com
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Then test:

```bash
npm run dev
```

Go to http://localhost:3000 and try submitting the consumer form!

---

## 🎯 **Testing Your Setup**

1. **Submit a test form** at `/access`
2. **Check Airtable** → Go to your `Consumers` table
3. **You should see your entry!** ✅

If it works, you're done! 🎉

---

## 💰 **Pricing**

### **Free Tier (what you start with):**
- 1,200 records per base
- Unlimited bases
- 2GB attachments per base
- API access
- **Perfect for launch!**

You won't need paid until you have:
- 1,200+ consumers OR
- 1,200+ ranchers/brands/deals combined

(You'll know when you need it — Airtable will tell you!)

---

## 🆘 **Troubleshooting**

### **"API Key invalid"**
- Make sure you copied the FULL key (starts with `pat...`)
- Check for extra spaces
- Regenerate key if needed

### **"Base not found"**
- Make sure Base ID starts with `app...`
- Go to API docs to double-check ID
- Make sure you selected the right base

### **"Table not found"**
- Check table names match EXACTLY (case-sensitive!)
- `Consumers` not `consumers`
- `Land Deals` with a space, not `LandDeals`

### **"Field not found"**
- Check field names match exactly
- `Full Name` not `FullName`
- Spaces matter!

---

## 📚 **Helpful Airtable Resources**

- **API Docs:** https://airtable.com/api (specific to your base!)
- **Field Types:** https://support.airtable.com/docs/supported-field-types-overview
- **Getting Started:** https://support.airtable.com/docs/getting-started

---

## 🎊 **You're Done!**

**Total setup time: ~15 minutes**

**What you get:**
- ✅ Visual database (no SQL!)
- ✅ Built-in admin interface
- ✅ Easy to manage
- ✅ API ready
- ✅ Can share with non-technical people

**vs. Supabase setup time: ~2 hours with SQL knowledge required**

**You made the right choice!** 🚀

---

## 🔄 **Need to Migrate Later?**

If you ever outgrow Airtable, you can:
1. Export all data to CSV
2. Import to Supabase/PostgreSQL
3. Update API routes
4. Done!

But most likely, Airtable will work great for years. It's built for this exact use case.

---

**Questions?** Check the Airtable docs or let me know!




