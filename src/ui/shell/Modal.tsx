/** The modal dialog frame: title, focus kept inside, Escape cancels. */
import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({
  title,
  children,
  onCancel,
  className,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onCancel, so the keyboard handler (installed once) never calls a stale one.
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  });
  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel.current();
      } else if (e.key === 'Tab' && el) {
        // Keep focus inside the dialog.
        const focusable = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex="0"]')].filter(
          (f) => !f.hasAttribute('disabled'),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
