import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  removeRuntimeData,
  requirePlaywrightCli,
  reservePorts,
  run,
} from "./process";

export async function captureResponsive(
  repoRoot: string,
  revisionRoot: string,
  screenshotDir: string,
  nodePath: string,
): Promise<void> {
  rmSync(screenshotDir, { recursive: true, force: true });
  mkdirSync(screenshotDir, { recursive: true });
  const [serverPort, clientPort, udpPort] = await reservePorts(3);
  const dataDir = join(repoRoot, ".ui-diff", "runtime", `test-data-${serverPort}`);
  const playwrightCli = requirePlaywrightCli(repoRoot, "playwright");

  try {
    await run(
      [nodePath, playwrightCli, "test", "--project=mobile-screenshots"],
      {
        cwd: join(repoRoot, "playwright"),
        env: {
          E2E_SERVER_MODE: "dev",
          PW_SCREENSHOT_ONLY: "1",
          PW_SEED_SCREENSHOTS: "1",
          RACEIQ_APP_ROOT: revisionRoot,
          RACEIQ_SCREENSHOT_DIR: screenshotDir,
          PW_FRESH_INSTALL_PORT: String(serverPort),
          PW_FRESH_INSTALL_CLIENT_PORT: String(clientPort),
          PW_FRESH_INSTALL_UDP_PORT: String(udpPort),
          PW_FRESH_INSTALL_DATA_DIR: dataDir,
        },
      },
    );
  } finally {
    await removeRuntimeData(dataDir);
  }
}

export async function captureStorybook(
  repoRoot: string,
  revisionRoot: string,
  screenshotDir: string,
  nodePath: string,
): Promise<void> {
  rmSync(screenshotDir, { recursive: true, force: true });
  mkdirSync(screenshotDir, { recursive: true });
  const [storybookPort] = await reservePorts(1);
  const resultsDir = join(
    repoRoot,
    ".ui-diff",
    "runtime",
    `test-results-${storybookPort}`,
  );
  const playwrightCli = requirePlaywrightCli(repoRoot, "client");
  const hasReusableUiStories = existsSync(
    join(revisionRoot, "client", "src", "stories", "ReusableUi.stories.tsx"),
  );
  const snapshotSpecs = [
    "dashboards.snapshot.ts",
    "theme.snapshot.ts",
    ...(hasReusableUiStories ? ["reusable-ui.snapshot.ts"] : []),
  ];

  try {
    await run(
      [
        nodePath,
        playwrightCli,
        "test",
        ...snapshotSpecs,
        "--update-snapshots",
        "--workers=1",
      ],
      {
        cwd: join(repoRoot, "client"),
        env: {
          RACEIQ_STORYBOOK_PORT: String(storybookPort),
          RACEIQ_STORYBOOK_ROOT: join(revisionRoot, "client"),
          RACEIQ_SNAPSHOT_DIR: screenshotDir,
          RACEIQ_SNAPSHOT_RESULTS_DIR: resultsDir,
          RACEIQ_CAPTURE_REUSABLE_UI: hasReusableUiStories ? "1" : "0",
          RACEIQ_UI_DIFF_CAPTURE: "1",
        },
      },
    );
  } finally {
    await removeRuntimeData(resultsDir);
  }
}
