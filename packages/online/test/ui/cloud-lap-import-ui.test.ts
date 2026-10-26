import { describe, expect, it } from "bun:test";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";
import { communityActivationMatches } from "../../ui/hooks/cloud-lap-import";

const state = (lapId: string, activationId: number, accountEpoch: string): Pick<CloudLapImportState, "lapId" | "activationId" | "access"> => ({
  lapId, activationId, access: { accountEpoch, expectedRevision: 3 },
});

describe("Community import activation ownership", () => {
  it("matches exact activation and account, never lap ID alone", () => {
    const intent = { lapId: "same-lap", lapGuid: "guid", activationId: 41, accountEpoch: "account-a" };
    expect(communityActivationMatches(intent, state("same-lap", 41, "account-a"))).toBe(true);
    expect(communityActivationMatches(intent, state("same-lap", 42, "account-a"))).toBe(false);
    expect(communityActivationMatches(intent, state("same-lap", 41, "account-b"))).toBe(false);
    expect(communityActivationMatches({ ...intent, activationId: null }, state("same-lap", 41, "account-a"))).toBe(false);
  });
});
