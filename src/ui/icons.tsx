/** Interface icons, drawn for this app (24-unit grid, stroke-based, currentColor). */
import type { ReactElement, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const icons = {
  hand: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M11 10.5V5a1.5 1.5 0 0 1 3 0v5.5" />
      <path d="M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.6a5 5 0 0 1-3.9-1.9L4.2 14.6a1.4 1.4 0 0 1 2.1-1.9L8 14.2" />
    </Svg>
  ),
  rotateView: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 4.5H5.5V7" />
      <path d="M5.6 6.8A8 8 0 1 1 4 12" />
      <path d="M12 9.5 14.5 12 12 14.5 9.5 12Z" />
    </Svg>
  ),
  zoom: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </Svg>
  ),
  zoomIn: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5M8 10.5h5M10.5 8v5" />
    </Svg>
  ),
  zoomOut: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5M8 10.5h5" />
    </Svg>
  ),
  history: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4.5V8h3.5" />
      <path d="M12 8v4.5l3 1.8" />
    </Svg>
  ),
  navigator: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <rect x="8" y="9" width="7" height="6" rx="0.5" />
    </Svg>
  ),
  close: (p: IconProps) => (
    <Svg {...p}>
      <path d="m7 7 10 10M17 7 7 17" />
    </Svg>
  ),
  menu: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 8h14M5 12h14M5 16h14" />
    </Svg>
  ),
  collapse: (p: IconProps) => (
    <Svg {...p}>
      <path d="m7 7 5 5-5 5M13 7l5 5-5 5" />
    </Svg>
  ),
  expand: (p: IconProps) => (
    <Svg {...p}>
      <path d="m11 7-5 5 5 5M17 7l-5 5 5 5" />
    </Svg>
  ),
  open: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18V9.5A1.5 1.5 0 0 0 18.5 8H12l-2-2.5H5.5A1.5 1.5 0 0 0 4 7Z" />
    </Svg>
  ),
  check: (p: IconProps) => (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  ),
  chevronRight: (p: IconProps) => (
    <Svg {...p}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  ),
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, ...rest }: IconProps & { name: IconName }) {
  const Component = icons[name];
  return <Component {...rest} />;
}
