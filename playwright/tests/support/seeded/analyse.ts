import { expect, type Page } from "@playwright/test";

export async function setAnalyseFrame(page: Page, frame: number): Promise<void> {
  await page.evaluate((index) => {
    const setFrame = (window as typeof window & { __setFrame?: (value: number) => void }).__setFrame;
    if (!setFrame) throw new Error("Analyse frame control is unavailable");
    setFrame(index);
  }, frame);
  await expect(page.getByRole("slider", { name: "Lap timeline" })).toHaveAttribute("aria-valuenow", String(frame));
}

export async function metricRowText(page: Page, label: string): Promise<string> {
  const labelNode = page.getByText(label, { exact: true }).last();
  await expect(labelNode, `${label} metric label`).toBeVisible();
  return labelNode.locator("..").innerText();
}
