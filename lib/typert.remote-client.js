/**
 * Host-for-Client Typert artifact for `@aghost-prj/dsh-auto-review-model`.
 *
 * The browser bundle mounts this contribution through `ctx.remote.$mount()`; it
 * is also the value external Client assemblies may import. Its strict
 * descriptors come from the same dependency-free
 * {@link createRemoteContribution} factory as the Host manifest in
 * `./typert.host.js`, so the wire contract is defined once.
 *
 * @module @aghost-prj/dsh-auto-review-model/remote
 */
import { createRemoteContribution } from './typert.contract.js';
/** Mountable contribution for the one `autoReviewModel/testReviewRoute` invocation. */
export const TYPERT_REMOTE = createRemoteContribution();
export default TYPERT_REMOTE;
