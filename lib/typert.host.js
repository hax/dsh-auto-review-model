/**
 * Host Typert artifact for `@aghost-prj/dsh-auto-review-model`.
 *
 * `@deepseek-ai/dsh-typert-loader` imports this module for every mounted Loader
 * entry whose package exports `./typert`, validates its `TYPERT` manifest, and
 * registers the invocations into `ctx.typert`. The manifest itself is built by
 * the dependency-free {@link createHostManifest} factory in
 * `./typert.contract.js` and is hand-written in generated-artifact shape
 * because this linked package cannot resolve the generator's runtime
 * dependencies (`@deepseek-ai/dsh-typert-protocol`, `zod`).
 *
 * The matching Client-side contribution is exported by
 * `./typert.remote-client.js`; both faces are built from the same contract
 * module, so they cannot drift.
 *
 * @module @aghost-prj/dsh-auto-review-model/typert
 */
import { createHostManifest } from './typert.contract.js';
/** Validated Host manifest for the one `autoReviewModel/testReviewRoute` invocation. */
export const TYPERT = createHostManifest();
export default TYPERT;
