export interface TokenDanceCodePackageInfo {
  version: string;
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
  };
}

export const TOKEN_DANCE_CODE_PACKAGE: TokenDanceCodePackageInfo = {
  version: "0.2.0-ts.0",
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
    package: "pnpm pack:check"
  }
} as const;
