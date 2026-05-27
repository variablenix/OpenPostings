const { normalizeBoolean } = require("./normalize-numbers.js");
function normalizeMigrationSelection(input = {}) {
  /** @type {any} */
  const source = input && typeof input === "object" ? input : {};
  return {
    personal_information:
      source.personal_information === undefined ? true : normalizeBoolean(source.personal_information, true),
    mcp_settings: source.mcp_settings === undefined ? true : normalizeBoolean(source.mcp_settings, true),
    blocked_companies:
      source.blocked_companies === undefined ? true : normalizeBoolean(source.blocked_companies, true),
    applications: source.applications === undefined ? true : normalizeBoolean(source.applications, true)
  };
}

module.exports = { normalizeMigrationSelection };