export {
  FailoverAudit,
  type FailoverAuditOptions,
  type FailoverAuditReport,
  type FailoverIncident,
} from './audit.js';
export { ConduitClient, createClient } from './client.js';
export {
  DEFAULT_FAILOVER,
  resolveConfig,
  type ConduitClientConfig,
  type CoverageOverride,
  type FailoverConfig,
  type FailoverStrategy,
  type ResolvedConfig,
  type RouterEvent,
} from './config.js';
export { coveringProviders, assertCoverage, type CoverageQuery } from './coverage.js';
export {
  ManagedSubscription,
  type SubscribeRequest,
  type Subscription,
} from './subscription.js';
