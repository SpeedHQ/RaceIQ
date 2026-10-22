import { expect, type Page } from "@playwright/test";

export async function setAnalyseFrame(page: Page, frame: number): Promise<void> {
  await page.evaluate(async (index) => {
    const setFrame = (window as typeof window & { __setFrame?: (value: number) => Promise<void> }).__setFrame;
    if (!setFrame) throw new Error("Analyse frame control is unavailable");
    await setFrame(index);
  }, frame);
}

export async function metricRowText(page: Page, label: string): Promise<string> {
  const iracingPanel = page.locator("[data-iracing-replay-data]");
  if (await iracingPanel.count()) {
    const normalizedLabel = label === "Steer" ? "Steering" : label;
    if (label === "Throttle" || label === "Brake" || label === "Steer") {
      const row = iracingPanel.getByText(normalizedLabel, { exact: true }).locator("..");
      const value = row.locator("span").last();
      await expect(value, `${normalizedLabel} driver input`).toBeVisible();
      return value.innerText();
    }
    const term = iracingPanel.locator("dt").filter({ hasText: new RegExp(`^${label}(?:\\s|$)`) }).last();
    if (await term.count()) {
      await expect(term, `${label} telemetry label`).toBeVisible();
      return term.locator("..").locator("dd").innerText();
    }
    const tableRow = iracingPanel.locator("tr").filter({ hasText: label }).last();
    await expect(tableRow, `${label} telemetry row`).toBeVisible();
    return tableRow.innerText();
  }
  const labelNode = page.getByText(label, { exact: true }).last();
  await expect(labelNode, `${label} metric label`).toBeVisible();
  return labelNode.locator("..").innerText();
}
