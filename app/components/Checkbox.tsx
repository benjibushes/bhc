interface CheckboxProps {
  label: string;
  name: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
}

export default function Checkbox({
  label,
  name,
  checked,
  onChange,
  required = false
}: CheckboxProps) {
  return (
    <div className="flex items-start">
      <input
        type="checkbox"
        id={name}
        name={name}
        checked={checked}
        onChange={onChange}
        required={required}
        className="mt-1 mr-3 w-4 h-4 border-[#A7A29A] text-[#0E0E0E] focus:ring-0"
      />
      <label htmlFor={name} className="text-sm leading-relaxed cursor-pointer">
        {label}
      </label>
    </div>
  );
}
