import { useEffect } from "react";

/** Short message above the bottom bar; disappears by itself (tap closes it sooner). */
export function Toast({ text, onClose, ms = 3500 }: { text: string; onClose: () => void; ms?: number }) {
  useEffect(() => {
    const id = setTimeout(onClose, ms);
    return () => clearTimeout(id);
  }, [text, ms]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="toast-float" role="status" aria-live="polite" onClick={onClose} data-testid="toast">
      {text}
    </div>
  );
}
