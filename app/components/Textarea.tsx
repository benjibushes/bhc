interface TextareaProps {
  label: string;
  name: string;
  required?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
}

export default function Textarea({
  label,
  name,
  required = false,
  value,
  onChange,
  placeholder,
  rows = 4
}: TextareaProps) {
  return (
    <div className="space-y-2">
      <label htmlFor={name} className="block text-sm font-medium">
        {label} {required && <span className="text-[#8C2F2F]">*</span>}
      </label>
      <textarea
        id={name}
        name={name}
        required={required}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-4 py-3 border border-[#A7A29A] bg-[#F4F1EC] text-[#0E0E0E] focus:outline-none focus:border-[#0E0E0E] transition-colors resize-y"
      />
    </div>
  );
}


