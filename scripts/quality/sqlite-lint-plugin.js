export default {
  rules: {
    "no-bun-sqlite-require": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          restricted: "Use libsql or the application-owned @libsql/client connection instead of bun:sqlite; mixing SQLite drivers can lose WAL writes.",
        },
      },
      create(context) {
        // Oxlint's native no-restricted-imports rule covers ESM, not require().
        return {
          "CallExpression[arguments.0.value='bun:sqlite']"(node) {
            if (
              (node.callee.type === "Identifier" && node.callee.name === "require") ||
              (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.name === "require")
            ) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },
  },
};
