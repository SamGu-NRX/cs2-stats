// The dev servers' request parsing (tools/request-param.ts): what reaches the filesystem.
import { expect, it } from "vitest";
import { fileParam, requestUrl } from "../../tools/request-param";

it("decodes a file parameter strictly", () => {
  // fails if a malformed escape or a control character gets through as a file name
  expect(fileParam("?f=dev%2Fnuke%2Fmatch.parquet", "f")).toBe("dev/nuke/match.parquet");
  expect(fileParam("?x=1&f=a+b.json.gz", "f")).toBe("a b.json.gz");
  expect(fileParam("?f=%ZZ", "f")).toBeNull();
  expect(fileParam("?f=%E0%A4%A", "f")).toBeNull();
  expect(fileParam("?f=a%00.json.gz", "f")).toBeNull();
  expect(fileParam("?f=a%0Ab", "f")).toBeNull();
  expect(fileParam("?f=a%7F", "f")).toBeNull();
  expect(fileParam("?g=1", "f")).toBe("");
  expect(fileParam("", "f")).toBe("");
});

it("reads a request URL, and gives null for one that does not parse", () => {
  expect(requestUrl({ url: "/__matches/list" })?.pathname).toBe("/__matches/list");
  expect(requestUrl({ url: "//" })).toBeNull();
});
