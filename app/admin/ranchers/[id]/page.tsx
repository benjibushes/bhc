'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Container from '../../../components/Container';
import AdminAuthGuard from '../../../components/AdminAuthGuard';

interface Testimonial {
  name: string;
  quote: string;
  location?: string;
  photo?: string;
}

interface CustomProduct {
  name: string;
  price: number | string;
  description: string;
  link: string;
}

export default function AdminRancherDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rancher, setRancher] = useState<any>(null);
  const [error, setError] = useState('');

  // Form state
  const [form, setForm] = useState({
    slug: '',
    tagline: '',
    about_text: '',
    logo_url: '',
    video_url: '',
    custom_notes: '',
    quarter_price: '',
    quarter_lbs: '',
    quarter_payment_link: '',
    half_price: '',
    half_lbs: '',
    half_payment_link: '',
    whole_price: '',
    whole_lbs: '',
    whole_payment_link: '',
    next_processing_date: '',
    reserve_link: '',
    google_reviews_url: '',
    facebook_url: '',
    instagram_url: '',
    processing_facility: '',
    verification_method: '',
    verification_status: '',
    verification_notes: '',
    page_live: false,
    ships_nationwide: false,
    states_served: '',
    onboarding_status: '',
    active_status: '',
  });

  const [testimonials, setTestimonials] = useState<Testimonial[]>([]);
  const [galleryPhotos, setGalleryPhotos] = useState<string[]>([]);
  const [customProducts, setCustomProducts] = useState<CustomProduct[]>([]);
  const [newTestimonial, setNewTestimonial] = useState<Testimonial>({ name: '', quote: '', location: '' });
  const [newPhotoUrl, setNewPhotoUrl] = useState('');
  const [newProduct, setNewProduct] = useState<CustomProduct>({ name: '', price: '', description: '', link: '' });

  useEffect(() => {
    fetchRancher();
  }, [id]);

  async function fetchRancher() {
    try {
      const res = await fetch(`/api/admin/ranchers?id=${id}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      // The ranchers endpoint returns an array, find our rancher
      const r = Array.isArray(data) ? data.find((x: any) => x.id === id) : data;
      if (!r) throw new Error('Rancher not found');
      setRancher(r);

      // Populate form from rancher data
      setForm({
        slug: r.slug || '',
        tagline: r.tagline || '',
        about_text: r.about_text || '',
        logo_url: r.logo_url || '',
        video_url: r.video_url || '',
        custom_notes: r.custom_notes || '',
        quarter_price: r.quarter_price?.toString() || '',
        quarter_lbs: r.quarter_lbs || '',
        quarter_payment_link: r.quarter_payment_link || '',
        half_price: r.half_price?.toString() || '',
        half_lbs: r.half_lbs || '',
        half_payment_link: r.half_payment_link || '',
        whole_price: r.whole_price?.toString() || '',
        whole_lbs: r.whole_lbs || '',
        whole_payment_link: r.whole_payment_link || '',
        next_processing_date: r.next_processing_date || '',
        reserve_link: r.reserve_link || '',
        google_reviews_url: r.google_reviews_url || '',
        facebook_url: r.facebook_url || '',
        instagram_url: r.instagram_url || '',
        processing_facility: r.processing_facility || '',
        verification_method: r.verification_method || '',
        verification_status: r.verification_status || '',
        verification_notes: r.verification_notes || '',
        page_live: r.page_live || false,
        ships_nationwide: r.ships_nationwide || false,
        states_served: r.states_served || '',
        onboarding_status: r.onboarding_status || '',
        active_status: r.active_status || '',
      });

      // Parse testimonials
      try {
        setTestimonials(r.testimonials ? JSON.parse(r.testimonials) : []);
      } catch { setTestimonials([]); }

      // Parse gallery
      try {
        setGalleryPhotos(r.gallery_photos ? JSON.parse(r.gallery_photos) : []);
      } catch { setGalleryPhotos([]); }

      // Parse custom products
      try {
        setCustomProducts(r.custom_products ? JSON.parse(r.custom_products) : []);
      } catch { setCustomProducts([]); }

    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const payload = {
        ...form,
        testimonials: JSON.stringify(testimonials),
        gallery_photos: JSON.stringify(galleryPhotos),
        custom_products: JSON.stringify(customProducts),
      };
      const res = await fetch(`/api/admin/ranchers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  function addTestimonial() {
    if (!newTestimonial.name || !newTestimonial.quote) return;
    setTestimonials([...testimonials, { ...newTestimonial }]);
    setNewTestimonial({ name: '', quote: '', location: '' });
  }

  function removeTestimonial(idx: number) {
    setTestimonials(testimonials.filter((_, i) => i !== idx));
  }

  function addGalleryPhoto() {
    if (!newPhotoUrl) return;
    setGalleryPhotos([...galleryPhotos, newPhotoUrl]);
    setNewPhotoUrl('');
  }

  function removeGalleryPhoto(idx: number) {
    setGalleryPhotos(galleryPhotos.filter((_, i) => i !== idx));
  }

  function addCustomProduct() {
    if (!newProduct.name || !newProduct.price) return;
    setCustomProducts([...customProducts, { ...newProduct, price: parseFloat(String(newProduct.price)) || 0 }]);
    setNewProduct({ name: '', price: '', description: '', link: '' });
  }

  function removeCustomProduct(idx: number) {
    setCustomProducts(customProducts.filter((_, i) => i !== idx));
  }

  function updateForm(key: string, value: any) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  if (loading) return <AdminAuthGuard><div className="min-h-screen bg-[#F4F1EC] flex items-center justify-center"><p>Loading...</p></div></AdminAuthGuard>;
  if (error) return <AdminAuthGuard><div className="min-h-screen bg-[#F4F1EC] flex items-center justify-center"><p className="text-red-600">{error}</p></div></AdminAuthGuard>;

  const siteUrl = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <AdminAuthGuard>
      <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E] py-10">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <button onClick={() => router.push('/admin')} className="text-sm text-[#6B4F3F] hover:underline mb-2 block">
                  &larr; Back to Admin
                </button>
                <h1 className="font-[family-name:var(--font-playfair)] text-3xl">
                  {rancher.ranch_name || rancher.operator_name}
                </h1>
                <p className="text-[#6B4F3F]">{rancher.operator_name} &middot; {rancher.email} &middot; {rancher.state}</p>
              </div>
              <div className="flex gap-2">
                {form.slug && (
                  <a href={`/ranchers/${form.slug}`} target="_blank" className="px-4 py-2 text-sm border border-[#A7A29A] hover:bg-white">
                    Preview Page &rarr;
                  </a>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-6 py-2 text-sm bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] disabled:opacity-50"
                >
                  {saving ? 'Saving...' : saved ? 'Saved!' : 'Save All Changes'}
                </button>
              </div>
            </div>

            {/* Status bar */}
            <div className="flex flex-wrap gap-3 p-4 border border-[#A7A29A] bg-white">
              <div>
                <label className="text-xs text-[#A7A29A] block">Onboarding</label>
                <select value={form.onboarding_status} onChange={e => updateForm('onboarding_status', e.target.value)}
                  className="px-2 py-1 border border-[#A7A29A] text-sm bg-[#F4F1EC]">
                  <option value="">Not Started</option>
                  <option value="Call Scheduled">Call Scheduled</option>
                  <option value="Call Complete">Call Complete</option>
                  <option value="Docs Sent">Docs Sent</option>
                  <option value="Agreement Signed">Agreement Signed</option>
                  <option value="Verification Pending">Verification Pending</option>
                  <option value="Verification Complete">Verification Complete</option>
                  <option value="Live">Live</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-[#A7A29A] block">Active Status</label>
                <select value={form.active_status} onChange={e => updateForm('active_status', e.target.value)}
                  className="px-2 py-1 border border-[#A7A29A] text-sm bg-[#F4F1EC]">
                  <option value="">Pending</option>
                  <option value="Active">Active</option>
                  <option value="At Capacity">At Capacity</option>
                  <option value="Paused">Paused</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.page_live} onChange={e => updateForm('page_live', e.target.checked)} />
                  Page Live
                </label>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={form.ships_nationwide} onChange={e => updateForm('ships_nationwide', e.target.checked)} />
                  Ships Nationwide
                </label>
              </div>
            </div>

            {/* Page Identity */}
            <section className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Page Identity</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Slug (URL path)</label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-[#A7A29A]">/ranchers/</span>
                    <input value={form.slug} onChange={e => updateForm('slug', e.target.value)}
                      className="flex-1 px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="ranch-name" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Tagline</label>
                  <input value={form.tagline} onChange={e => updateForm('tagline', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Premium grass-fed beef..." />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Logo URL</label>
                  <input value={form.logo_url} onChange={e => updateForm('logo_url', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://..." />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Video URL (YouTube/Vimeo)</label>
                  <input value={form.video_url} onChange={e => updateForm('video_url', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://youtube.com/..." />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">States Served</label>
                  <input value={form.states_served} onChange={e => updateForm('states_served', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="CO, WY, MT" />
                </div>
              </div>
              <div>
                <label className="text-xs text-[#A7A29A] block mb-1">About Text</label>
                <textarea value={form.about_text} onChange={e => updateForm('about_text', e.target.value)}
                  rows={5} className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Tell the ranch's story..." />
              </div>
              <div>
                <label className="text-xs text-[#A7A29A] block mb-1">Custom Notes (displayed on page)</label>
                <textarea value={form.custom_notes} onChange={e => updateForm('custom_notes', e.target.value)}
                  rows={3} className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Special notes for buyers..." />
              </div>
            </section>

            {/* Pricing */}
            <section className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Pricing & Payment Links</h2>
              {['quarter', 'half', 'whole'].map(tier => (
                <div key={tier} className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-[#A7A29A] block mb-1">{tier.charAt(0).toUpperCase() + tier.slice(1)} Price ($)</label>
                    <input value={(form as any)[`${tier}_price`]} onChange={e => updateForm(`${tier}_price`, e.target.value)}
                      type="number" className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="0" />
                  </div>
                  <div>
                    <label className="text-xs text-[#A7A29A] block mb-1">{tier.charAt(0).toUpperCase() + tier.slice(1)} lbs</label>
                    <input value={(form as any)[`${tier}_lbs`]} onChange={e => updateForm(`${tier}_lbs`, e.target.value)}
                      className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="100-120 lbs" />
                  </div>
                  <div>
                    <label className="text-xs text-[#A7A29A] block mb-1">{tier.charAt(0).toUpperCase() + tier.slice(1)} Payment Link</label>
                    <input value={(form as any)[`${tier}_payment_link`]} onChange={e => updateForm(`${tier}_payment_link`, e.target.value)}
                      className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://..." />
                  </div>
                </div>
              ))}
              <div className="grid md:grid-cols-2 gap-3 pt-2 border-t border-[#A7A29A]/30">
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Next Processing Date</label>
                  <input value={form.next_processing_date} onChange={e => updateForm('next_processing_date', e.target.value)}
                    type="date" className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Reserve Link</label>
                  <input value={form.reserve_link} onChange={e => updateForm('reserve_link', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://..." />
                </div>
              </div>
            </section>

            {/* Testimonials */}
            <section className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Customer Testimonials ({testimonials.length})</h2>
              {testimonials.map((t, i) => (
                <div key={i} className="p-3 border border-[#A7A29A]/50 flex justify-between items-start">
                  <div>
                    <p className="text-sm italic">&ldquo;{t.quote}&rdquo;</p>
                    <p className="text-xs text-[#6B4F3F] mt-1">— {t.name}{t.location ? `, ${t.location}` : ''}</p>
                  </div>
                  <button onClick={() => removeTestimonial(i)} className="text-red-500 text-xs hover:underline ml-2">Remove</button>
                </div>
              ))}
              <div className="grid md:grid-cols-3 gap-2">
                <input value={newTestimonial.name} onChange={e => setNewTestimonial({ ...newTestimonial, name: e.target.value })}
                  className="px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Customer name" />
                <input value={newTestimonial.location || ''} onChange={e => setNewTestimonial({ ...newTestimonial, location: e.target.value })}
                  className="px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Location (optional)" />
                <button onClick={addTestimonial} className="px-3 py-2 text-sm bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A]">
                  + Add
                </button>
              </div>
              <textarea value={newTestimonial.quote} onChange={e => setNewTestimonial({ ...newTestimonial, quote: e.target.value })}
                rows={2} className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Their testimonial quote..." />
            </section>

            {/* Gallery Photos */}
            <section className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Gallery Photos ({galleryPhotos.length})</h2>
              <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                {galleryPhotos.map((url, i) => (
                  <div key={i} className="relative group">
                    <img src={url} alt={`Photo ${i + 1}`} className="w-full aspect-square object-cover border border-[#A7A29A]" />
                    <button onClick={() => removeGalleryPhoto(i)}
                      className="absolute top-1 right-1 bg-red-600 text-white text-xs px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      X
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newPhotoUrl} onChange={e => setNewPhotoUrl(e.target.value)}
                  className="flex-1 px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Image URL (https://...)" />
                <button onClick={addGalleryPhoto} className="px-4 py-2 text-sm bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A]">
                  + Add Photo
                </button>
              </div>
            </section>

            {/* Custom Products */}
            <section className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Custom Products ({customProducts.length})</h2>
              <p className="text-xs text-[#A7A29A]">Add additional products beyond quarter/half/whole beef (e.g. sampler boxes, jerky, bones).</p>
              {customProducts.map((p, i) => (
                <div key={i} className="p-3 border border-[#A7A29A]/50 flex justify-between items-start">
                  <div>
                    <p className="text-sm font-medium">{p.name} — ${p.price}</p>
                    {p.description && <p className="text-xs text-[#6B4F3F] mt-0.5">{p.description}</p>}
                    {p.link && <p className="text-xs text-[#A7A29A] mt-0.5 truncate max-w-md">{p.link}</p>}
                  </div>
                  <button onClick={() => removeCustomProduct(i)} className="text-red-500 text-xs hover:underline ml-2">Remove</button>
                </div>
              ))}
              <div className="grid md:grid-cols-2 gap-2">
                <input value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })}
                  className="px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Product name" />
                <input value={newProduct.price} onChange={e => setNewProduct({ ...newProduct, price: e.target.value })}
                  type="number" className="px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Price ($)" />
              </div>
              <input value={newProduct.description} onChange={e => setNewProduct({ ...newProduct, description: e.target.value })}
                className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Short description (e.g. 10 lbs of mixed cuts)" />
              <div className="flex gap-2">
                <input value={newProduct.link} onChange={e => setNewProduct({ ...newProduct, link: e.target.value })}
                  className="flex-1 px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Payment link (https://...)" />
                <button onClick={addCustomProduct} className="px-4 py-2 text-sm bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A]">
                  + Add Product
                </button>
              </div>
            </section>

            {/* Social & Verification */}
            <section className="p-6 border border-[#A7A29A] bg-white space-y-4">
              <h2 className="font-[family-name:var(--font-playfair)] text-xl">Social Proof & Verification</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Google Reviews URL</label>
                  <input value={form.google_reviews_url} onChange={e => updateForm('google_reviews_url', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://..." />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Facebook URL</label>
                  <input value={form.facebook_url} onChange={e => updateForm('facebook_url', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://facebook.com/..." />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Instagram URL</label>
                  <input value={form.instagram_url} onChange={e => updateForm('instagram_url', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="https://instagram.com/..." />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Processing Facility (USDA)</label>
                  <input value={form.processing_facility} onChange={e => updateForm('processing_facility', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Facility name" />
                </div>
              </div>
              <div className="grid md:grid-cols-3 gap-4 pt-4 border-t border-[#A7A29A]/30">
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Verification Method</label>
                  <input value={form.verification_method} onChange={e => updateForm('verification_method', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="e.g. Testimonials, Photos" />
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Verification Status</label>
                  <select value={form.verification_status} onChange={e => updateForm('verification_status', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]">
                    <option value="">Not Started</option>
                    <option value="Pending">Pending</option>
                    <option value="Verified">Verified</option>
                    <option value="Needs More Info">Needs More Info</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#A7A29A] block mb-1">Verification Notes</label>
                  <input value={form.verification_notes} onChange={e => updateForm('verification_notes', e.target.value)}
                    className="w-full px-3 py-2 border border-[#A7A29A] text-sm bg-[#F4F1EC]" placeholder="Internal notes..." />
                </div>
              </div>
            </section>

            {/* Bottom save */}
            <div className="flex justify-between items-center pt-4">
              <button onClick={() => router.push('/admin')} className="text-sm text-[#6B4F3F] hover:underline">
                &larr; Back to Admin
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-8 py-3 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] disabled:opacity-50"
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Save All Changes'}
              </button>
            </div>
          </div>
        </Container>
      </main>
    </AdminAuthGuard>
  );
}
