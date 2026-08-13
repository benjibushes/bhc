'use client';

import { useState } from 'react';
import InquiryModal from './InquiryModal';

interface ContactRancherButtonProps {
  rancher: {
    id: string;
    ranch_name: string;
    operator_name: string;
    email: string;
    state: string;
  };
  /**
   * The authenticated member's Consumer record id (member.id IS the
   * session's consumerId — app/api/auth/member/session). This button only
   * renders inside the member dashboard (MemberAuthGuard), so the identity is
   * always known; forwarding it lets /api/inquiries link `Consumer ID` and
   * restore campaign attribution instead of falling back to Source='direct'
   * (preference-fidelity audit 2026-08-12).
   */
  consumerId?: string;
}

export default function ContactRancherButton({ rancher, consumerId }: ContactRancherButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="w-full px-6 py-3 bg-charcoal text-bone hover:bg-divider transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-charcoal"
      >
        Contact This Rancher
      </button>

      {isModalOpen && (
        <InquiryModal
          rancher={rancher}
          consumerId={consumerId}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
}


