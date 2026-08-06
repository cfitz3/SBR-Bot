/**
 * @sbr/identity — account linking + permission resolution service.
 * Depends only on the shared-types ports; the Prisma-backed repository and the
 * Hypixel social lookup are injected at app-wiring time.
 */
export { IdentityServiceImpl, type IdentityServiceDeps } from "./service.js";
