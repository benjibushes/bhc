# BuyHalfCow — Complete Database Schema

## Setup Instructions

1. Create a Supabase project at https://supabase.com
2. Copy your project URL and anon key
3. Create `.env.local` file in project root:
```bash
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```
4. Run the SQL below in Supabase SQL Editor

---

## SQL Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- CONSUMERS TABLE
-- =====================================================
CREATE TABLE consumers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  state TEXT NOT NULL,
  interests TEXT[], -- ['beef', 'land', 'merch', 'all']
  status TEXT DEFAULT 'pending', -- pending, approved, rejected
  membership TEXT DEFAULT 'none', -- none, active, inactive
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for consumers
CREATE INDEX idx_consumers_email ON consumers(email);
CREATE INDEX idx_consumers_state ON consumers(state);
CREATE INDEX idx_consumers_status ON consumers(status);
CREATE INDEX idx_consumers_membership ON consumers(membership);

-- =====================================================
-- RANCHERS TABLE
-- =====================================================
CREATE TABLE ranchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ranch_name TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  state TEXT NOT NULL,
  acreage INTEGER NOT NULL,
  beef_types TEXT NOT NULL, -- e.g., "Grass-fed, Wagyu, Angus"
  monthly_capacity INTEGER NOT NULL, -- head of cattle per month
  certifications TEXT, -- e.g., "USDA Organic, Certified Humane"
  commission_agreed BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected
  certified BOOLEAN DEFAULT FALSE, -- Admin must certify
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for ranchers
CREATE INDEX idx_ranchers_state ON ranchers(state);
CREATE INDEX idx_ranchers_certified ON ranchers(certified);
CREATE INDEX idx_ranchers_status ON ranchers(status);
CREATE INDEX idx_ranchers_state_certified ON ranchers(state, certified) WHERE certified = TRUE;

-- =====================================================
-- BRANDS TABLE
-- =====================================================
CREATE TABLE brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brand_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  website TEXT,
  product_type TEXT NOT NULL, -- e.g., "Western apparel, ranch tools"
  promotion_details TEXT NOT NULL,
  discount_offered INTEGER NOT NULL, -- percentage
  exclusivity_agreed BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected
  active BOOLEAN DEFAULT FALSE, -- Admin controls visibility
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for brands
CREATE INDEX idx_brands_active ON brands(active);
CREATE INDEX idx_brands_status ON brands(status);

-- =====================================================
-- LAND DEALS TABLE
-- =====================================================
CREATE TABLE land_deals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  property_location TEXT NOT NULL, -- City, County
  state TEXT NOT NULL,
  acreage INTEGER NOT NULL,
  asking_price TEXT NOT NULL,
  property_type TEXT NOT NULL, -- Ranch, Hunting Land, Agricultural
  zoning TEXT NOT NULL,
  utilities TEXT NOT NULL,
  description TEXT NOT NULL,
  exclusive_to_members BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected
  visible_to_members BOOLEAN DEFAULT FALSE, -- Admin controls visibility
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for land deals
CREATE INDEX idx_land_deals_state ON land_deals(state);
CREATE INDEX idx_land_deals_visible ON land_deals(visible_to_members);
CREATE INDEX idx_land_deals_status ON land_deals(status);

-- =====================================================
-- NEWS POSTS TABLE (Blog/Weekly Updates)
-- =====================================================
CREATE TABLE news_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT NOT NULL,
  content TEXT NOT NULL, -- HTML content
  author TEXT DEFAULT 'BuyHalfCow Team',
  published BOOLEAN DEFAULT FALSE,
  published_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for news posts
CREATE INDEX idx_news_posts_slug ON news_posts(slug);
CREATE INDEX idx_news_posts_published ON news_posts(published);
CREATE INDEX idx_news_posts_published_date ON news_posts(published_date DESC);

-- =====================================================
-- INQUIRIES TABLE (Contact/Lead Tracking)
-- =====================================================
CREATE TABLE inquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  consumer_id UUID REFERENCES consumers(id),
  rancher_id UUID REFERENCES ranchers(id),
  consumer_name TEXT NOT NULL,
  consumer_email TEXT NOT NULL,
  consumer_phone TEXT,
  message TEXT NOT NULL,
  interest_type TEXT, -- half_cow, quarter_cow, whole_cow, custom
  status TEXT DEFAULT 'sent', -- sent, replied, sale_completed, no_sale
  sale_amount DECIMAL,
  commission_amount DECIMAL,
  commission_paid BOOLEAN DEFAULT FALSE,
  notes TEXT, -- Admin notes
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for inquiries
CREATE INDEX idx_inquiries_consumer_id ON inquiries(consumer_id);
CREATE INDEX idx_inquiries_rancher_id ON inquiries(rancher_id);
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_created_at ON inquiries(created_at DESC);
CREATE INDEX idx_inquiries_commission_paid ON inquiries(commission_paid) WHERE status = 'sale_completed';

-- =====================================================
-- TRIGGERS FOR UPDATED_AT
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_consumers_updated_at BEFORE UPDATE ON consumers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ranchers_updated_at BEFORE UPDATE ON ranchers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_brands_updated_at BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_land_deals_updated_at BEFORE UPDATE ON land_deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_news_posts_updated_at BEFORE UPDATE ON news_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_inquiries_updated_at BEFORE UPDATE ON inquiries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE land_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries ENABLE ROW LEVEL SECURITY;

