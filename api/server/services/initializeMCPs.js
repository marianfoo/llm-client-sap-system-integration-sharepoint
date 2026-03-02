const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { extractEnvVariable } = require('librechat-data-provider');
const { mergeAppTools, getAppConfig } = require('./Config');
const { createMCPServersRegistry, createMCPManager } = require('~/config');

/**
 * Expand ${ENV_VAR} references in MCP OAuth configuration fields.
 * LibreChat's YAML loader (js-yaml) does not natively perform env var substitution,
 * but `extractEnvVariable` (used by custom endpoints) handles this pattern.
 * We apply it here to OAuth-sensitive fields so that secrets can live in .env
 * rather than being hardcoded in the YAML config file.
 *
 * Added by: SAP + SharePoint Enterprise Template
 */
function expandMcpOAuthEnvVars(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object') {
    return mcpServers;
  }

  const oauthStringFields = [
    'authorization_url',
    'token_url',
    'client_id',
    'client_secret',
    'scope',
    'redirect_uri',
    'revocation_endpoint',
  ];

  for (const [serverName, config] of Object.entries(mcpServers)) {
    if (!config || !config.oauth) {
      continue;
    }

    for (const field of oauthStringFields) {
      if (typeof config.oauth[field] === 'string') {
        const expanded = extractEnvVariable(config.oauth[field]);
        if (expanded !== config.oauth[field]) {
          logger.debug(`[MCP] Expanded env var in ${serverName}.oauth.${field}`);
          config.oauth[field] = expanded;
        }
      }
    }
  }

  return mcpServers;
}

/**
 * Initialize MCP servers
 */
async function initializeMCPs() {
  const appConfig = await getAppConfig();
  const mcpServers = expandMcpOAuthEnvVars(appConfig.mcpConfig);

  try {
    createMCPServersRegistry(mongoose, appConfig?.mcpSettings?.allowedDomains);
  } catch (error) {
    logger.error('[MCP] Failed to initialize MCPServersRegistry:', error);
    throw error;
  }

  try {
    const mcpManager = await createMCPManager(mcpServers || {});

    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const mcpTools = (await mcpManager.getAppToolFunctions()) || {};
      await mergeAppTools(mcpTools);
      const serverCount = Object.keys(mcpServers).length;
      const toolCount = Object.keys(mcpTools).length;
      logger.info(
        `[MCP] Initialized with ${serverCount} configured ${serverCount === 1 ? 'server' : 'servers'} and ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}.`,
      );
    } else {
      logger.debug('[MCP] No servers configured. MCPManager ready for UI-based servers.');
    }
  } catch (error) {
    logger.error('[MCP] Failed to initialize MCPManager:', error);
    throw error;
  }
}

module.exports = initializeMCPs;
