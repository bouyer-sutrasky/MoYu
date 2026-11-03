import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';

import { Icon } from './Icon';
import styles from './Modal.module.css';

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

export function Modal({ title, description, onClose, children, wide = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={clsx(styles.panel, wide && styles.wide)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>{title}</h2>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
