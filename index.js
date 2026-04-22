import OpenAI from "openai";
import express from "express";
import MCPClient from "./mcpClient.js";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  timeout: 10000
});
const mcp = new MCPClient();

app.use(express.json());

app.post('/prompt-stream', async (req, res) => {
  const { messages, uuid } = req.body;

  if(!uuid) res.status(400).end(JSON.stringify({error: "uuid is required"}));

  if(!messages) res.status(400).end(JSON.stringify({error: "messages is required"}));
  
  // On garde une trace de la conversation locale pour pouvoir ajouter les réponses des tools
  let conversation = [
    { role: "system", content: process.env.SYSTEM_PROMPT || "You are an assistant" },
    { role: "system", content: `Voici l'uuid est ne le demande jamais à l'utilisateur: ${uuid}`},
    ...messages
  ];

  let functionName = "";
  let functionArgs = "";
  
  const obj = {
    model: process.env.OPENAI_MODEL || "mcp-test",
    messages: conversation,
    stream: true,
    temperature: +process.env.OPENAI_TEMPERATURE || 0.0,
  };

  const tools = await mcp.getTools();
  if (tools && tools.length > 0) {
    obj.tools = [...tools];
    obj.tool_choice = "auto";
  }

  // --- PREMIÈRE PASSE ---
  let stream = await openai.chat.completions.create(obj);
  
  // Utilisation d'une fonction réutilisable pour traiter le stream
  async function processStream(currentStream) {
    let fullContent = "";
    let toolCallId = ""; // Nécessaire pour lier le résultat de l'outil

    for await (const chunk of currentStream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;

      // Texte classique
      if (delta?.content) {
        fullContent += delta.content;
        res.write(JSON.stringify({ type: "text", content: delta.content }));
      }

      // Accumulation Tool Calls
      if (delta?.tool_calls) {
        const toolCall = delta.tool_calls[0];
        if (toolCall.id) toolCallId = toolCall.id; // Stocker l'ID unique de l'appel
        if (toolCall.function?.name) functionName = toolCall.function.name;
        if (toolCall.function?.arguments) functionArgs += toolCall.function.arguments;
      }

      // --- EXÉCUTION DU TOOL ET SECONDE PASSE ---
      if (choice.finish_reason === "tool_calls") {
        console.log(`Executing MCP tool: ${functionName}`);
        
        try {
          const args = JSON.parse(functionArgs || "{}");
          const result = await mcp.callTool(functionName, {...args, uuid: uuid});
          const toolResultContent = typeof result === 'string' ? result : JSON.stringify(result);

          // 1. Ajouter l'appel de l'IA à l'historique
          conversation.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: toolCallId,
              type: "function",
              function: { name: functionName, arguments: functionArgs }
            }]
          });

          // 2. Ajouter la réponse du TOOL à l'historique (LE POINT CLÉ)
          conversation.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolResultContent
          });

          // 3. Relancer OpenAI avec l'historique complet
          console.log("Re-calling OpenAI with tool result...");
          const secondStream = await openai.chat.completions.create({
            ...obj,
            messages: conversation, // Contient maintenant le résultat de l'outil
            tools: undefined // Optionnel : désactiver tools pour éviter les boucles infinies
          });

          // Réinitialiser les accumulateurs
          functionName = "";
          functionArgs = "";
          
          // Traiter le nouveau stream récursivement
          return processStream(secondStream);

        } catch (toolError) {
          console.error("Tool Error:", toolError);
          res.write(JSON.stringify({ type: 'text', content: "\nError executing tool." }));
        }
      }

      if (choice.finish_reason === "stop") {
        res.end();
      }
    }
  }

  await processStream(stream);
});

const PORT = process.env.PORT || 3003
app.listen(PORT, "0.0.0.0", () => {
  console.log(`server running on port ${PORT}`);
});
