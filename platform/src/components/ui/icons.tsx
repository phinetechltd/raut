import type { CSSProperties } from "react";

/**
 * Console icon set — single-weight 24px stroke glyphs, drawn to share one
 * 1.8px stroke, 2px terminals and rounded joins so the set reads as one
 * family. No icon library: fifteen glyphs we own, sized by the caller.
 */

export interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function svg(
  children: React.ReactNode,
): (props: IconProps) => React.ReactNode {
  return function Icon({ size = 16, className, style }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className}
        style={style}
      >
        {children}
      </svg>
    );
  };
}

export const DashboardIcon = svg(
  <>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="5" rx="2" />
    <rect x="13" y="10" width="8" height="11" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
  </>,
);

export const CustomersIcon = svg(
  <>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <circle cx="17" cy="9.5" r="2.6" />
    <path d="M16 14.6c2.3.3 3.9 1.8 4.4 4.2" />
  </>,
);

export const SalesIcon = svg(
  <>
    <path d="M4 5h2l2.3 10.5a1.6 1.6 0 0 0 1.6 1.3h7.4a1.6 1.6 0 0 0 1.6-1.3L20.4 9H7" />
    <circle cx="10.5" cy="20" r="1.4" />
    <circle cx="17.5" cy="20" r="1.4" />
  </>,
);

export const InventoryIcon = svg(
  <>
    <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" />
    <path d="M3.7 7.6 12 12l8.3-4.4" />
    <path d="M12 12v9" />
  </>,
);

export const ProcurementIcon = svg(
  <>
    <path d="M3 7h11v9H5a2 2 0 0 1-2-2V7Z" />
    <path d="M14 10h4l3 3v3h-7v-6Z" />
    <circle cx="7" cy="18.5" r="1.8" />
    <circle cx="17.5" cy="18.5" r="1.8" />
  </>,
);

export const FinanceIcon = svg(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3 9.5h18" />
    <path d="M7 14.5h4" />
  </>,
);

export const FieldIcon = svg(
  <>
    <path d="M12 21s6.7-5.4 6.7-10.5A6.7 6.7 0 0 0 12 4a6.7 6.7 0 0 0-6.7 6.5C5.3 15.6 12 21 12 21Z" />
    <circle cx="12" cy="10.5" r="2.3" />
  </>,
);

export const RoutesIcon = svg(
  <>
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="5" r="2.2" />
    <path d="M8 17.5 10 14a3.5 3.5 0 0 1 4.6-1.4L16 12" strokeDasharray="3 2.6" />
  </>,
);

export const SmsIcon = svg(
  <>
    <path d="M4 5.5h16v11H9l-5 4v-15Z" />
    <path d="M8 9.5h8M8 12.5h5" />
  </>,
);

export const ReportsIcon = svg(
  <>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8.5 16v-5M12.5 16V8M16.5 16v-3.5" />
  </>,
);

export const SettingsIcon = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.6M12 18.6v2.6M4.7 4.7l1.8 1.8M17.4 17.4l1.9 1.9M2.8 12h2.6M18.6 12h2.6M4.7 19.3l1.8-1.9M17.4 6.5l1.9-1.8" />
  </>,
);

export const PlatformIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
);

export const SearchIcon = svg(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16.2 16.2 4.3 4.3" />
  </>,
);

export const PlusIcon = svg(<path d="M12 5v14M5 12h14" />);

export const EditIcon = svg(
  <>
    <path d="M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17 4 20Z" />
    <path d="m14.5 6.5 3 3" />
  </>,
);

export const TrashIcon = svg(
  <>
    <path d="M4 6.5h16" />
    <path d="M9 6.5v-2a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v2" />
    <path d="M6.5 6.5 7.5 21h9l1-14.5" />
    <path d="M10 10.5v6M14 10.5v6" />
  </>,
);

export const CloseIcon = svg(<path d="m6 6 12 12M18 6 6 18" />);

export const CheckIcon = svg(<path d="m4.5 12.5 5 5 10-11" />);

export const DownloadIcon = svg(
  <>
    <path d="M12 4v11" />
    <path d="m7 11 5 5 5-5" />
    <path d="M4 20h16" />
  </>,
);

export const ChevronDownIcon = svg(<path d="m6 9 6 6 6-6" />);

export const ChevronLeftIcon = svg(<path d="m15 5-7 7 7 7" />);

export const ChevronRightIcon = svg(<path d="m9 5 7 7-7 7" />);

export const SortIcon = (props: IconProps) => {
  const size = props.size ?? 12;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={props.className}
      style={props.style}
    >
      <path d="M12 4.5 17 10H7Z" />
      <path d="M12 19.5 7 14h10Z" />
    </svg>
  );
};

export const ArrowUpIcon = (props: IconProps) => (
  <svg width={props.size ?? 12} height={props.size ?? 12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={props.className}>
    <path d="M12 4.5 17 10H7Z" />
  </svg>
);

export const ArrowDownIcon = (props: IconProps) => (
  <svg width={props.size ?? 12} height={props.size ?? 12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={props.className}>
    <path d="M12 19.5 7 14h10Z" />
  </svg>
);

export const MapIcon = svg(
  <>
    <path d="M9 3.5 3.5 6v14L9 17.5l6 2.5 5.5-2.5v-14L15 6 9 3.5Z" />
    <path d="M9 3.5v14M15 6v14" />
  </>,
);

export const UsersIcon = CustomersIcon;
