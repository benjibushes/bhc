# Airtable Campaign Tracking Setup

## Required Field Additions

### 1. Consumers Table - Add These Fields:

1. **Source** (Single line text)
   - Examples: "organic", "email", "referral", "social"
   - Default: "organic"

2. **Campaign** (Single line text)
   - Examples: "january-texas-beef", "land-deals-promo", "merch-launch"
   - Leave empty for non-campaign sign-ups

3. **UTM Parameters** (Long text)
   - Stores full UTM string from URL
   - Optional - for detailed tracking

### 2. Inquiries Table - Add This Field:

1. **Source** (Single line text)
   - Inherited from the consumer's campaign
   - Tracks which campaign drove the inquiry

### 3. Create New Table: Campaigns

Create a new table called **"Campaigns"** with these fields:

1. **Campaign Name** (Single line text) - PRIMARY FIELD
   - Example: "january-texas-beef"

2. **Subject Line** (Single line text)
   - Email subject used

3. **Message Body** (Long text)
   - Email message content

4. **Audience Filter** (Single line text)
   - Example: "all", "state:TX,CA", "ranchers"

5. **Sent Date** (Date)
   - When the email was sent

6. **Recipients Count** (Number)
   - How many emails were sent

7. **Link Clicks** (Number)
   - Manual tracking for now

8. **Sign-ups** (Formula - OPTIONAL)
   - Count consumers where Campaign matches
   - Formula: `COUNTALL(FILTER({Consumers}, {Campaign} = THISROW().[Campaign Name]))`
   - Note: This requires linking tables, which is advanced. Skip for now if complex.

9. **Inquiries** (Formula - OPTIONAL)
   - Count inquiries where Source matches
   - Similar to Sign-ups formula

---

## Quick Setup Steps:

### Step 1: Add Fields to Consumers Table

1. Open your BHC CRM base in Airtable
2. Go to the **Consumers** table
3. Click the **"+"** button to add a new field
4. Add:
   - Field name: **Source**
   - Field type: **Single line text**
5. Repeat for **Campaign** and **UTM Parameters**

### Step 2: Add Field to Inquiries Table

1. Go to the **Inquiries** table
2. Add field:
   - Field name: **Source**
   - Field type: **Single line text**

### Step 3: Create Campaigns Table

1. Click **"Add or import"** → **"Create empty table"**
2. Name it: **Campaigns**
3. The first field will be the primary field - rename it to **Campaign Name**
4. Add the remaining fields listed above

---

## Test the Setup:

After adding these fields, test the campaign tracking:

1. Visit your site with: `http://localhost:3000/?campaign=test-campaign`
2. Click "Apply for Access" and submit the form
3. Check Airtable Consumers table - the new record should have:
   - **Source**: "email"
   - **Campaign**: "test-campaign"

---

## Notes:

- Existing records will have empty Source/Campaign fields - that's fine
- All new sign-ups will automatically track campaigns
- The Campaigns table will be populated when you send broadcast emails from the admin panel

---

**Ready to continue?** Once you've added these fields, I'll finish building the broadcast email system and analytics dashboard.


