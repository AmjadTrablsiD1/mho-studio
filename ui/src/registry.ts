// The control table of the instrument on the line: the RIGOL one, or the
// LeCroy one once *IDN? said so. Components ask here instead of importing a
// fixed table, so the same panels serve both families.

import { registryFor, type Registry } from "../../core/src/registry/families.ts";
import { getLive, useLive } from "./api.ts";

/** For event handlers and other code outside render. */
export function reg(): Registry {
  return registryFor(getLive().link?.family);
}

/** For components: re-renders when the family changes. */
export function useReg(): Registry {
  return registryFor(useLive((s) => s.link?.family));
}
