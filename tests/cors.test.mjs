import assert from "node:assert/strict";
import test from "node:test";
import { corsHeaders, isOriginAllowed } from "../supabase/functions/_shared/cors.ts";

const settings = {
  allowedOrigins: "https://mylvl.example.com,http://localhost:5173",
  allowLocalhost: true,
  vercelPreviewProject: "mylvl",
  vercelPreviewTeam: "nikuristic-5844s-projects",
};

test("CORS allows production, configured origins, localhost and only the configured Vercel project/team", () => {
  assert.equal(isOriginAllowed("https://mylvl-chi.vercel.app", settings), true);
  assert.equal(isOriginAllowed("https://mylvl.example.com", settings), true);
  assert.equal(isOriginAllowed("http://localhost:5173", settings), true);
  assert.equal(isOriginAllowed("https://mylvl-git-main-nikuristic-5844s-projects.vercel.app", settings), true);
  assert.equal(isOriginAllowed("https://mylvl-deploy123-nikuristic-5844s-projects.vercel.app", settings), true);
  assert.equal(isOriginAllowed("https://other-git-main-nikuristic-5844s-projects.vercel.app", settings), false);
  assert.equal(isOriginAllowed("https://mylvl-git-main-attacker.vercel.app", settings), false);
  assert.equal(isOriginAllowed("https://mylvl-git-main-nikuristic-5844s-projects.vercel.app:444", settings), false);
  assert.equal(isOriginAllowed("https://mylvl-chi.vercel.app.attacker.invalid", settings), false);
  assert.equal(isOriginAllowed("null", settings), false);
});

test("CORS does not wildcard origins and echoes only an allowed exact origin", () => {
  assert.equal(corsHeaders("https://mylvl.example.com", settings)["Access-Control-Allow-Origin"], "https://mylvl.example.com");
  assert.equal(corsHeaders("https://attacker.invalid", settings)["Access-Control-Allow-Origin"], undefined);
  assert.equal(corsHeaders("https://mylvl.example.com", settings)["Access-Control-Allow-Origin"].includes("*"), false);
});

