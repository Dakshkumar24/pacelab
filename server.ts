import { Agent, routeAgentRequest } from "agents";

// Phase 1: classes declared so bindings and the v1 migration are valid.
// Phase 2 replaces these with the voice pipeline and the trial store.
export class StandardVoiceAgent extends Agent<Env> {}
export class PatientVoiceAgent extends Agent<Env> {}
export class TrialStore extends Agent<Env> {}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, app: "pacelab" });
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
