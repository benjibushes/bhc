import { toast as sonnerToast } from 'sonner';

// Thin wrapper around sonner with BHC-branded defaults.
// Admin pages should call these instead of alert() or silent catches.
export const toast = {
  success: (message: string, description?: string) =>
    sonnerToast.success(message, { description, duration: 4000 }),
  error: (message: string, description?: string) =>
    sonnerToast.error(message, { description, duration: 7000 }),
  info: (message: string, description?: string) =>
    sonnerToast.info(message, { description, duration: 4000 }),
  warning: (message: string, description?: string) =>
    sonnerToast.warning(message, { description, duration: 5000 }),
  promise: sonnerToast.promise,
};

// Wrap a fetch call so any failure (network, non-2xx, thrown error) surfaces
// as a toast and the raw response is still returned to the caller. Removes
// the need for try/catch + alert() around every admin mutation.
export async function fetchWithToast(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: { success?: string; error?: string } = {}
): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(input, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(opts.error || 'Request failed', data?.error || `HTTP ${res.status}`);
      return { ok: false, status: res.status, data };
    }
    if (opts.success) toast.success(opts.success, data?.message);
    return { ok: true, status: res.status, data };
  } catch (e: any) {
    toast.error(opts.error || 'Network error', e?.message || String(e));
    return { ok: false, status: 0, data: null };
  }
}
