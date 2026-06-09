export interface TokenDanceCodePackageInfo {
  version: string;
  agentHub: {
    sdkContractVersion: "agenthub-sdk.v1";
    agentStreamSchemaVersion: 1;
    features: readonly [
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
      "config-validation"
    ];
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

export const TOKEN_DANCE_CODE_PACKAGE: TokenDanceCodePackageInfo = {
  version: "0.2.0-ts.0",
  agentHub: {
    sdkContractVersion: AGENTHUB_SDK_CONTRACT_VERSION,
    agentStreamSchemaVersion: AGENTHUB_AGENT_STREAM_SCHEMA_VERSION,
    features: [
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
      "config-validation"
    ]
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
