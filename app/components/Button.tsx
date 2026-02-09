import Link from 'next/link';

interface ButtonProps {
  href?: string;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export default function Button({ 
  href, 
  children, 
  variant = 'primary',
  type = 'button',
  onClick,
  disabled = false,
  className = ''
}: ButtonProps) {
  const baseStyles = "inline-block px-8 py-4 text-center transition-colors duration-300 border border-[#0E0E0E] font-medium tracking-wide uppercase text-sm";
  const variants = {
    primary: "bg-[#0E0E0E] text-[#F4F1EC] hover:bg-[#2A2A2A] hover:border-[#2A2A2A]",
    secondary: "bg-transparent text-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-[#F4F1EC]"
  };
  
  const styles = `${baseStyles} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`;

  if (href) {
    return (
      <Link href={href} className={styles}>
        {children}
      </Link>
    );
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled} className={styles}>
      {children}
    </button>
  );
}

