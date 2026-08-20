/**
 * The anti-drift guard for the browser's copy of the role-menu limits.
 *
 * Runs under `node --test`, never in a browser, which is why it may import
 * `@sbr/roles` when the module it covers may not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_MENUS as PLATFORM_MAX_MENUS,
  MAX_MENU_BODY as PLATFORM_MAX_MENU_BODY,
  MAX_MENU_OPTIONS as PLATFORM_MAX_MENU_OPTIONS,
  MAX_MENU_TITLE as PLATFORM_MAX_MENU_TITLE,
  MAX_OPTION_DESCRIPTION as PLATFORM_MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL as PLATFORM_MAX_OPTION_LABEL,
  MAX_ROLE_MENU_KEY as PLATFORM_MAX_ROLE_MENU_KEY,
  ROLE_MENU_KEY_SHAPE as PLATFORM_ROLE_MENU_KEY_SHAPE,
} from "@sbr/roles";
import {
  MAX_MENUS,
  MAX_MENU_BODY,
  MAX_MENU_OPTIONS,
  MAX_MENU_TITLE,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_ROLE_MENU_KEY,
  ROLE_MENU_KEY_SHAPE,
} from "./role-menu-limits.js";

test("every limit the editor enforces is the one the validator enforces", () => {
  assert.deepEqual(
    [
      MAX_MENUS,
      MAX_MENU_OPTIONS,
      MAX_MENU_TITLE,
      MAX_MENU_BODY,
      MAX_OPTION_LABEL,
      MAX_OPTION_DESCRIPTION,
      MAX_ROLE_MENU_KEY,
    ],
    [
      PLATFORM_MAX_MENUS,
      PLATFORM_MAX_MENU_OPTIONS,
      PLATFORM_MAX_MENU_TITLE,
      PLATFORM_MAX_MENU_BODY,
      PLATFORM_MAX_OPTION_LABEL,
      PLATFORM_MAX_OPTION_DESCRIPTION,
      PLATFORM_MAX_ROLE_MENU_KEY,
    ],
  );
});

test("the key shape the editor accepts is the one the validator accepts", () => {
  assert.equal(ROLE_MENU_KEY_SHAPE.source, PLATFORM_ROLE_MENU_KEY_SHAPE.source);
  // Spelled out as well as compared, so a change to both copies at once still
  // has to face the question of whether a colon may travel in a custom id.
  assert.equal(ROLE_MENU_KEY_SHAPE.test("colours"), true);
  assert.equal(ROLE_MENU_KEY_SHAPE.test("a:b"), false);
});
