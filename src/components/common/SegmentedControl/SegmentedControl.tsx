import './SegmentedControl.scss';

interface SegmentedControlOption {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  options: SegmentedControlOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function SegmentedControl({ options, value, onChange, disabled = false }: SegmentedControlProps) {
  return (
    <div className={`segmented-control ${disabled ? 'segmented-control--disabled' : ''}`}>
      {options.map((option) => (
        <button
          key={option.value}
          className={`segmented-control__button ${value === option.value ? 'segmented-control__button--active' : ''}`}
          onClick={() => !disabled && onChange(option.value)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
