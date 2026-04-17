import { describe, it, expect } from "vitest";
import { route } from "../acc-route.js";

function ok(argv: string[]) {
  const r = route(argv);
  if ("error" in r) throw new Error(`expected route OK but got error: ${r.error}`);
  return r;
}

describe("route — top-level", () => {
  it("defaults to help when no args", () => {
    expect(ok([]).handler).toBe("help");
  });

  it("maps --help / -h / help to help", () => {
    expect(ok(["--help"]).handler).toBe("help");
    expect(ok(["-h"]).handler).toBe("help");
    expect(ok(["help"]).handler).toBe("help");
  });

  it("routes `version` and `--version`", () => {
    expect(ok(["version"]).handler).toBe("version");
    expect(ok(["--version"]).handler).toBe("version");
  });

  it("routes `init` with flags passed through", () => {
    const r = ok(["init", "--data-dir=./acc-data"]);
    expect(r.handler).toBe("init");
    expect(r.args).toEqual(["--data-dir=./acc-data"]);
  });

  it("routes `publish` with positional + flags", () => {
    const r = ok(["publish", "./skill.md", "--url=https://a"]);
    expect(r.handler).toBe("publish");
    expect(r.args).toEqual(["./skill.md", "--url=https://a"]);
  });
});

describe("route — nested shopify", () => {
  it("routes `shopify connect`", () => {
    const r = ok(["shopify", "connect", "--shop=x.myshopify.com"]);
    expect(r.handler).toBe("shopify.connect");
    expect(r.args).toEqual(["--shop=x.myshopify.com"]);
  });

  it("surfaces a placeholder stub for `shopify status`", () => {
    const r = ok(["shopify", "status"]);
    expect(r.handler).toBe("placeholder");
  });

  it("errors on unknown shopify subcommand", () => {
    const r = route(["shopify", "frobnicate"]);
    expect("error" in r).toBe(true);
  });

  it("surfaces help when `shopify` is called without a verb", () => {
    const r = ok(["shopify"]);
    expect(r.handler).toBe("help");
  });
});

describe("route — nested skill", () => {
  it("routes `skill init`, `skill edit`, `skill validate`", () => {
    expect(ok(["skill", "init"]).handler).toBe("skill.init");
    expect(ok(["skill", "edit"]).handler).toBe("skill.edit");
    expect(ok(["skill", "validate"]).handler).toBe("skill.validate");
  });
});

describe("route — nested wallet", () => {
  it("routes show / new / import", () => {
    expect(ok(["wallet", "show"]).handler).toBe("wallet.show");
    expect(ok(["wallet", "new", "--yes"]).handler).toBe("wallet.new");
    expect(ok(["wallet", "import", "--key=0x"]).handler).toBe("wallet.import");
  });
});

describe("route — lifecycle", () => {
  it("routes start / upgrade / doctor to dedicated handlers", () => {
    expect(ok(["start"]).handler).toBe("start");
    expect(ok(["upgrade"]).handler).toBe("upgrade");
    expect(ok(["doctor"]).handler).toBe("doctor");
  });

  it.each(["stop", "status"])(
    "surfaces placeholder for `%s` (Phase 9+)",
    (cmd) => {
      const r = ok([cmd]);
      expect(r.handler).toBe("placeholder");
    },
  );
});

describe("route — errors", () => {
  it("errors on unknown top-level command", () => {
    const r = route(["frobnicate"]);
    expect("error" in r).toBe(true);
  });
});
