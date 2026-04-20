import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
class MCPClient {
    client;
    transport;
    serverURL;
    isConnected = false;
    ready;
    constructor(serverUri) {
        this.serverURL = serverUri || process.env.MCP_SERVER_URL;
        if (!this.serverURL)
            throw new Error("MCP base url undefined");
        this.transport = new StreamableHTTPClientTransport(new URL(this.serverURL));
        this.client = new Client({
            name: "my-client",
            version: "1.0.0",
        });
        // auto connect dès instanciation
        this.ready = this.init();
    }
    // connexion interne
    async init() {
        if (this.isConnected)
            return;
        await this.client.connect(this.transport);
        this.isConnected = true;
        console.log("MCP connecté");
    }
    // garantir que le client est prêt avant usage
    async ensureReady() {
        await this.ready;
    }
    async getTools() {
        await this.ensureReady();
        const result = await this.client.listTools();
        return result.tools.map((tool) => {
            const schema = tool.inputSchema || {};
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description || "",
                    parameters: {
                        type: schema.type || "object",
                        properties: schema.properties || {},
                        required: schema.required || [],
                    },
                },
            };
        });
    }
    async callTool(name, args) {
        await this.ensureReady();
        return await this.client.callTool({
            name,
            arguments: args,
        });
    }
    // BRIDGE LLM → MCP
    async handleToolCalls(message) {
        await this.ensureReady();
        const toolCalls = message?.tool_calls;
        if (!toolCalls?.length)
            return [];
        const results = [];
        for (const toolCall of toolCalls) {
            const name = toolCall.function.name;
            let args = {};
            try {
                args = JSON.parse(toolCall.function.arguments || "{}");
            }
            catch { }
            try {
                const result = await this.callTool(name, args);
                results.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: this.normalizeResult(result),
                });
            }
            catch (err) {
                results.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ error: err.message }),
                });
            }
        }
        return results;
    }
    normalizeResult(result) {
        if (!result)
            return "";
        if (typeof result === "string")
            return result;
        if (result.content?.length) {
            return result.content.map((c) => c.text || "").join("");
        }
        return JSON.stringify(result);
    }
}
export default MCPClient;
