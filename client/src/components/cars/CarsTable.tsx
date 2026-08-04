import { Fragment } from "react";
import { SortableTH, Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
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
    <Table density="compact">
      <THead>
        <TH />
        <SortableTH direction={direction("name")} onSort={() => onSort("name")}>
          Car
        </SortableTH>
        <SortableTH direction={direction("pi")} onSort={() => onSort("pi")}>
          PI
        </SortableTH>
        <SortableTH direction={direction("hp")} onSort={() => onSort("hp")}>
          HP
        </SortableTH>
        <SortableTH direction={direction("torque")} onSort={() => onSort("torque")}>
          Torque
        </SortableTH>
        <SortableTH direction={direction("weightKg")} onSort={() => onSort("weightKg")}>
          {isMetric ? "Wt (kg)" : "Wt (lb)"}
        </SortableTH>
        <TH>{m.cars_drive_label()}</TH>
        <SortableTH direction={direction("topSpeedMph")} onSort={() => onSort("topSpeedMph")}>
          Top Spd ({speedLabel})
        </SortableTH>
        <SortableTH direction={direction("zeroToSixty")} onSort={() => onSort("zeroToSixty")}>
          0–60
        </SortableTH>
        <SortableTH direction={direction("zeroToHundred")} onSort={() => onSort("zeroToHundred")}>
          0–100
        </SortableTH>
        <SortableTH direction={direction("braking60")} onSort={() => onSort("braking60")}>
          {isMetric ? "Brk 60 (m)" : "Brk 60 (ft)"}
        </SortableTH>
        <SortableTH direction={direction("speedRating")} onSort={() => onSort("speedRating")}>
          Spd
        </SortableTH>
        <SortableTH direction={direction("brakingRating")} onSort={() => onSort("brakingRating")}>
          Brk
        </SortableTH>
        <SortableTH direction={direction("handlingRating")} onSort={() => onSort("handlingRating")}>
          Hdl
        </SortableTH>
        <SortableTH direction={direction("accelRating")} onSort={() => onSort("accelRating")}>
          Acc
        </SortableTH>
        <SortableTH direction={direction("division")} onSort={() => onSort("division")}>
          Division
        </SortableTH>
      </THead>
      <TBody>
        {cars.length === 0 ? (
          <TRow variant="separator">
            <TD align="center" colSpan={16} tone="primary">
              <div className="py-10">{m.cars_no_match()}</div>
            </TD>
          </TRow>
        ) : (
          cars.map((car) => (
            <Fragment key={car.ordinal}>
              <TRow onClick={() => onExpand(car.ordinal)} selected={selected.has(car.ordinal)}>
                <TD align="center">
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selected.has(car.ordinal)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => onSelect(car.ordinal)}
                      className="w-3.5 h-3.5 accent-app-accent cursor-pointer"
                    />
                  </div>
                </TD>
                <TD>
                  <span className="text-xs text-app-text/90 truncate">{car.name}</span>
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.pi ? (
                    <>
                      <span className="text-(--badge-color)" data-pi-class={piClass(car.specs.pi)}>
                        {piClass(car.specs.pi)}&nbsp;
                      </span>
                      {car.specs.pi}
                    </>
                  ) : (
                    "—"
                  )}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.hp || "—"}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.torque || "—"}
                </TD>
                <TD numeric tone="primary">
                  {fmtWeight(car.specs?.weightKg ?? 0, car.specs?.weightLbs ?? 0)}
                </TD>
                <TD tone="primary">{car.specs?.drivetrain || "—"}</TD>
                <TD numeric tone="primary">
                  {fmtSpeed(car.specs?.topSpeedMph ?? 0)}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.zeroToSixty ? `${car.specs.zeroToSixty}s` : "—"}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.zeroToHundred ? `${car.specs.zeroToHundred}s` : "—"}
                </TD>
                <TD numeric tone="primary">
                  {fmtBrake(car.specs?.braking60 ?? 0)}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.speedRating || "—"}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.brakingRating || "—"}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.handlingRating || "—"}
                </TD>
                <TD numeric tone="primary">
                  {car.specs?.accelRating || "—"}
                </TD>
                <TD tone="primary" truncate="narrow">
                  {car.specs?.division || "—"}
                </TD>
              </TRow>
              {expanded.has(car.ordinal) && (
                <TRow variant="separator">
                  <TD colSpan={16}>
                    <CarDetail car={car} fmtSpeed={fmtSpeed} fmtBrake={fmtBrake} fmtWeight={fmtWeight} isMetric={isMetric} />
                  </TD>
                </TRow>
              )}
            </Fragment>
          ))
        )}
      </TBody>
    </Table>
  );
}
