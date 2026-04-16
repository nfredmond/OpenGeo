import { describe, expect, it } from "vitest";
import { validateSql } from "@/lib/ai/sql-guard";

describe("validateSql", () => {
  describe("accepts", () => {
    it("plain SELECT with geom", () => {
      expect(
        validateSql("select id, geom from opengeo.features limit 10"),
      ).toEqual({ ok: true });
    });

    it("CTE with geom", () => {
      expect(
        validateSql(
          "with recent as (select * from opengeo.features) select id, geom from recent",
        ),
      ).toEqual({ ok: true });
    });

    it("trailing semicolon", () => {
      expect(
        validateSql("select geom from opengeo.features;"),
      ).toEqual({ ok: true });
    });

    it("multiple trailing semicolons", () => {
      expect(
        validateSql("select geom from opengeo.features;;;"),
      ).toEqual({ ok: true });
    });

    it("case-insensitive keywords", () => {
      expect(
        validateSql("SELECT GEOM FROM opengeo.features"),
      ).toEqual({ ok: true });
    });
  });

  describe("rejects writes", () => {
    it("INSERT", () => {
      const res = validateSql("insert into opengeo.features (geom) values ('x')");
      expect(res.ok).toBe(false);
    });

    it("UPDATE", () => {
      const res = validateSql("update opengeo.features set geom = null");
      expect(res.ok).toBe(false);
    });

    it("DELETE", () => {
      const res = validateSql("delete from opengeo.features where id = '1'");
      expect(res.ok).toBe(false);
    });

    it("DROP", () => {
      const res = validateSql("select geom from t; drop table users");
      expect(res.ok).toBe(false);
    });

    it("real ALTER", () => {
      const res = validateSql("select geom from t; alter table users drop column email");
      expect(res.ok).toBe(false);
    });
  });

  describe("identifier false-positive guard", () => {
    it("does not reject identifiers that contain forbidden keywords (alter_ego column)", () => {
      // Word-boundary regex should let `alter_ego` through — `_` is a word
      // char, so there's no boundary between `alter` and `_ego`.
      expect(
        validateSql("select geom from t where alter_ego = 1"),
      ).toEqual({ ok: true });
    });
  });

  describe("rejects stacked statements and comments", () => {
    it("stacked statement", () => {
      const res = validateSql("select geom from t; select 1");
      expect(res.ok).toBe(false);
    });

    it("inline comment", () => {
      const res = validateSql("select geom from t -- drop table users");
      expect(res.ok).toBe(false);
    });

    it("block comment", () => {
      const res = validateSql("select /* stuff */ geom from t");
      expect(res.ok).toBe(false);
    });
  });

  describe("rejects invalid shapes", () => {
    it("empty string", () => {
      const res = validateSql("");
      expect(res.ok).toBe(false);
    });

    it("non-SELECT starter", () => {
      const res = validateSql("show tables");
      expect(res.ok).toBe(false);
    });

    it("SELECT without geom column", () => {
      const res = validateSql("select id, name from opengeo.features");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/geom/);
    });

    it("CALL procedure", () => {
      const res = validateSql("call risky_procedure(); select geom from t");
      expect(res.ok).toBe(false);
    });

    it("COPY escape", () => {
      const res = validateSql("copy opengeo.features to '/tmp/x'; select geom from t");
      expect(res.ok).toBe(false);
    });
  });
});
