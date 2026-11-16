import { useId, useRef } from 'react';

import { Icon } from './Icon';
import styles from './ResponsiveSelect.module.css';

interface SelectOption {
  value: string;
  label: string;
}

interface ResponsiveSelectProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  field?: string;
}

export function ResponsiveSelect({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
  invalid,
  id,
  field,
}: ResponsiveSelectProps) {
  const dialogId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const selectedOption = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);

  return (
    <div className={styles.root}>
      <div className={styles.desktop}>
        <select
          id={id}
          className={className}
          aria-label={label}
          aria-invalid={invalid}
          data-field={field}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className={styles.trigger}
        aria-label={`${label}，${selected?.label ?? '请选择'}`}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-invalid={invalid}
        disabled={disabled}
        onClick={() => {
          dialog.current?.showModal();
          selectedOption.current?.focus();
        }}
      >
        <span>{selected?.label ?? '请选择'}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <dialog
        ref={dialog}
        id={dialogId}
        className={styles.dialog}
        aria-labelledby={`${dialogId}-title`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <h2 id={`${dialogId}-title`}>{label}</h2>
            <button
              type="button"
              className={styles.close}
              onClick={() => dialog.current?.close()}
              aria-label="关闭选择"
            >
              <Icon name="x" />
            </button>
          </header>
          <ul className={styles.options}>
            {options.map((option) => (
              <li key={option.value}>
                <button
                  ref={option === selected ? selectedOption : undefined}
                  type="button"
                  className={styles.option}
                  aria-current={option === selected ? 'true' : undefined}
                  onClick={() => {
                    dialog.current?.close();
                    if (option !== selected) onChange(option.value);
                  }}
                >
                  <span>{option.label}</span>
                  {option === selected ? <span className={styles.selected}>已选</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </dialog>
    </div>
  );
}
