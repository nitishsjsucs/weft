// Which policies a hire after the seed gets (research/wave3/expenses-timeoff.md 8.1): vacation for every employee,
// the work state's sick leave, and the NYC banks for a New York worker not placed outside the city.
import { describe, expect, it } from "vitest";
import { policyApplies } from "../../src/time-off/store";

const POLICIES = [["top_vac_us", "US"], ["top_sick_ca", "CA"], ["top_sick_ny", "NY-NYC"], ["top_unpaid_nyc", "NY-NYC"], ["top_prenatal_ny", "NY"], ["top_sick_co", "CO"], ["top_sick_tx", "TX"]] as const;
const assigned = (state: string | null, city: string | null) => POLICIES.filter(([, j]) => policyApplies(j, state, city)).map(([id]) => id);

describe("policyApplies", () => {
  it("matches the seed's assignment for each work state", () => {
    expect(assigned("CA", "Oakland")).toEqual(["top_vac_us", "top_sick_ca"]);
    expect(assigned("NY", "Brooklyn")).toEqual(["top_vac_us", "top_sick_ny", "top_unpaid_nyc", "top_prenatal_ny"]);
    expect(assigned("TX", "Austin")).toEqual(["top_vac_us", "top_sick_tx"]);
    expect(assigned("CO", "Denver")).toEqual(["top_vac_us", "top_sick_co"]);   // a Colorado hire such as Noor
  });
  it("a remote New York worker gets the NYC policies; a New York worker outside the city does not; no work state gets vacation only", () => {
    expect(assigned("NY", null)).toEqual(["top_vac_us", "top_sick_ny", "top_unpaid_nyc", "top_prenatal_ny"]);
    expect(assigned("NY", "Buffalo")).toEqual(["top_vac_us", "top_prenatal_ny"]);   // needs a New York State sick policy (left.md)
    expect(assigned(null, null)).toEqual(["top_vac_us"]);
    expect(assigned("WA", "Seattle")).toEqual(["top_vac_us"]);
  });
});
