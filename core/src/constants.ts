// Rule 11: every constant comes from shared/constants.json. This file only
// types it; it adds no values of its own.
import raw from "../../shared/constants.json" with { type: "json" };

export const C = raw;
