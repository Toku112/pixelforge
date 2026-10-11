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
  chevronDown: (p: IconProps) => (
    <Svg {...p}>
      <path d="m7 10 5 5 5-5" />
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
  marqueeRect: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4.5" y="5.5" width="15" height="13" strokeDasharray="2.5 2" />
    </Svg>
  ),
  marqueeEllipse: (p: IconProps) => (
    <Svg {...p}>
      <ellipse cx="12" cy="12" rx="8" ry="6.5" strokeDasharray="2.5 2" />
    </Svg>
  ),
  marqueeRow: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 12h17" strokeDasharray="2.5 2" />
      <path d="M3.5 8v8M20.5 8v8" />
    </Svg>
  ),
  marqueeColumn: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3.5v17" strokeDasharray="2.5 2" />
      <path d="M8 3.5h8M8 20.5h8" />
    </Svg>
  ),
  lasso: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8.5 15.5C5.6 14.6 4 12.9 4 10.8 4 7.6 7.6 5 12 5s8 2.6 8 5.8-3.6 5.7-8 5.7c-.9 0-1.8-.1-2.6-.3" />
      <path d="M9.5 15.6c-1.5.4-2.3 1.4-1.8 2.5.4 1 1.8 1.4 2.8.6 1-.7.6-2.2-1-3.1Z" />
      <path d="M9.4 18.6 8 21" />
    </Svg>
  ),
  polygonalLasso: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8.5 15.5 4 9l7-4.5 9 3.5-2 7.5-7.5.5" />
      <path d="M9.5 15.6c-1.5.4-2.3 1.4-1.8 2.5.4 1 1.8 1.4 2.8.6 1-.7.6-2.2-1-3.1Z" />
      <path d="M9.4 18.6 8 21" />
    </Svg>
  ),
  selectionNew: (p: IconProps) => (
    <Svg {...p}>
      <rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor" fillOpacity="0.35" />
    </Svg>
  ),
  selectionAdd: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 3.5h11v6h6v11h-11v-6h-6Z" fill="currentColor" fillOpacity="0.35" />
    </Svg>
  ),
  selectionSubtract: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 3.5h11v6h-5v5h-6Z" fill="currentColor" fillOpacity="0.35" />
      <rect x="9.5" y="9.5" width="11" height="11" />
    </Svg>
  ),
  selectionIntersect: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="11" height="11" />
      <rect x="9.5" y="9.5" width="11" height="11" />
      <rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" fillOpacity="0.5" stroke="none" />
    </Svg>
  ),
  crop: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 2.5V17h14.5" />
      <path d="M2.5 7H17v14.5" />
    </Svg>
  ),
  transform: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6h12v12H6Z" />
      <path d="M4 4h4v4H4ZM16 4h4v4h-4ZM16 16h4v4h-4ZM4 16h4v4H4Z" fill="currentColor" strokeWidth={1} />
    </Svg>
  ),
  link: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  ),
  cancelCircle: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="m6.5 17.5 11-11" />
    </Svg>
  ),
  swap: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 9h15l-3.5-3.5M20 15H5l3.5 3.5" />
    </Svg>
  ),
  move: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 3.5 5 17l3.5-3.2 2.4 5.5 2.6-1.1-2.4-5.4 4.9-.3Z" />
      <path d="M17 13.5v7M13.5 17h7" />
    </Svg>
  ),
  brush: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 3.5 11.5 12" />
      <path d="M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z" />
      <path d="m14 9 1.5 1.5" />
    </Svg>
  ),
  historyBrush: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 3.5 11.5 12" />
      <path d="M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z" />
      <path d="M3.6 6.6a3 3 0 1 0 .9-2.2" />
      <path d="M4.3 2.6v1.9h1.9" />
    </Svg>
  ),
  artHistoryBrush: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 3.5 11.5 12" />
      <path d="M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z" />
      <path d="M3.5 8.5c0-2.8 1.7-5 3.8-5 1.6 0 2.6 1.1 2.6 2.4 0 1.1-.8 1.9-1.8 1.9-.9 0-1.5-.6-1.5-1.4" />
    </Svg>
  ),
  mixerBrush: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 3.5 11.5 12" />
      <path d="M11 11.5c1.4 1.2 1.7 3 .6 4.4-1.6 2.1-4.4 3.3-8.1 3.6 1.2-1.6 1.1-3.4 2-5 .9-1.8 3.7-4.4 5.5-3Z" />
      <path d="M18 13.5c1.1 1.5 1.7 2.6 1.7 3.4a1.7 1.7 0 0 1-3.4 0c0-.8.6-1.9 1.7-3.4Z" />
    </Svg>
  ),
  /** Load the brush after each stroke: a drop going into the brush. */
  mixerLoad: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 13.5 7.5 20" />
      <path d="M8 19.5c-1-1-1.2-2.4-.4-3.4 1.2-1.6 3.4-2.5 6.2-2.8-.9 1.2-.8 2.6-1.5 3.9-.7 1.4-2.9 3.4-4.3 2.3Z" />
      <path d="M8 3c1.4 2 2.2 3.4 2.2 4.4a2.2 2.2 0 0 1-4.4 0C5.8 6.4 6.6 5 8 3Z" />
      <path d="M17 4v5M14.5 6.5h5" />
    </Svg>
  ),
  /** Clean the brush after each stroke: the brush in a jar of water. */
  mixerClean: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 11h14l-1.4 8.2a1.6 1.6 0 0 1-1.6 1.3H8a1.6 1.6 0 0 1-1.6-1.3Z" />
      <path d="M6 15c2 1 4-1 6 0s4 1 6 0" />
      <path d="M14.5 3 12 13" />
    </Svg>
  ),
  dodge: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="14" cy="8" r="5" />
      <path d="m10.5 11.5-7 9" />
    </Svg>
  ),
  burn: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 2.5c3.5 4 6 6.8 6 10.5a6 6 0 0 1-12 0c0-2.3 1.2-4.1 2.6-5.6.1 1.6.8 2.8 2 3.4-.3-3 .4-5.6 1.4-8.3Z" />
      <path d="M12 20.5a2.6 2.6 0 0 1-2.6-2.6c0-1.6 1.2-2.6 2.6-4.2 1.4 1.6 2.6 2.6 2.6 4.2a2.6 2.6 0 0 1-2.6 2.6Z" />
    </Svg>
  ),
  sponge: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 7.5c2-1.5 4-1.5 7 0s5 1.5 7 0v9c-2 1.5-4 1.5-7 0s-5-1.5-7 0Z" />
      <path d="M9 10.5h.01M14 11.5h.01M11 14h.01M16 14.5h.01M8 13.5h.01" strokeWidth={2.2} />
    </Svg>
  ),
  eraser: (p: IconProps) => (
    <Svg {...p}>
      <path d="m4 15.5 9-9a2 2 0 0 1 2.8 0l3.7 3.7a2 2 0 0 1 0 2.8L13 19.5H8Z" />
      <path d="M8.5 11 13 15.5M8 19.5h12" />
    </Svg>
  ),
  penPressure: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15.5 3.5 20.5 8.5 9 20H4v-5Z" />
      <path d="M13 6l5 5" />
      <circle cx="18.5" cy="18.5" r="2" fill="currentColor" fillOpacity="0.5" />
    </Svg>
  ),
  penPressureSize: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15.5 3.5 20.5 8.5 9 20H4v-5Z" />
      <path d="M13 6l5 5" />
      <circle cx="19" cy="19" r="1" />
      <circle cx="19" cy="19" r="3" />
    </Svg>
  ),
  pencil: (p: IconProps) => (
    <Svg {...p}>
      <path d="M16.5 3.5 20.5 7.5 9 19H5v-4Z" />
      <path d="M14 6l4 4M5 15l4 4" />
    </Svg>
  ),
  patternStamp: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 3.5h6v3.5l-1.5 3h-3L9 7Z" />
      <path d="M5 13.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V15H5Z" />
      <path d="M5.5 18.5h2M9 18.5h2M12.5 18.5h2M16 18.5h2.5" />
    </Svg>
  ),
  pattern: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <rect x="6" y="6" width="4" height="4" fill="currentColor" fillOpacity="0.7" stroke="none" />
      <rect x="14" y="6" width="4" height="4" fill="currentColor" fillOpacity="0.7" stroke="none" />
      <rect x="10" y="10" width="4" height="4" fill="currentColor" fillOpacity="0.7" stroke="none" />
      <rect x="6" y="14" width="4" height="4" fill="currentColor" fillOpacity="0.7" stroke="none" />
      <rect x="14" y="14" width="4" height="4" fill="currentColor" fillOpacity="0.7" stroke="none" />
    </Svg>
  ),
  paintBucket: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.5 4 19 12.5l-6.4 6.4a1.6 1.6 0 0 1-2.2 0l-5.8-5.8a1.6 1.6 0 0 1 0-2.2Z" />
      <path d="M7.3 8.2C5 5.9 4.4 4 5.4 3s3-.4 5.3 1.9" />
      <path d="M5.2 12.2h13.4" />
      <path d="M20.5 15c1 1.4 1.6 2.4 1.6 3.2a1.6 1.6 0 0 1-3.2 0c0-.8.6-1.8 1.6-3.2Z" fill="currentColor" />
    </Svg>
  ),
  gradient: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M7 6v12" strokeOpacity="0.95" />
      <path d="M10.5 6v12" strokeOpacity="0.7" />
      <path d="M14 6v12" strokeOpacity="0.45" />
      <path d="M17.5 6v12" strokeOpacity="0.2" />
    </Svg>
  ),
  gradientLinear: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" />
      <rect x="4" y="4" width="4" height="16" fill="currentColor" fillOpacity="0.9" stroke="none" />
      <rect x="8" y="4" width="4" height="16" fill="currentColor" fillOpacity="0.6" stroke="none" />
      <rect x="12" y="4" width="4" height="16" fill="currentColor" fillOpacity="0.3" stroke="none" />
    </Svg>
  ),
  gradientRadial: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" />
      <circle cx="12" cy="12" r="7" fill="currentColor" fillOpacity="0.25" stroke="none" />
      <circle cx="12" cy="12" r="4.5" fill="currentColor" fillOpacity="0.45" stroke="none" />
      <circle cx="12" cy="12" r="2" fill="currentColor" fillOpacity="0.9" stroke="none" />
    </Svg>
  ),
  gradientAngle: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" />
      <path d="M12 12 20 12 20 4 12 4Z" fill="currentColor" fillOpacity="0.2" stroke="none" />
      <path d="M12 12 12 4 4 4 4 12Z" fill="currentColor" fillOpacity="0.4" stroke="none" />
      <path d="M12 12 4 12 4 20 12 20Z" fill="currentColor" fillOpacity="0.65" stroke="none" />
      <path d="M12 12 12 20 20 20 20 12Z" fill="currentColor" fillOpacity="0.9" stroke="none" />
    </Svg>
  ),
  gradientReflected: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" />
      <rect x="10" y="4" width="4" height="16" fill="currentColor" fillOpacity="0.9" stroke="none" />
      <rect x="6.5" y="4" width="3.5" height="16" fill="currentColor" fillOpacity="0.5" stroke="none" />
      <rect x="14" y="4" width="3.5" height="16" fill="currentColor" fillOpacity="0.5" stroke="none" />
    </Svg>
  ),
  gradientDiamond: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" />
      <path d="M12 4.5 19.5 12 12 19.5 4.5 12Z" fill="currentColor" fillOpacity="0.25" stroke="none" />
      <path d="M12 8 16 12 12 16 8 12Z" fill="currentColor" fillOpacity="0.85" stroke="none" />
    </Svg>
  ),
  eyedropper: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14.5 4.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3l-2 2-5-5Z" />
      <path d="m13 8-8.2 8.2-.8 3.8 3.8-.8L16 11" />
    </Svg>
  ),
  symmetry: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 4v16" strokeDasharray="2 2" />
      <path d="M11 11C9 6.5 6 5 4 5.5c-1.5.5-1 4 1 5.5 1 .7 2.5 1 3.5 1-1.5.5-3 2-2.5 3.5.5 2 3.5 1.5 5-1.5" />
      <path d="M13 11c2-4.5 5-6 7-5.5 1.5.5 1 4-1 5.5-1 .7-2.5 1-3.5 1 1.5.5 3 2 2.5 3.5-.5 2-3.5 1.5-5-1.5" />
    </Svg>
  ),
  colorPanel: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17M3.5 12h17" strokeOpacity="0.5" />
      <circle cx="15" cy="9" r="2" fill="currentColor" />
    </Svg>
  ),
  swatches: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" fill="currentColor" fillOpacity="0.4" />
      <rect x="4" y="13" width="7" height="7" rx="1" fill="currentColor" fillOpacity="0.7" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </Svg>
  ),
  toolPresets: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </Svg>
  ),
  gear: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" />
      <circle cx="12" cy="12" r="6.3" />
    </Svg>
  ),
  brushSettings: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M7 9.5h10M7 14.5h10" />
      <circle cx="10" cy="9.5" r="1.6" fill="currentColor" />
      <circle cx="14.5" cy="14.5" r="1.6" fill="currentColor" />
    </Svg>
  ),
  airbrush: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 15.5 10.5 9l4.5 4.5L8.5 20Z" />
      <path d="M12.5 11 15 8.5" />
      <circle cx="17" cy="6.5" r="0.7" fill="currentColor" />
      <circle cx="19.5" cy="9" r="0.7" fill="currentColor" />
      <circle cx="19.5" cy="4.5" r="0.7" fill="currentColor" />
      <circle cx="15" cy="4" r="0.7" fill="currentColor" />
    </Svg>
  ),
  angle: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 19h16M4 19 15 6" />
      <path d="M10.5 19a6.5 6.5 0 0 0-2.1-4.8" />
    </Svg>
  ),
  swapColors: (p: IconProps) => (
    <Svg {...p} strokeWidth={2}>
      <path d="M5 9a7 7 0 0 1 10-5" />
      <path d="m13 2 2 2-2 2M19 15a7 7 0 0 1-10 5" />
      <path d="m11 22-2-2 2-2" />
    </Svg>
  ),
  defaultColors: (p: IconProps) => (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" fill="#fff" stroke="#000" />
      <rect x="4" y="4" width="11" height="11" fill="#000" stroke="#fff" />
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
