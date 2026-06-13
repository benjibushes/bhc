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
}

export default function ContactRancherButton({ rancher }: ContactRancherButtonProps) {
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
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
}


