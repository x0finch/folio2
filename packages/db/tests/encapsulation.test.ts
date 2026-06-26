import { describe, expect, it } from "vitest";
import * as db from "../src";

describe("@folio/db encapsulation", () => {
  it("does not expose the drizzle instance, schema, getDb, or raw tables", () => {
    const surface = db as Record<string, unknown>;
    expect(surface.getDb).toBeUndefined();
    expect(surface.schema).toBeUndefined();
    expect(surface.accounts).toBeUndefined(); // no raw table handle
    expect(surface.drizzle).toBeUndefined();
  });

  it("exposes only wrapped operations", () => {
    expect(typeof db.createAccount).toBe("function");
    expect(typeof db.writeSnapshot).toBe("function");
    expect(typeof db.getLatestSnapshotByUser).toBe("function");
  });
});
