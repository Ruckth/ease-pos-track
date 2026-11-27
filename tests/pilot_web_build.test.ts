import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "vite";

test("the pilot build requires usable Thai and English privacy links", async t => {
  const th = "VITE_PILOT_PRIVACY_NOTICE_TH";
  const en = "VITE_PILOT_PRIVACY_NOTICE_EN";
  const previous = { [th]: process.env[th], [en]: process.env[en] };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const build = () => resolveConfig({ mode: "named-pilot", logLevel: "silent" }, "build");
  process.env[th] = "";
  process.env[en] = "https://privacy.example.test/en";
  await assert.rejects(build, /VITE_PILOT_PRIVACY_NOTICE_TH/);
  process.env[th] = "https://privacy.example.test/th";
  process.env[en] = "http://privacy.example.test/en";
  await assert.rejects(build, /VITE_PILOT_PRIVACY_NOTICE_EN/);
  process.env[en] = "https://privacy.example.test/en";
  assert.equal((await build()).env[th], process.env[th]);
});
