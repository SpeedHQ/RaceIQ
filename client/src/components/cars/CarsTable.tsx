import { Fragment } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { m } from "@/paraglide/messages";
import { CarDetail } from "./CarDetail";
import { piClass } from "./helpers";
import type { Car, Formatters, SortKey } from "./types";

type CarsTableProps = {
  cars: Car[];
  selected: Set<number>;
  expanded: Set<number>;
  sort: SortKey;
  sortDir: 1 | -1;
  isMetric: boolean;
  speedLabel: string;
  onSort: (key: SortKey) => void;
  onSelect: (ordinal: number) => void;
  onExpand: (ordinal: number) => void;
} & Formatters;

export function CarsTable({ cars, selected, expanded, sort, sortDir, isMetric, speedLabel, onSort, onSelect, onExpand, fmtSpeed, fmtBrake, fmtWeight }: CarsTableProps) {
  const direction = (key: SortKey) => (sort === key ? (sortDir === 1 ? "ascending" : "descending") : undefined);
  return (
    <Table className="text-app-compact [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5">
      <TableHeader>
        <TableRow>
          <TableHead />
          <SortableTableHead direction={direction("name")} onSort={() => onSort("name")}>{m.cars_col_car()}</SortableTableHead>
          <SortableTableHead direction={direction("pi")} onSort={() => onSort("pi")}>PI</SortableTableHead>
          <SortableTableHead direction={direction("hp")} onSort={() => onSort("hp")}>HP</SortableTableHead>
          <SortableTableHead direction={direction("torque")} onSort={() => onSort("torque")}>{m.cars_torque_label()}</SortableTableHead>
          <SortableTableHead direction={direction("weightKg")} onSort={() => onSort("weightKg")}>{m.cars_col_wt()} ({isMetric ? "kg" : "lb"})</SortableTableHead>
          <TableHead>{m.cars_drive_label()}</TableHead>
          <SortableTableHead direction={direction("topSpeedMph")} onSort={() => onSort("topSpeedMph")}>{m.cars_top_spd_label()} ({speedLabel})</SortableTableHead>
          <SortableTableHead direction={direction("zeroToSixty")} onSort={() => onSort("zeroToSixty")}>0–60</SortableTableHead>
          <SortableTableHead direction={direction("zeroToHundred")} onSort={() => onSort("zeroToHundred")}>0–100</SortableTableHead>
          <SortableTableHead direction={direction("braking60")} onSort={() => onSort("braking60")}>{m.cars_col_brk60()} ({isMetric ? "m" : "ft"})</SortableTableHead>
          <SortableTableHead direction={direction("speedRating")} onSort={() => onSort("speedRating")}>{m.cars_rating_spd()}</SortableTableHead>
          <SortableTableHead direction={direction("brakingRating")} onSort={() => onSort("brakingRating")}>{m.cars_rating_brk()}</SortableTableHead>
          <SortableTableHead direction={direction("handlingRating")} onSort={() => onSort("handlingRating")}>{m.cars_rating_hdl()}</SortableTableHead>
          <SortableTableHead direction={direction("accelRating")} onSort={() => onSort("accelRating")}>{m.cars_rating_acc()}</SortableTableHead>
          <SortableTableHead direction={direction("division")} onSort={() => onSort("division")}>{m.cars_col_division()}</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cars.length === 0 ? (
          <TableRow>
            <TableCell className="text-center text-app-text" colSpan={16}>
              <div className="py-10">{m.cars_no_match()}</div>
            </TableCell>
          </TableRow>
        ) : (
          cars.map((car) => (
            <Fragment key={car.ordinal}>
              <TableRow onClick={() => onExpand(car.ordinal)} data-state={selected.has(car.ordinal) ? "selected" : undefined}>
                <TableCell className="text-center">
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selected.has(car.ordinal)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => onSelect(car.ordinal)}
                      className="w-3.5 h-3.5 accent-app-accent cursor-pointer"
                    />
                  </div>
                </TableCell>
                <TableCell><span className="text-xs text-app-text/90 truncate">{car.name}</span></TableCell>
                <TableCell className="text-right tabular-nums text-app-text">
                  {car.specs?.pi ? (
                    <>
                      <span className="text-(--badge-color)" data-pi-class={piClass(car.specs.pi)}>{piClass(car.specs.pi)}&nbsp;</span>
                      {car.specs.pi}
                    </>
                  ) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.hp || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.torque || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{fmtWeight(car.specs?.weightKg ?? 0, car.specs?.weightLbs ?? 0)}</TableCell>
                <TableCell className="text-app-text">{car.specs?.drivetrain || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{fmtSpeed(car.specs?.topSpeedMph ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.zeroToSixty ? `${car.specs.zeroToSixty}s` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.zeroToHundred ? `${car.specs.zeroToHundred}s` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{fmtBrake(car.specs?.braking60 ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.speedRating || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.brakingRating || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.handlingRating || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-app-text">{car.specs?.accelRating || "—"}</TableCell>
                <TableCell className="text-app-text truncate">{car.specs?.division || "—"}</TableCell>
              </TableRow>
              {expanded.has(car.ordinal) && (
                <TableRow>
                  <TableCell colSpan={16}>
                    <CarDetail car={car} fmtSpeed={fmtSpeed} fmtBrake={fmtBrake} fmtWeight={fmtWeight} isMetric={isMetric} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))
        )}
      </TableBody>
    </Table>
  );
}