-- Public can insert consumer applications
CREATE POLICY "Anyone can submit consumer applications"
  ON consumers FOR INSERT
  WITH CHECK (true);

-- Public can insert partner applications
CREATE POLICY "Anyone can submit rancher applications"
  ON ranchers FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can submit brand applications"
  ON brands FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can submit land deals"
  ON land_deals FOR INSERT
  WITH CHECK (true);

-- Public can read published news posts
CREATE POLICY "Anyone can read published news"
  ON news_posts FOR SELECT
  USING (published = true);

-- Members can read certified ranchers
CREATE POLICY "Members can read certified ranchers"
  ON ranchers FOR SELECT
  USING (certified = true AND status = 'approved');

-- Members can read approved land deals
CREATE POLICY "Members can read visible land deals"
  ON land_deals FOR SELECT
  USING (visible_to_members = true AND status = 'approved');

-- Members can read active brands
CREATE POLICY "Members can read active brands"
  ON brands FOR SELECT
  USING (active = true AND status = 'approved');

-- Anyone can create inquiries (for now, until auth is implemented)
CREATE POLICY "Anyone can submit inquiries"
  ON inquiries FOR INSERT
  WITH CHECK (true);

-- Admin policies (requires auth.uid() check - implement with Supabase Auth)
-- For now, admin operations will use service role key server-side
```

---

## Sample Data (Optional - For Testing)

```sql
-- Sample Rancher
INSERT INTO ranchers (
  ranch_name, operator_name, email, phone, state, acreage,
  beef_types, monthly_capacity, certifications, commission_agreed,
  status, certified
) VALUES (
  'Lone Star Ranch',
  'John Smith',
  'john@lonestarranch.com',
  '555-0100',
  'TX',
  2500,
  'Grass-fed Angus, Wagyu',
  50,
  'USDA Organic, Certified Humane',
  true,
  'approved',
  true
);

-- Sample Land Deal
INSERT INTO land_deals (
  seller_name, email, phone, property_location, state, acreage,
  asking_price, property_type, zoning, utilities, description,
  exclusive_to_members, status, visible_to_members
) VALUES (
  'Mountain View Properties LLC',
  'info@mountainview.com',
  '555-0200',
  'Marfa, Presidio County',
  'TX',
  500,
  '$625,000',
  'Ranch Land',
  'Agricultural',
  'Well water, Electric nearby, Septic required',
  '500 acres of pristine West Texas ranch land with stunning mountain views. Perfect for cattle grazing or hunting. Partially fenced with road access.',
  true,
  'approved',
  true
);

-- Sample Brand
INSERT INTO brands (
  brand_name, contact_name, email, phone, website, product_type,
  promotion_details, discount_offered, exclusivity_agreed, status, active
) VALUES (
  'Western Heritage Co.',
  'Sarah Johnson',
  'sarah@westernheritage.com',
  '555-0300',
  'https://westernheritage.com',
  'Western apparel, leather goods, ranch tools',
  'Exclusive 20% off all products for BuyHalfCow members. Use code: BHCMEMBER',
  20,
  true,
  'approved',
  true
);

-- Sample News Post
INSERT INTO news_posts (
  title, slug, excerpt, content, author, published, published_date
) VALUES (
  'Welcome to BuyHalfCow',
  'welcome-to-buyhalfcow',
  'We''re building a private network connecting verified ranchers with serious buyers.',
  '<p>Welcome to BuyHalfCow — a new kind of platform built on trust, transparency, and real relationships.</p><p>We''re not a marketplace. We''re not trying to disrupt anything. We''re simply connecting people who care about where their beef comes from with ranchers who do it the right way.</p><p>Every rancher is verified. Every deal is reviewed. Every member is approved.</p><p>This is how it should be.</p>',
  'BuyHalfCow Team',
  true,
  NOW()
);
```

---

## Table Relationships

```
consumers
  ├── Has membership status
  └── Can view certified ranchers in their state

ranchers
  ├── Must be certified by admin
  ├── Visible to members in same state
  └── Status controlled by admin

brands
  ├── Must be activated by admin
  └── Visible to all members when active

land_deals
  ├── Must be approved by admin
  └── Visible to members when approved

news_posts
  ├── Created by admin
  └── Visible to public when published
```

---

## Admin Actions

### Consumer Management
- Change status: pending → approved/rejected
- Toggle membership: none → active → inactive

### Rancher Management
- Change status: pending → approved/rejected
- **Toggle certified**: false → true (CRITICAL - enables member visibility)

### Brand Management
- Change status: pending → approved/rejected
- **Toggle active**: false → true (controls member visibility)

### Land Deal Management
- Change status: pending → approved/rejected
- **Toggle visible_to_members**: false → true (controls member visibility)

### News Management
- Create/edit posts
- **Toggle published**: false → true (makes public)

---

## Next Steps

1. Run this SQL in Supabase SQL Editor
2. Add your Supabase credentials to `.env.local`
3. Test form submissions
4. Verify data appears in admin dashboard
5. Implement Supabase Auth for member login (see AUTH_SETUP.md)

---

**Database Status: ✅ Complete**  
All tables, indexes, triggers, and RLS policies defined.

