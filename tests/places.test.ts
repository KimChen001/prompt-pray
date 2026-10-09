import { describe, expect, it } from "vitest";
import { normalize, searchPlaces } from "@/lib/astro/places";

describe("searchPlaces", () => {
  it("ranks the biggest exact match first", () => {
    const [top] = searchPlaces("boston");
    expect(top).toMatchObject({ name: "Boston", admin1: "Massachusetts", country: "US", tz: "America/New_York" });
  });
  it("understands US state abbreviations and regions", () => {
    expect(searchPlaces("Cambridge, MA")[0]).toMatchObject({ admin1: "Massachusetts", country: "US" });
    expect(searchPlaces("cambridge ma")[0]).toMatchObject({ admin1: "Massachusetts" });
    expect(searchPlaces("Cambridge, England")[0]).toMatchObject({ country: "GB", tz: "Europe/London" });
  });
  it("matches prefixes and accents", () => {
    expect(searchPlaces("san fran")[0].name).toBe("San Francisco");
    expect(searchPlaces("sao paulo")[0].name).toBe("São Paulo");
    expect(normalize("Zürich")).toBe("zurich");
  });
  it("searches Chinese names", () => {
    expect(searchPlaces("北京")[0]).toMatchObject({ country: "CN", tz: "Asia/Shanghai" });
    expect(searchPlaces("波士顿")[0]).toMatchObject({ name: "Boston", country: "US", zh: "波士顿" });
    expect(searchPlaces("boston")[0].zh).toBe("波士顿"); // Simplified preferred over 波士頓
  });
  it("returns nothing for nonsense and caps results", () => {
    expect(searchPlaces("zzzzqqq")).toEqual([]);
    expect(searchPlaces("san").length).toBeLessThanOrEqual(8);
  });
});
