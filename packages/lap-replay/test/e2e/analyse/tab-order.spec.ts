import { expect, test } from "@playwright/test";
import { compareQuery, getDistinctPair } from "../../../../../playwright/tests/seeded/compare/interaction-helpers";

for (const single of [true, false]) {
  for (const width of [1440, 390]) {
    test(`${single ? "Replay" : "Spectate"} tabs retain drag order and open state at ${width}px`, async ({ page, request }) => {
      await page.setViewportSize({ width, height: 1000 });
      const pair = await getDistinctPair(request, "fm-2023");
      const prefix = single ? "replay" : "spectate";
      await page.goto(single ? `/fm23/sessions/${pair.lapA.sessionId}/replay/${pair.lapA.id}` : `/fm23/compare?${compareQuery(pair)}&view=spectate`);
      const workspace = page.locator("[data-spectate-workspace]");
      await expect(workspace).toBeVisible();
      await expect(workspace.locator("[data-spectate-scene]")).toHaveAttribute("data-scene-ready", "true");
      const dataId = `${prefix}-data-panel`, telemetryId = `${prefix}-telemetry-panel`;
      const tab = (id: string) => page.locator(`[data-panel-toggle="${id}"]`);
      const initialIds = await page.locator("[data-panel-toggle]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-panel-toggle")!));
      for (const id of initialIds) {
        const open = id === dataId || (width > 800 && id === telemetryId);
        if (await tab(id).getAttribute("aria-expanded") !== String(open)) await tab(id).click({ position: { x: 10, y: 10 } });
      }
      const order = () => page.locator("[data-panel-toggle]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-panel-toggle")!));
      const panelOrder = () => workspace.locator("[data-panel-rail] > aside > section").evaluateAll((panels) => panels.map((panel) => panel.id));
      const touch = width < 800 ? await page.context().newCDPSession(page) : null;
      const drag = async (from: string, to: string, cancel = false) => {
        if (touch) await tab(from).evaluate((button) => button.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
        else await tab(from).scrollIntoViewIfNeeded();
        const visiblePoint = (id: string) => tab(id).evaluate((button) => {
          const box = button.getBoundingClientRect();
          for (const fraction of [0.25, 0.5, 0.75]) {
            for (const vertical of [0.25, 0.5, 0.75]) {
              const x = box.x + box.width * fraction, y = box.y + box.height * vertical;
              if (document.elementFromPoint(x, y)?.closest("[data-panel-toggle]") === button) return { x, y };
            }
          }
          throw new Error(`Tab has no unobstructed drag point: ${button.getAttribute("data-panel-toggle")}`);
        });
        const start = await visiblePoint(from), end = await visiblePoint(to);
        if (touch) {
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...end, id: 1 }] });
          await touch.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
        } else {
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(end.x, end.y, { steps: 8 });
          if (cancel) await page.keyboard.press("Escape");
          await page.mouse.up();
        }
      };
      await drag(dataId, telemetryId);
      await expect.poll(async () => { const ids = await order(); return ids.indexOf(dataId) < ids.indexOf(telemetryId); }).toBe(true);
      await expect(tab(dataId)).toHaveAttribute("aria-expanded", "true");
      await expect(tab(telemetryId)).toHaveAttribute("aria-expanded", String(width > 800));
      expect(await panelOrder()).toEqual(width > 800 ? [dataId, telemetryId] : [dataId]);
      const draggedOrder = await order();
      await tab(dataId).press("Alt+ArrowLeft");
      expect(await order()).toEqual(draggedOrder);
      await tab(dataId).press("Alt+ArrowRight");
      await expect.poll(async () => { const ids = await order(); return ids.indexOf(telemetryId) < ids.indexOf(dataId); }).toBe(true);
      await expect(tab(dataId)).toBeFocused();
      await tab(dataId).press("Alt+ArrowLeft");
      expect(await order()).toEqual(draggedOrder);
      await drag(dataId, telemetryId, true);
      expect(await order()).toEqual(draggedOrder);
      await expect(tab(dataId)).toHaveAttribute("aria-expanded", "true");
      if (width > 800) {
        const carId = `${prefix}-${single ? "car" : "2d"}-panel`, insightsId = `${prefix}-insights-panel`;
        await drag(insightsId, carId);
        const ids = await order();
        expect(ids.indexOf(insightsId)).toBeLessThan(ids.indexOf(carId));
        await drag(dataId, carId);
        expect(await order()).toEqual(ids);
      }
      const savedOrder = await order();
      await page.reload();
      await expect(workspace).toBeVisible();
      await expect.poll(order).toEqual(savedOrder);
      expect(await panelOrder()).toEqual(width > 800 ? [dataId, telemetryId] : [dataId]);
      if (width > 800) {
        for (const id of [dataId, telemetryId]) {
          const a = (await page.locator(`[data-panel-header="${id}"]`).boundingBox())!;
          const b = (await page.locator(`#${id}`).boundingBox())!;
          expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
        }
      }
      await touch?.detach();
    });
  }
}
