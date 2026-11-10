import type { SVGProps } from 'react';

export type IconName =
  | 'menu'
  | 'panel'
  | 'bell'
  | 'settings'
  | 'work'
  | 'chat'
  | 'plus'
  | 'x'
  | 'key'
  | 'session'
  | 'logout'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'chevron-down'
  | 'cloud'
  | 'branch'
  | 'task'
  | 'file';

const paths: Record<IconName, string[]> = {
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  panel: ['M4 5h16v14H4z', 'M15 5v14'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
  settings: [
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.32a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64 1.7 1.7 0 0 0 10.03 3.08V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9v.01A1.7 1.7 0 0 0 20.92 10H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z',
  ],
  work: ['M4 7h16v12H4z', 'M9 7V5h6v2', 'M4 12h16'],
  chat: ['M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'],
  plus: ['M12 5v14', 'M5 12h14'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  key: [
    'M21 2l-2 2',
    'M15.5 8.5 21 3',
    'M10.5 13.5 14 10l-4-4',
    'M10.5 13.5a4 4 0 1 1-5.66 5.66 4 4 0 0 1 5.66-5.66z',
  ],
  session: ['M4 5h16v14H4z', 'M8 9h8', 'M8 13h5'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  sun: [
    'M12 4V2',
    'M12 22v-2',
    'M4 12H2',
    'M22 12h-2',
    'M5 5l-1.5-1.5',
    'M20.5 20.5 19 19',
    'M19 5l1.5-1.5',
    'M3.5 20.5 5 19',
    'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  ],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z'],
  monitor: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  'chevron-down': ['M6 9l6 6 6-6'],
  cloud: ['M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1 .5 9z'],
  branch: [
    'M6 3v12',
    'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M18 9a9 9 0 0 1-9 9',
  ],
  task: ['M9 5h11', 'M9 12h11', 'M9 19h11', 'M4 5h.01', 'M4 12h.01', 'M4 19h.01'],
};

export function Icon({
  name,
  size = 18,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
