import { Search, X } from 'lucide-react';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

export const Field = ({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
  className,
}: {
  label?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
  className?: string;
}) => (
  <div className={className}>
    {label && (
      <label htmlFor={htmlFor} className="label">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
    )}
    {children}
    {error ? (
      <p className="mt-1 text-xs text-red-600">{error}</p>
    ) : hint ? (
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    ) : null}
  </div>
);

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: ReactNode; error?: string };

export const Input = forwardRef<HTMLInputElement, InputProps>(({ label, hint, error, className, id, required, ...props }, ref) => {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} required={required}>
      <input
        ref={ref}
        id={inputId}
        required={required}
        aria-invalid={Boolean(error)}
        className={cn('input', error && 'border-red-400', className)}
        {...props}
      />
    </Field>
  );
});
Input.displayName = 'Input';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: ReactNode; error?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, error, className, id, required, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <Field label={label} hint={hint} error={error} htmlFor={inputId} required={required}>
        <textarea ref={ref} id={inputId} required={required} className={cn('input min-h-[88px]', className)} {...props} />
      </Field>
    );
  },
);
Textarea.displayName = 'Textarea';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: ReactNode;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, hint, error, options, placeholder, className, id, required, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <Field label={label} hint={hint} error={error} htmlFor={inputId} required={required}>
        <select ref={ref} id={inputId} required={required} className={cn('input pr-8', className)} {...props}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  },
);
Select.displayName = 'Select';

export const Toggle = ({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) => (
  <label className={cn('flex items-start justify-between gap-4', disabled ? 'opacity-60' : 'cursor-pointer')}>
    <span>
      <span className="block text-sm font-medium text-slate-800">{label}</span>
      {description && <span className="block text-xs text-slate-500">{description}</span>}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-brand-600' : 'bg-slate-300',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5',
        )}
      />
    </button>
  </label>
);

export const SearchInput = ({
  value,
  onChange,
  placeholder = 'Search…',
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) => (
  <div className={cn('relative', className)}>
    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="input pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden"
    />
    {value && (
      <button
        type="button"
        aria-label="Clear search"
        onClick={() => onChange('')}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
      >
        <X className="h-4 w-4" />
      </button>
    )}
  </div>
);

export const FilterSelect = ({
  value,
  onChange,
  options,
  placeholder,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  className?: string;
  ariaLabel?: string;
}) => (
  <select
    value={value}
    aria-label={ariaLabel ?? placeholder}
    onChange={(e) => onChange(e.target.value)}
    className={cn('input w-auto min-w-[140px] pr-8', className)}
  >
    <option value="">{placeholder}</option>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);
