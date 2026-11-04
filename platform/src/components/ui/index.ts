/**
 * The Raut component library.
 *
 * Pages import from here, never from the individual files — that keeps the
 * public surface of the library explicit and makes a component's home an
 * implementation detail we can move.
 */

export {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  Divider,
  EmptyState,
  Field,
  FilterTabs,
  Input,
  PageHeader,
  SectionHeading,
  Select,
  Skeleton,
  StatusBadge,
  Textarea,
  Toolbar,
  cx,
  type Tone,
} from "./primitives";

export { CellStack, DataTable, type Column, type TableSort, type TablePagination } from "./data-table";

export {
  DateRangeBar,
  ExportLink,
  FilterBar,
  FilterSearch,
  FilterSelect,
  type FilterOption,
} from "./filters";

export * from "./icons";

export { TileMap } from "./tile-map";
export type { MapTrack, TileMapProps } from "./map-shared";

export { Modal, ModalButton } from "./modal";

export { apiClient, useFormSubmit } from "./crud";

export {
  Can,
  CanOrUpgrade,
  LockedHint,
  ModuleLocked,
  ReadOnlyNotice,
} from "./permission";

export {
  BarChart,
  CategoryBreakdown,
  GeoMap,
  Meter,
  Money,
  RankedBars,
  StatCard,
  StatGrid,
  type BarDatum,
  type MapPoint,
  type SeriesDatum,
} from "./data-display";
