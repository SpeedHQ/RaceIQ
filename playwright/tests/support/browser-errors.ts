import type { Page } from "@playwright/test";

export interface BrowserErrorCollector {
  readonly errors: string[];
}

const DEFAULT_IGNORED_PATTERNS = [/THREE\.GLTFLoader: Couldn't load texture/];

export function collectBrowserErrors(page: Page, ignoredPatterns: readonly RegExp[] = DEFAULT_IGNORED_PATTERNS): BrowserErrorCollector {
  const errors: string[] = [];
  const record = (message: string) => {
    if (!ignoredPatterns.some((pattern) => pattern.test(message))) errors.push(message);
  };
  page.on("pageerror", (error) => record(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") record(`console.error: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) record(`http ${response.status()}: ${response.url()}`);
  });
  return { errors };
}
