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
        className="w-full px-6 py-3 bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] transition-colors duration-300 font-medium tracking-wide uppercase text-sm border border-[#0E0E0E]"
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


