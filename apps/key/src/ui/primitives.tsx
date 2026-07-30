import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function IconButton({
  icon,
  label,
  selected,
  className = '',
  ...props
}: {
  icon: IconName;
  label: string;
  selected?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`key-icon-button ${selected ? 'selected' : ''} ${className}`}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Button({
  icon,
  tone = 'neutral',
  children,
  className = '',
  ...props
}: {
  icon?: IconName;
  tone?: 'neutral' | 'accent' | 'danger';
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`key-button ${tone} ${className}`}
      {...props}
    >
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </button>
  );
}

export function PanelShell({
  title,
  detail,
  icon,
  onClose,
  children,
  className = '',
}: {
  title: string;
  detail?: string;
  icon?: IconName;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside className={`key-panel-shell ${className}`}>
      <header className="key-panel-header">
        {icon && (
          <span className="key-panel-icon">
            <Icon name={icon} />
          </span>
        )}
        <div>
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </div>
        <IconButton icon="close" label={`Close ${title}`} onClick={onClose} />
      </header>
      <div className="key-panel-content">{children}</div>
    </aside>
  );
}

export function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: IconName;
  title: string;
  detail: string;
}) {
  return (
    <div className="key-empty-state">
      <span><Icon name={icon} /></span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}
