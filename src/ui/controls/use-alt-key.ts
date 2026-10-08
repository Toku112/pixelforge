/** Whether Alt/Option is held (dialogs turn Cancel into Reset meanwhile). */
import { useEffect, useState } from 'react';

export function useAltKey(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => setHeld(e.altKey);
    const blur = () => setHeld(false);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return held;
}
