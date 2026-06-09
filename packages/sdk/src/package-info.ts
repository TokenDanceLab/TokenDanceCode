export const AGENTHUB_FEATURE_FLAGS = [
  "runner-options",
  "event-envelope",
  "startup-doctor",
  "doctor-readiness",
  "runner-bootstrap",
  "agenthub-consumer-fixture",
  "session-resume",
  "session-lifecycle-metadata",
  "context-preview",
  "remote-approval",
  "tokendanceid-oidc-login",
  "config-writer",
  "config-validation",
  "agenthub-package-feature-flags",
  "agenthub-event-envelope-schema",
  "agenthub-approval-bridge",
  "agenthub-doctor-readiness",
  "agenthub-contract-readiness"
] as const;

export type AgentHubFeatureFlag = typeof AGENTHUB_FEATURE_FLAGS[number];

export interface TokenDanceCodePackageInfo {
  version: string;
  agentHub: {
    sdkContractVersion: "agenthub-sdk.v1";
    agentStreamSchemaVersion: 1;
    features: readonly AgentHubFeatureFlag[];
  };
  packages: {
    core: {
      name: "@tokendance/code-core";
      import: "@tokendance/code-core";
      types: "@tokendance/code-core";
    };
    sdk: {
      name: "@tokendance/code-sdk";
      import: "@tokendance/code-sdk";
      types: "@tokendance/code-sdk";
    };
    cli: {
      name: "@tokendance/code-cli";
      bin: "tokendance";
    };
  };
  verification: {
    test: "pnpm verify";
    package: "pnpm pack:check";
    tarballSmoke: "pnpm pack:smoke";
    prerelease: "pnpm release:next:check";
  };
}

export const AGENTHUB_SDK_CONTRACT_VERSION = "agenthub-sdk.v1" as const;
export const AGENTHUB_AGENT_STREAM_SCHEMA_VERSION = 1 as const;
export const AGENTHUB_AGENT_STREAM_SOURCE = "tokendance-code-sdk" as const;
export const AGENTHUB_APPROVAL_BRIDGE_SCHEMA_VERSION = 1 as const;
export const AGENTHUB_APPROVAL_DECISION_CHANNEL = "agenthub.approval.v1" as const;
export const AGENTHUB_DOCTOR_READINESS_CONTRACT = "agenthub.doctor-readiness.v1" as const;

export function supportsAgentHubFeature(feature: string): feature is AgentHubFeatureFlag {
  return (AGENTHUB_FEATURE_FLAGS as readonly string[]).includes(feature);
}

export const TOKEN_DANCE_CODE_PACKAGE: TokenDanceCodePackageInfo = {
  version: "0.2.0-ts.0",
  agentHub: {
    sdkContractVersion: AGENTHUB_SDK_CONTRACT_VERSION,
    agentStreamSchemaVersion: AGENTHUB_AGENT_STREAM_SCHEMA_VERSION,
    features: AGENTHUB_FEATURE_FLAGS
  },
  packages: {
    core: {
      name: "@tokendance/code-core",
      import: "@tokendance/code-core",
      types: "@tokendance/code-core"
    },
    sdk: {
      name: "@tokendance/code-sdk",
      import: "@tokendance/code-sdk",
      types: "@tokendance/code-sdk"
    },
    cli: {
      name: "@tokendance/code-cli",
      bin: "tokendance"
    }
  },
  verification: {
    test: "pnpm verify",
    package: "pnpm pack:check",
    tarballSmoke: "pnpm pack:smoke",
    prerelease: "pnpm release:next:check"
  }
} as const;
