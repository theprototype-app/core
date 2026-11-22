// The Claude connector's public links, for the AI window's welcome. The connector is listed in Claude's directory;
// VITE_CONNECTOR_DIRECTORY_URL overrides the address.
export const CONNECTOR_DIRECTORY_URL = import.meta.env?.VITE_CONNECTOR_DIRECTORY_URL || 'https://claude.ai/directory/connectors/theprototype';
export const CONNECTOR_MCP_URL = 'https://theprototype.app/mcp';
export const CONNECTOR_DOCS_URL = 'https://docs.theprototype.app/ai/claude-connector/';
