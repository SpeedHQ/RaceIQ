import type { ComponentProps, ComponentType } from "react";
import type { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { GameId } from "@raceiq/shared/games/ids";
import type { Car } from "./car";

export type CarsCatalogueMessageKey =
  | "cars_price"
  | "cars_compare_modal_title"
  | "cars_stat_column"
  | "acccars_all_classes"
  | "acccars_car_count_label"
  | "acccars_no_match"
  | "acevocars_filter_all"
  | "acevocars_loading"
  | "cars_accel_imperial_long"
  | "cars_accel_imperial_short"
  | "cars_accel_metric_long"
  | "cars_accel_metric_short"
  | "cars_accel_rating"
  | "cars_aspiration"
  | "cars_brake_60"
  | "cars_brake_60_label"
  | "cars_braking_rating"
  | "cars_col_brk60"
  | "cars_col_car"
  | "cars_col_division"
  | "cars_col_wt"
  | "cars_compare_button"
  | "cars_division"
  | "cars_drive_label"
  | "cars_drivetrain"
  | "cars_engine"
  | "cars_forza_wiki"
  | "cars_front_weight"
  | "cars_gears"
  | "cars_handling_rating"
  | "cars_hp"
  | "cars_lateral_g"
  | "cars_loading"
  | "cars_no_image"
  | "cars_no_match"
  | "cars_no_stats"
  | "cars_performance"
  | "cars_pi"
  | "cars_quarter_mile"
  | "cars_rating_acc"
  | "cars_rating_accel"
  | "cars_rating_brk"
  | "cars_rating_hdl"
  | "cars_rating_spd"
  | "cars_ratings"
  | "cars_search_placeholder"
  | "cars_selected"
  | "cars_speed_rating"
  | "cars_top_spd_label"
  | "cars_top_speed"
  | "cars_torque"
  | "cars_torque_label"
  | "cars_view_3d_model"
  | "cars_weight"
  | "cars_weight_label"
  | "common_clear"
  | "common_close"
  | "common_no_image"
  | "f1cars_aero_efficiency"
  | "f1cars_corner_speed"
  | "f1cars_overall"
  | "f1cars_power_units"
  | "f1cars_regulations"
  | "f1cars_reliability"
  | "f1cars_straight_speed"
  | "f1cars_traction"
  | "iracingcars_all_categories"
  | "iracingcars_category_dirt_oval"
  | "iracingcars_category_dirt_road"
  | "iracingcars_category_discovered"
  | "iracingcars_category_formula_car"
  | "iracingcars_category_oval"
  | "iracingcars_category_sports_car"
  | "iracingcars_headlights"
  | "iracingcars_multiple_dry_tires"
  | "iracingcars_rain_ready"
  | "label_base"
  | "label_braking"
  | "label_chassis"
  | "label_drivers"
  | "label_grid_view"
  | "label_handling"
  | "label_pace"
  | "label_power_unit"
  | "label_speed"
  | "label_table_view"
  | "label_team"
  | "label_team_principal";
export type CarsCatalogueMessages = Record<CarsCatalogueMessageKey, () => string>;

export interface AccCatalogueCar {
  id: number;
  name: string;
  class: string;
  specs: { maxRpm: number; hp: number; weightKg: number; engine: string; drivetrain: string } | null;
}
export interface AcEvoCatalogueCar { id: string; name: string; class: string }
export interface IRacingCatalogueCar {
  id: string; name: string; shortName?: string | null; path: string; category: string; imageUrl: string;
  hp?: number | null; weightLb?: number | null; hasHeadlights?: boolean | null;
  rainEnabled?: boolean | null; hasMultipleDryTireTypes?: boolean | null; searchTerms?: string | null;
}
export interface LMUCatalogueCar { id: string; name: string; class?: string; series?: string[]; imageUrl?: string }

export interface CarsCatalogueHost {
  m: CarsCatalogueMessages;
  getLocale: () => string;
  useRequiredGameId: () => GameId;
  useUnits: () => { unit: "metric" | "imperial"; speedLabel: string; fromMph: (mph: number) => number };
  loadCarModelConfigs: () => Promise<void>;
  getCarModel: (id: string) => { hasModel: boolean };
  loadCars: (gameId: GameId) => Promise<Car[]>;
  loadAccCars: () => Promise<AccCatalogueCar[]>;
  loadAcEvoCars: () => Promise<AcEvoCatalogueCar[]>;
  loadIRacingCars: (gameId?: "iracing" | "ams2") => Promise<IRacingCatalogueCar[]>;
  loadLMUCars: () => Promise<LMUCatalogueCar[]>;
  PiBadge: ComponentType<{ pi: number; showNumber?: boolean }>;
  AppInput: ComponentType<ComponentProps<"input">>;
  SearchSelect: ComponentType<{
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
    placeholder?: string;
    ariaLabel?: string;
    className?: string;
  }>;
  Button: ComponentType<ButtonPrimitive.Props & {
    variant?: "app-ghost" | "app-primary" | "app-outline" | "close-action" | "selected-toggle";
    size?: "icon-sm" | "app-sm";
  }>;
  Badge: ComponentType<ComponentProps<"span"> & { variant?: "catalog-category"; size?: "default" | "compact" }>;
  Dialog: ComponentType<DialogPrimitive.Root.Props>;
  DialogContent: ComponentType<DialogPrimitive.Popup.Props & { size?: "lg" | "wide"; showCloseButton?: boolean }>;
  DialogHeader: ComponentType<ComponentProps<"div">>;
  DialogTitle: ComponentType<DialogPrimitive.Title.Props>;
  Table: ComponentType<ComponentProps<"table">>;
  TableBody: ComponentType<ComponentProps<"tbody">>;
  TableCell: ComponentType<ComponentProps<"td">>;
  TableHead: ComponentType<ComponentProps<"th">>;
  TableHeader: ComponentType<ComponentProps<"thead">>;
  TableRow: ComponentType<ComponentProps<"tr">>;
  SortableTableHead: ComponentType<Omit<ComponentProps<"th">, "onClick" | "aria-sort"> & {
    direction?: "ascending" | "descending";
    onSort: () => void;
  }>;
}
