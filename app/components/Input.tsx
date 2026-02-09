interface InputProps {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}

export default function Input({
  label,
  name,
  type = "text",
  required = false,
  value,
  onChange,
  placeholder
}: InputProps) {
  return (
    <div className="space-y-2">
      <label htmlFor={name} className="block text-sm font-medium">
        {label} {required && <span className="text-[#8C2F2F]">*</span>}
      </label>
      <input
        type={type}
        id={name}
        name={name}
        required={required}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E] transition-colors"
      />
    </div>
  );
}


