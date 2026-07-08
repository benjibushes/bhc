// lib/stripeAppearance.ts
//
// THE brand skin for Stripe Elements (Payment Element migration — spec §4).
// Values are the REAL tokens from app/globals.css — bone/charcoal/saddle/
// dust/weathered, square corners (Western paper, not Material), lowercase
// labels, Inter body. Headings never render inside Elements (they stay our
// DOM), so no serif config needed here. Shared so a future deposit-rail
// Element migration reads identically.
//
// The Google-fonts cssSrc loads inside Stripe's iframe, not our page — no
// CSP interaction with the artifact/site policy.

export const bhcFonts = [
  { cssSrc: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
];

export const bhcAppearance = {
  theme: 'stripe' as const,
  variables: {
    colorPrimary: '#0E0E0E',        // charcoal
    colorBackground: '#FFFFFF',
    colorText: '#0E0E0E',
    colorTextSecondary: '#6B4F3F',  // saddle
    colorTextPlaceholder: '#A7A29A', // dust
    colorDanger: '#8C2F2F',         // weathered
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSizeBase: '15px',
    borderRadius: '0px',
    spacingUnit: '4px',
    focusOutline: '2px solid #0E0E0E',
    focusBoxShadow: 'none',
  },
  rules: {
    '.Input': { border: '1px solid #A7A29A', boxShadow: 'none' },
    '.Input:focus': { border: '1px solid #0E0E0E', boxShadow: 'none' },
    '.Input--invalid': { border: '1px solid #8C2F2F', boxShadow: 'none' },
    '.Label': { color: '#6B4F3F', fontSize: '13px', textTransform: 'lowercase' as const },
    '.Error': { color: '#8C2F2F', fontSize: '13px' },
    '.Tab': { border: '1px solid #A7A29A', boxShadow: 'none' },
    '.Tab--selected': { border: '1px solid #0E0E0E', backgroundColor: '#ECE8E0' },
    '.Block': { border: '1px solid #A7A29A', boxShadow: 'none' },
  },
};
