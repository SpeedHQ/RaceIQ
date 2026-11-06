import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { SessionsPageProvider, SessionResultMeta } from "@raceiq/sessions-page/ui";
import { host } from "@raceiq/sessions-page/test-support/host";

function render(sessionType: string) {
  const session: SessionMeta = { id: 1, carId: "car", trackId: "track", createdAt: "", gameId: "lmu", sessionType, finishingPosition: 1, processing: { state: "ready", stage: null, error: null } };
  return renderToStaticMarkup(
    <SessionsPageProvider host={{ ...host, Badge: ({ children }) => <span>{children}</span> }}>
      <SessionResultMeta session={session} />
    </SessionsPageProvider>,
  );
}

test("never labels LMU practice or test day as a race result position", () => {
  for (const sessionType of ["practice-1", "test-day"]) expect(render(sessionType)).not.toMatch(/P\d/);
  expect(render("race")).toMatch(/P<!-- -->1|P1/);
});
