import type { Page } from "@playwright/test";

/** Open the production timeline and its user-visible disclosure, without changing application state. */
export async function openProjectionSection(page: Page, name: "Projection evidence" | "Projection history") {
  const dialog = page.getByRole("dialog");
  if (!await dialog.isVisible()) await page.getByRole("button", { name: "Open strategy timeline", exact: true }).click();
  const details = dialog.locator("details").filter({ has: page.getByText(name, { exact: true }) });
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
  return details;
}
