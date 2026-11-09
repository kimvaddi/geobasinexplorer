// Prints a run ticket for a local run of the scientists against a local tool server (docs/FOUNDRY_AGENTS.md). In the
// cloud the API issues tickets itself when it admits a question; this script exists so the workflow can be exercised end
// to end on a workstation, with the same key the local server was started with.
//   GBX_RUN_TICKET_KEY=<base64 key> node dist/scripts/v2-dev-ticket.mjs [subject]
import { randomUUID } from "node:crypto";
import { issueRunTicket, ticketKey } from "../src/v2/run-ticket";

const key = ticketKey(process.env.GBX_RUN_TICKET_KEY ?? "");
const subject = process.argv[2] ?? "local";
process.stdout.write(issueRunTicket({ run: randomUUID(), sub: subject, name: "local operator", roles: [], owner: true, conversation: "", booking: "",
  near: null, requiredSourceIds: [] }, key, 15 * 60_000));
