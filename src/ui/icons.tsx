/** Interface icons, drawn for this app (24-unit grid, stroke-based, currentColor). */
import type { ReactElement, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

const icons = {
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
  eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  layers: (p: IconProps) => (
    <Svg {...p}>
      <path d="m12 4 8.5 4.5L12 13 3.5 8.5Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </Svg>
  ),
  lock: (p: IconProps) => (
    <Svg {...p}>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Svg>
  ),
  lockTransparency: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="1" />
      <path d="M4.5 12h15M12 4.5v15" />
      <path d="M4.5 4.5h7.5V12H4.5ZM12 12h7.5v7.5H12Z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  lockPixels: (p: IconProps) => (
    <Svg {...p}>
      <path d="M19.5 4.5 11 13" />
      <path d="M10.8 12.7a2.6 2.6 0 0 1 .5 3.7c-1.3 1.7-3.6 2.6-6.8 2.6.9-1.3.8-2.7 1.5-4 .8-1.6 3.4-3.6 4.8-2.3Z" />
    </Svg>
  ),
  lockPosition: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3.5v17M3.5 12h17" />
      <path d="m9.5 6 2.5-2.5L14.5 6M9.5 18l2.5 2.5 2.5-2.5M6 9.5 3.5 12 6 14.5M18 9.5l2.5 2.5-2.5 2.5" />
    </Svg>
  ),
  folder: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 7V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 19 8h-7l-2-2.5H5A1.5 1.5 0 0 0 3.5 7Z" />
    </Svg>
  ),
  newLayer: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="1.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </Svg>
  ),
  newGroup: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 7V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 19 8h-7l-2-2.5H5A1.5 1.5 0 0 0 3.5 7Z" />
      <path d="M12 11v5.5M9.25 13.75h5.5" />
    </Svg>
  ),
  trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2" />
      <path d="M6.5 6.5 7.5 20h9l1-13.5" />
      <path d="M10.5 10v6.5M13.5 10v6.5" />
    </Svg>
  ),
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, ...rest }: IconProps & { name: IconName }) {
  const Component = icons[name];
  return <Component {...rest} />;
}
