import { describe, expect, it } from "vitest";

import { getDealsByStage } from "../deals/stages";
import { mergeConfigurationWithDefaults } from "./ConfigurationContext";
import { defaultConfiguration } from "./defaultConfiguration";

describe("mergeConfigurationWithDefaults", () => {
  it("falls back to default deal stages when persisted configuration has none", () => {
    const config = mergeConfigurationWithDefaults({
      dealStages: [],
    });

    expect(config.dealStages).toEqual(defaultConfiguration.dealStages);
  });

  it("keeps the deals board reducer from crashing with malformed deal stage config", () => {
    const config = mergeConfigurationWithDefaults({
      dealStages: null as any,
    });

    expect(() =>
      getDealsByStage(
        [
          {
            id: 1,
            name: "Broken config deal",
            company_id: 1,
            contact_ids: [],
            category: "api",
            stage: "unknown-stage",
            description: "",
            amount: 1000,
            created_at: "2026-05-16T00:00:00.000Z",
            updated_at: "2026-05-16T00:00:00.000Z",
            expected_closing_date: "2026-05-16",
            sales_id: 1,
            index: 1,
          },
        ],
        config.dealStages,
      ),
    ).not.toThrow();
  });

  it("does not crash when stage grouping is called before valid stages exist", () => {
    expect(() =>
      getDealsByStage(
        [
          {
            id: 1,
            name: "Early render deal",
            company_id: 1,
            contact_ids: [],
            category: "api",
            stage: "lead",
            description: "",
            amount: 1000,
            created_at: "2026-05-16T00:00:00.000Z",
            updated_at: "2026-05-16T00:00:00.000Z",
            expected_closing_date: "2026-05-16",
            sales_id: 1,
            index: 1,
          },
        ],
        [],
      ),
    ).not.toThrow();
  });
});
