// The Claude connector's public links, for the AI window's welcome. Set VITE_CONNECTOR_DIRECTORY_URL once
// the connector is listed in Anthropic's directory: step 1 then becomes a single "Add to Claude" link.
export const CONNECTOR_DIRECTORY_URL = import.meta.env?.VITE_CONNECTOR_DIRECTORY_URL || '';
export const CONNECTOR_MCP_URL = 'https://theprototype.app/mcp';
export const CONNECTOR_DOCS_URL = 'https://docs.theprototype.app/ai/claude-connector/';
