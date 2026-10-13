import { Agent } from "@i-enliven/pi-agent-core";
import { createModels } from "@i-enliven/pi-ai";
import { githubCopilotProvider } from "@i-enliven/pi-ai/providers/github-copilot";

const models = createModels();
models.setProvider(githubCopilotProvider());
const model = models.getModel("github-copilot", "claude-sonnet-5");
if (!model) throw new Error("GitHub Copilot smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
