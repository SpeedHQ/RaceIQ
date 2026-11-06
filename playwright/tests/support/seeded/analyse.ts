import { expect, type Page } from "@playwright/test";

export async function setAnalyseFrame(page: Page, frame: number): Promise<void> {
  await page.evaluate((index) => {
    const seekFrame = (window as typeof window & { __seekReplayFrame?: (value: number) => void }).__seekReplayFrame;
    if (!seekFrame) throw new Error("Analyse frame control is unavailable");
    seekFrame(index);
  }, frame);
  await expect(page.locator('[data-spectate-data-side="a"]')).toHaveAttribute("data-packet-number", String(frame + 1));
}

export async function metricRowText(page: Page, label: string): Promise<string> {
  const labelNode = page.getByText(label, { exact: true }).last();
  await expect(labelNode, `${label} metric label`).toBeVisible();
  return labelNode.locator("..").innerText();
}
