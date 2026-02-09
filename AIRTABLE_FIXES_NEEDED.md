# Airtable Configuration Issues Found During Testing

## TEST 1: Consumer Application ✅ FIXED
- **Issue:** Missing fields in "Consumers" table
- **Fields Added:** `Source`, `Campaign`, `UTM Parameters`
- **Status:** ✅ RESOLVED

## TEST 2: Rancher Application ✅ FIXED
- **Issue 1:** "Interests" field rejecting "Beef" option
- **Fix:** Changed to Long text or added "Beef" to select options
- **Status:** ✅ RESOLVED

- **Issue 2:** "Certified" checkbox rejecting boolean values
- **Fix:** Field configured as Checkbox, omit false values in API
- **Status:** ✅ RESOLVED

## TEST 5: Member Inquiry System ⚠️ NEEDS FIXING

### Inquiries Table Configuration Required

Your "Inquiries" table is missing proper field configurations. Here's what needs to be set up:

#### Required Field Configurations:

1. **Status** (Single select)
   - Options: `Pending`, `Approved`, `Rejected`, `Completed`
   - Default: `Pending`
   - This field tracks the inquiry approval workflow

2. **Interest Type** (Single select OR Long text)
   - If Single select, options: `Beef`, `Land`, `Merch`, `All`
   - If Long text, accepts any string
   - This field captures what the consumer is interested in

3. **Commission Paid** (Checkbox)
   - Type: Checkbox
   - Default: Unchecked
   - This field tracks whether commission has been paid to BHC

4. **Existing Fields to Verify:**
   - Consumer ID (Single line text)
   - Rancher ID (Single line text)
   - Consumer Name (Single line text)
   - Consumer Email (Email or Single line text)
   - Consumer Phone (Phone or Single line text)
   - Rancher Email (Email or Single line text)
   - Ranch Name (Single line text)
   - Message (Long text)
   - Sale Amount (Number, Currency format)
   - Commission Amount (Number, Currency format)
   - Source (Single line text)
   - Notes (Long text - optional)
   - Created (Created time - auto)

### How to Fix:

1. Open your Airtable base
2. Go to the "Inquiries" table
3. For the **Status** field:
   - Change field type to "Single select"
   - Add options: `Pending`, `Approved`, `Rejected`, `Completed`
   - Set default to `Pending`

4. For the **Interest Type** field:
   - OPTION A: Change to "Single select" with options: `Beef`, `Land`, `Merch`, `All`
   - OPTION B: Change to "Long text" to accept any value

5. For the **Commission Paid** field:
   - Ensure it's set as "Checkbox" type

### Testing After Fix:

Once these fields are configured, the inquiry system will work as follows:

1. Member submits inquiry via "Contact This Rancher" button
2. Inquiry is created with Status = "Pending"
3. Admin receives email alert
4. Admin reviews inquiry at `/admin/inquiries`
5. Admin clicks "Approve" → Status changes to "Approved" → Rancher receives email
6. When sale completes, admin updates "Sale Amount"
7. Commission is automatically calculated (10% default)
8. Admin marks "Commission Paid" when payment is made

---

## Summary of All Fixes Needed

### ✅ Already Fixed by User:
- [x] Consumers table: Added Source, Campaign, UTM Parameters fields
- [x] Consumers table: Fixed "Interests" field to accept "Beef"
- [x] Ranchers table: Fixed "Certified" checkbox field

### ⚠️ Still Needs User Action:
- [ ] Inquiries table: Configure "Status" as Single select (Pending, Approved, Rejected, Completed)
- [ ] Inquiries table: Configure "Interest Type" as Single select or Long text
- [ ] Inquiries table: Ensure "Commission Paid" is Checkbox type

Once the Inquiries table is properly configured, the complete end-to-end inquiry workflow (gatekeeping, approval, commission tracking) will function correctly.
